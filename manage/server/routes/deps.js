/**
 * 依赖库路由。
 *
 * 挂在同一个 Express app 上，和插件库共用一套登录（Bearer token）。
 * 前缀沿用方案里的 /server/** 与 /client/**，将来接上网关不用改路径。
 *
 * 上传有两条通道：
 *   POST /server/deps/{code}/versions                  单请求直传（小文件）
 *   POST /server/deps/{code}/uploads + 分片 + complete  分片上传（MinIO 后端）
 * 两者最终都汇到 DepStore.commitVersion，版本不可变的判定只有一处。
 */
import { HttpError } from '../lib/http-error.js'
import { DepStore } from '../lib/dep/store.js'
import { UploadManager } from '../lib/dep/uploads.js'
import {
  CATEGORIES,
  OS_LIST,
  ARCH_LIST,
  ASSET_STATES,
} from '../lib/dep/manifest.js'

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

const decode = (raw) => {
  try {
    return decodeURIComponent(String(raw || '').trim())
  } catch {
    return String(raw || '').trim()
  }
}

function contentDisposition(name) {
  const fallback = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, "'")
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function mountDepRoutes(app, { config, driver, requireAdmin, audit }) {
  const store = new DepStore({
    driver,
    maxFileBytes: config.depMaxFileBytes,
    defaultActor: config.adminName,
    // 与插件库共用一份 audit.json，管理端「审计」页一次看完两类操作
    audit,
  })

  const uploads = new UploadManager({
    driver,
    cfg: {
      partSize: config.depPartSize,
      maxParts: config.depMaxParts,
      ttlHours: config.depUploadTtlHours,
      maxFileBytes: config.depMaxFileBytes,
      verifyMode: config.depVerifyMode,
    },
    commit: (payload) => store.commitVersion(payload),
  })

  /**
   * 索引预热交给 app.init()：那里先确保桶存在再读清单。
   * 不在这里预热，否则桶还没建好就先报一条「读取清单失败」，
   * 与随后的「已自动创建桶」自相矛盾，排查时很误导。
   * 首次请求仍会惰性加载，只是少了启动期的那一次。
   */

  /* ============================== 管理端 ============================== */

  // meta / stats 必须排在 :code 之前，否则会被当成资产标识
  app.get('/server/deps/meta', requireAdmin, (req, res) => {
    res.json({
      categories: CATEGORIES,
      os: OS_LIST,
      arch: ARCH_LIST,
      assetStates: ASSET_STATES,
      maxFileBytes: config.depMaxFileBytes,
      storageDriver: driver.name,
      chunkedThresholdBytes: config.depChunkedThreshold,
      partSize: config.depPartSize,
      maxParts: config.depMaxParts,
      uploadTtlHours: config.depUploadTtlHours,
      verifyMode: config.depVerifyMode,
      store: { bucket: config.minio.bucket },
    })
  })

  app.get(
    '/server/deps/stats',
    requireAdmin,
    wrap(async (req, res) => {
      res.json(await store.overview())
    }),
  )

  app.get(
    '/server/deps',
    requireAdmin,
    wrap(async (req, res) => {
      const q = String(req.query.q || '').trim().toLowerCase()
      const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : null
      const category =
        req.query.category && req.query.category !== 'all' ? String(req.query.category) : null

      let items = await store.list()
      const facets = {
        all: items.length,
        enabled: items.filter((m) => m.status === 'enabled').length,
        unreleased: items.filter((m) => m.status === 'unreleased').length,
        taken_down: items.filter((m) => m.status === 'taken_down').length,
      }
      if (status) items = items.filter((m) => m.status === status)
      if (category) items = items.filter((m) => m.category === category)
      if (q) {
        items = items.filter((m) =>
          [m.code, m.displayName, m.description, m.maintainer, ...(m.tags || [])]
            .join(' ')
            .toLowerCase()
            .includes(q),
        )
      }
      res.json({ items, facets })
    }),
  )

  app.post(
    '/server/deps',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.createAsset(req.body || {}, req.admin.n)
      res.status(201).json({ ok: true, asset })
    }),
  )

  app.get(
    '/server/deps/:code',
    requireAdmin,
    wrap(async (req, res) => {
      res.json({ asset: await store.detail(decode(req.params.code)) })
    }),
  )

  app.put(
    '/server/deps/:code',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.updateAsset(decode(req.params.code), req.body || {}, req.admin.n)
      res.json({ ok: true, asset })
    }),
  )

  /**
   * 上传制品：二进制裸流，元数据走查询串。
   * 刻意不挂 express.raw()：几百 MB 的 exe 会被整个读进内存。
   */
  app.post(
    '/server/deps/:code/versions',
    requireAdmin,
    wrap(async (req, res) => {
      const code = decode(req.params.code)
      const version = String(req.query.version || '').trim()
      const fileName = req.query.file_name ? decode(req.query.file_name) : ''
      const changelog = req.query.changelog ? decode(req.query.changelog) : ''
      const expected = req.headers['x-expected-sha256']
      const declaredSize = Number(req.headers['content-length']) || 0

      try {
        if (!version) throw new HttpError(422, '缺少版本号')
        if (!fileName) throw new HttpError(422, '缺少文件名')

        const result = await store.addVersion(code, {
          version,
          fileName,
          stream: req,
          declaredSize,
          expectedSha256: expected ? String(expected) : '',
          changelog,
          actor: req.admin.n,
        })
        res.status(201).json({ ok: true, ...result })
      } catch (err) {
        /**
         * 上传失败时请求体通常还没读完（存储层在中途就抛了）。
         * 试过 req.resume() 排空：浏览器会继续把剩余字节推给一个已经失败的请求，
         * 表现为进度条停在某个百分比不动、按钮一直「上传中」，既不出错也不能结束。
         * 正确做法是响应发出后立刻断开连接，让 XHR 当场拿到结果。
         */
        res.setHeader('Connection', 'close')
        res.on('finish', () => req.destroy())
        throw err
      }
    }),
  )

  /* ------------------------------ 分片上传 ------------------------------ */

  /**
   * 创建会话。版本是否已占用在这里先判一次（早失败），
   * 真正的判定在 complete 的 commitVersion 里持锁复查。
   */
  app.post(
    '/server/deps/:code/uploads',
    requireAdmin,
    wrap(async (req, res) => {
      const code = decode(req.params.code)
      const { version, fileName, size, sha256, changelog, partSize } = req.body || {}
      if (!version) throw new HttpError(422, '缺少版本号', { code: 'INVALID_VERSION' })

      const { manifest, version: ver } = await store.reserveVersion(code, version)
      const session = await uploads.create({
        code: manifest.code,
        version: ver,
        fileName,
        size,
        sha256,
        changelog,
        partSize,
        actor: req.admin.n,
      })
      res.status(201).json(session)
    }),
  )

  /** 进行中的会话（管理端「上传中」列表；同时承担惰性过期清理） */
  app.get(
    '/server/deps/:code/uploads',
    requireAdmin,
    wrap(async (req, res) => {
      const result = await uploads.list({
        code: decode(req.params.code),
        state: String(req.query.state || 'active'),
      })
      res.json(result)
    }),
  )

  /** 查会话 + 已上传分片：断点续传的唯一入口 */
  app.get(
    '/server/deps/:code/uploads/:uploadId',
    requireAdmin,
    wrap(async (req, res) => {
      const session = await uploads.get({
        code: decode(req.params.code),
        uploadId: decode(req.params.uploadId),
      })
      res.json(session)
    }),
  )

  /**
   * 上传一片。
   *
   * 三条硬约束：
   *   1. 不能挂 express.json()/raw()（全局只挂了 json，且只处理 application/json）
   *   2. 必须带 Content-Length —— S3 的 UploadPart 收 chunked body 会挂住
   *   3. 失败要断开连接，否则浏览器会继续把剩余字节推给一个已经失败的请求
   */
  app.put(
    '/server/deps/:code/uploads/:uploadId/parts/:partNumber',
    requireAdmin,
    wrap(async (req, res) => {
      try {
        const result = await uploads.putPart({
          code: decode(req.params.code),
          uploadId: decode(req.params.uploadId),
          partNumber: Number(req.params.partNumber),
          size: Number(req.headers['content-length']) || 0,
          chunkSha256: req.headers['x-chunk-sha256'] || '',
          stream: req,
        })
        res.json(result)
      } catch (err) {
        res.setHeader('Connection', 'close')
        res.on('finish', () => req.destroy())
        throw err
      }
    }),
  )

  /** 完成并登记版本。重复调用幂等，返回同一结果。 */
  app.post(
    '/server/deps/:code/uploads/:uploadId/complete',
    requireAdmin,
    wrap(async (req, res) => {
      const outcome = await uploads.complete({
        code: decode(req.params.code),
        uploadId: decode(req.params.uploadId),
        actor: req.admin.n,
      })
      res.status(201).json({ ok: true, ...outcome })
    }),
  )

  /** 放弃会话：Abort 掉 S3 分片，不留半成品 */
  app.delete(
    '/server/deps/:code/uploads/:uploadId',
    requireAdmin,
    wrap(async (req, res) => {
      const result = await uploads.abort({
        code: decode(req.params.code),
        uploadId: decode(req.params.uploadId),
      })
      res.json(result)
    }),
  )

  app.post(
    '/server/deps/:code/versions/:version/enable',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.enableVersion(
        decode(req.params.code),
        decode(req.params.version),
        req.admin.n,
      )
      res.json({ ok: true, asset })
    }),
  )

  app.post(
    '/server/deps/:code/versions/:version/disable',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.disableVersion(
        decode(req.params.code),
        decode(req.params.version),
        req.admin.n,
      )
      res.json({ ok: true, asset })
    }),
  )

  app.delete(
    '/server/deps/:code/versions/:version',
    requireAdmin,
    wrap(async (req, res) => {
      const result = await store.removeVersion(
        decode(req.params.code),
        decode(req.params.version),
        req.admin.n,
      )
      res.json({ ok: true, ...result })
    }),
  )

  app.delete(
    '/server/deps/:code',
    requireAdmin,
    wrap(async (req, res) => {
      const result = await store.removeAsset(decode(req.params.code), req.admin.n)
      res.json({ ok: true, ...result })
    }),
  )

  app.post(
    '/server/deps/:code/enable',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.enableAsset(decode(req.params.code), req.admin.n)
      res.json({ ok: true, asset })
    }),
  )

  app.post(
    '/server/deps/:code/disable',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.disableAsset(decode(req.params.code), req.admin.n)
      res.json({ ok: true, asset })
    }),
  )

  app.post(
    '/server/deps/:code/take-down',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.takeDown(decode(req.params.code), req.admin.n)
      res.json({ ok: true, asset })
    }),
  )

  app.post(
    '/server/deps/:code/restore',
    requireAdmin,
    wrap(async (req, res) => {
      const asset = await store.restore(decode(req.params.code), req.admin.n)
      res.json({ ok: true, asset })
    }),
  )

  /* ============================== 客户端 ============================== */

  app.get(
    '/client/deps/catalog',
    wrap(async (req, res) => {
      const items = await store.catalog(req.query)
      res.json({ items, total: items.length })
    }),
  )

  app.get(
    '/client/deps/:code/versions',
    wrap(async (req, res) => {
      const asset = await store.detail(decode(req.params.code))
      if (asset.status !== 'enabled') throw new HttpError(403, '资产还未启用或已下架')
      res.json({
        items: asset.versions
          .filter((v) => v.state === 'enabled')
          .map((v) => ({
            version: v.version,
            size: v.size,
            publishedAt: v.publishedAt,
            fileName: v.fileName,
            sha256: v.sha256,
            download: `/client/deps/${asset.code}/versions/${v.version}/download`,
          })),
      })
    }),
  )

  app.get(
    '/client/deps/:code/versions/:version/download',
    wrap(async (req, res) => {
      const { file } = await store.prepareDownload(
        decode(req.params.code),
        decode(req.params.version),
      )
      const upstream = await driver.fetchArtifact(file.path, { range: req.headers.range })

      res.status(upstream.status)
      for (const [key, value] of Object.entries(upstream.headers)) {
        res.setHeader(key, value)
      }
      res.setHeader('Content-Disposition', contentDisposition(file.name))
      res.setHeader('X-Checksum-Sha256', file.sha256)
      res.setHeader('Cache-Control', 'no-store')

      upstream.body.on('error', () => res.destroy())
      res.on('close', () => upstream.body.destroy())
      upstream.body.pipe(res)
    }),
  )

  app.get(
    '/client/deps/:code',
    wrap(async (req, res) => {
      const asset = await store.detail(decode(req.params.code))
      if (asset.status !== 'enabled') throw new HttpError(403, '资产还未启用或已下架')
      res.json({
        asset: {
          code: asset.code,
          displayName: asset.displayName,
          description: asset.description,
          category: asset.category,
          os: asset.os,
          arch: asset.arch,
          currentVersion: asset.currentVersion,
          updatedAt: asset.updatedAt,
          size: asset.size,
          versions: asset.versions
            .filter((v) => v.state === 'enabled')
            .map((v) => ({
              version: v.version,
              publishedAt: v.publishedAt,
              changelog: v.changelog,
              size: v.size,
              fileName: v.fileName,
              sha256: v.sha256,
            })),
        },
      })
    }),
  )

  return { store, driver }
}
