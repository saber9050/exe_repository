/**
 * 依赖库管理端 · express 应用
 *
 * 从 dsh 插件市场里分离出来的独立服务：只保留依赖库这一块，插件库的路由、
 * 仓储、包上传全部不在这个进程里。
 *
 * 制品、清单、审计都落在 MinIO 对象存储（S3 协议），本地不落任何状态。
 *
 * 分层：
 *   /server/auth/**   管理端登录（平台账号，与对象存储的 key 无关）
 *   /server/audit     审计（依赖库的写操作，落 meta/audit.json）
 *   /server/deps/**   管理端：登记、分片上传、启停、删除
 *   /client/deps/**   客户端只读：目录、版本、下载
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

import { config } from './lib/config.js'
import { createObjectStore } from './lib/storage/s3.js'
import { createDepDriver } from './lib/dep/storage.js'
import { AuditLog } from './lib/audit.js'
import { HttpError } from './lib/http-error.js'
import { login, requireAdmin } from './lib/auth.js'
import { mountDepRoutes } from './routes/deps.js'

/** 统一的异步路由包装：错误交给末尾的错误处理 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/**
 * index.html 的读取缓存，按文件 mtime 失效。
 *
 * 只读一次的话，重新构建后进程仍会吐出老的 html，浏览器继续加载已被替换的
 * 旧 JS，表现是「改了代码界面没变」且不报错。
 */
function createIndexRenderer(indexHtmlPath) {
  let cached = ''
  let cachedAt = -1

  return () => {
    let stamp = -1
    try {
      stamp = fs.statSync(indexHtmlPath).mtimeMs
    } catch {
      stamp = -1
    }
    if (cached && stamp === cachedAt) return cached
    cached = fs.readFileSync(indexHtmlPath, 'utf8')
    cachedAt = stamp
    return cached
  }
}

/**
 * 构造依赖库管理端应用。
 * @param {{ log?: (msg: string, err?: unknown) => void }} options
 * @returns app、路由依赖、以及启动后手动触发的初始化函数。
 */
export function createManageApp(options = {}) {
  const log = options.log || ((msg, err) => console.log(msg, err || ''))

  const objectStore = createObjectStore(config.minio)
  const driver = createDepDriver({ store: objectStore })
  // 审计只有这一份：所有写操作都往同一个 audit.json 追加，由它串行化。
  // 存储后端通过 driver.meta 注入，切 MinIO 时这一层不动。
  const audit = new AuditLog({ meta: driver.meta, limit: config.auditLimit, ttlMs: config.cacheTtlMs })
  const app = express()

  app.disable('x-powered-by')
  // 接口一律不缓存：fetch 会把 304 当成失败，接口带 ETag 只会制造假报错
  app.set('etag', false)
  app.use(['/client', '/server'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  /**
   * 客户端只读接口允许跨域：下载页可能被嵌到别处，或从前端 dev server 直接调。
   * 这些接口只读；管理端 /server/** 不放开，仍只在同源下使用。
   */
  app.use('/client', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Accept, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition, X-Checksum-Sha256, X-Plugin-Version',
    )
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  app.use(express.json({ limit: '2mb' }))

  /* ============================== 管理端：登录 ============================== */

  app.post(
    '/server/auth/login',
    wrap(async (req, res) => {
      const { username, password } = req.body || {}
      const session = login(username, password)
      if (!session) {
        res.status(401).json({ message: '账号或密码不正确' })
        return
      }
      res.json(session)
    }),
  )

  app.get('/server/me', requireAdmin, (req, res) => {
    res.json({ user: { username: req.admin.u, name: req.admin.n, role: req.admin.r } })
  })

  /* ============================== 管理端：审计 ============================== */

  app.get(
    '/server/audit',
    requireAdmin,
    wrap(async (req, res) => {
      res.json({ items: await audit.list(80) })
    }),
  )

  /* ============================== 依赖库 ============================== */
  /**
   * 管理端 /server/deps/**、客户端 /client/deps/** 都在这个路由模块里注册。
   */
  const dep = mountDepRoutes(app, { config, driver, requireAdmin, audit })

  /* ============================== 静态站点 ============================== */

  const indexHtml = path.join(config.distDir, 'index.html')
  if (fs.existsSync(indexHtml)) {
    const renderIndex = createIndexRenderer(indexHtml)
    app.use(
      express.static(config.distDir, {
        index: false,
        setHeaders(res, filePath) {
          if (/[\\/]assets[\\/]/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000')
          }
        },
      }),
    )
    app.get(/^\/(?!client\/|server\/).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.type('html').send(renderIndex())
    })
  }

  app.use((req, res) => {
    res.status(404).json({ message: `没有这个接口：${req.method} ${req.path}` })
  })

  /* ============================== 错误处理 ============================== */

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ message: '上传体积超过上限' })
      return
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message, ...err.extra })
      return
    }
    log('[manage] 未捕获异常', err)
    res.status(500).json({ message: '服务异常，请稍后重试' })
  })

  /**
   * 存储准备与索引预热。
   * 放后台跑：存储慢或不可达时管理界面照样能打开，接口自己会返回 502。
   */
  async function init() {
    let storageReady = false

    try {
      const result = await objectStore.ensureBucket({
        autoCreate: config.minio.autoCreateBucket,
      })
      const where = `${config.minio.endpoint}:${config.minio.port}/${config.minio.bucket}`
      if (result.created) {
        log(`[manage] 桶 ${config.minio.bucket} 不存在，已自动创建（默认私有）`)
      }
      log(`[manage] 对象存储可用 ${where}`)
      storageReady = true

      if (result.publicRead) {
        log(
          `[manage] 警告：桶 ${config.minio.bucket} 的策略允许匿名读，` +
            '任何人拿到对象 key 都能绕过接口直接下载。建议删掉这条 bucket policy。',
        )
      }
    } catch (err) {
      if (err?.name === 'BucketNotFound') {
        log(
          `[manage] 桶 ${config.minio.bucket} 不存在，且 MINIO_AUTO_CREATE_BUCKET=false。` +
            '请先手工建桶（mc mb），或把该开关打开后重启。',
        )
      } else {
        log('[manage] 对象存储初始化失败（服务仍会启动，接口可能返回 502）', err.message)
      }
    }

    // 桶都不可用时不用再读清单，否则会紧跟着报一条同样根因的错误，掩盖上面的提示
    if (!storageReady) return

    try {
      await dep.store.ensureIndex({ force: true })
      const assets = await dep.store.list()
      log(`[manage] 存储连接正常（${driver.name}），已加载 ${assets.length} 个依赖资产`)
    } catch (err) {
      log('[manage] 无法读取依赖库清单', err.message)
    }
  }

  return {
    app,
    audit,
    dep,
    driver,
    objectStore,
    init,
  }
}
