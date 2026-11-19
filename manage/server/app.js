/**
 * 依赖库管理端 · express 应用
 *
 * 从 dsh 插件市场里分离出来的独立服务：只保留依赖库这一块，插件库的路由、
 * 仓储、包上传全部不在这个进程里。制品仍然落在 Gitea generic registry，
 * 本地只保存下载计数。
 *
 * 分层：
 *   /server/auth/**   管理端登录（平台账号，不是 Gitea 账号）
 *   /server/audit     审计（依赖库的写操作，落 audit.json）
 *   /server/deps/**   管理端：登记、上传、启停、删除
 *   /client/deps/**   客户端只读：目录、版本、下载
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

import { config } from './lib/config.js'
import { createGitea, GiteaError } from './lib/gitea.js'
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

  const gitea = createGitea()
  // 审计只有这一份：所有写操作都往同一个 audit.json 追加，由它串行化
  const audit = new AuditLog({ gitea, limit: config.auditLimit, ttlMs: config.cacheTtlMs })
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
  const dep = mountDepRoutes(app, { config, gitea, requireAdmin, audit })

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
    if (err instanceof GiteaError) {
      const status = err.status === 404 ? 404 : 502
      const message =
        err.status === 401 || err.status === 403
          ? '制品库鉴权失败，请检查服务端 GITEA_TOKEN'
          : err.status === 0
            ? err.message
            : `制品库异常：${err.message}`
      res.status(status).json({ message })
      return
    }
    log('[manage] 未捕获异常', err)
    res.status(500).json({ message: '服务异常，请稍后重试' })
  })

  /**
   * 仓库准备与索引预热。
   * 放后台跑：Gitea 慢或不可达时管理界面照样能打开，接口自己会返回 502。
   */
  async function init() {
    if (config.autoCreateRepo) {
      try {
        const result = await gitea.ensureRepo({ private: config.repoPrivate })
        const action = result.created ? '已自动创建' : '已存在'
        const branch = result.branchReady ? '' : `，但分支 ${config.branch} 不可用`
        log(`[manage] 仓库 ${config.owner}/${config.repo} ${action}${branch}`)
      } catch (err) {
        log('[manage] 仓库检查失败（服务仍会启动，接口可能返回 502）', err.message)
      }
    }

    try {
      await dep.store.ensureIndex({ force: true })
      const assets = await dep.store.list()
      log(`[manage] 仓库连接正常，已加载 ${assets.length} 个依赖资产`)
    } catch (err) {
      log('[manage] 无法读取依赖库清单', err.message)
    }
  }

  return {
    app,
    audit,
    dep,
    gitea,
    init,
  }
}
