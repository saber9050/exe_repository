/**
 * 依赖资产仓储。
 *
 * 不用关系库的代价都集中在这一层：
 *   1. 写串行化 —— 同进程内 withLock()，防两个请求同时改同一个 manifest
 *   2. 两段写 —— 先写字节再写 manifest，manifest 失败要回滚字节
 *   3. 索引在内存 —— 冷启动从存储列出全部 manifest，之后按 TTL 刷新
 */
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from '../http-error.js'
import {
  assertCode,
  assertVersion,
  assertCategory,
  assertOs,
  assertArch,
  compareVersionsDesc,
  createManifest,
  nowIso,
  sortVersions,
  summarize,
  toStorageFileName,
  versionSize,
} from './manifest.js'

export class DepStore {
  constructor({ driver, maxFileBytes, defaultActor, audit }) {
    this.driver = driver
    this.maxFileBytes = maxFileBytes
    this.defaultActor = defaultActor || '平台管理员'
    // 与插件库共用同一个 AuditLog 实例（同一份 audit.json、同一条写队列）
    this.audit = audit || null
    this.index = new Map()
    this.loadedAt = 0
    this.loaded = false
    this.loading = null
    this.queue = Promise.resolve()
    this.ttlMs = 3000
  }

  /**
   * 记一条依赖库审计。
   *
   * 只在写操作真正落盘之后调用 —— 提前返回的幂等分支（状态已经是目标值）
   * 和抛错的分支都不留痕，否则审计里会混进一堆「什么都没发生」的行。
   * 没注入审计对象时静默跳过，脚本或单测里 new 出来也能跑。
   */
  record(entry) {
    if (!this.audit) return Promise.resolve(null)
    return this.audit.append({
      scope: 'dep',
      actor: entry.actor || this.defaultActor,
      ...entry,
    })
  }

  /**
   * 写操作串行化。超时是兜底：万一底层流出现意料外的挂起，
   * 也不能让队列永久阻塞（那会让之后所有上传都卡住）。
   */
  withLock(fn, timeoutMs = 30 * 60 * 1000) {
    const run = this.queue.then(() => withTimeout(fn(), timeoutMs))
    this.queue = run.catch(() => {})
    return run
  }

  async ensureIndex({ force = false } = {}) {
    const fresh = this.loaded && !force && Date.now() - this.loadedAt < this.ttlMs
    if (fresh) return
    if (this.loading) return this.loading

    this.loading = (async () => {
      const list = await this.driver.listManifests()
      const next = new Map()
      for (const manifest of list) {
        if (manifest?.code) next.set(manifest.code, manifest)
      }
      this.index = next
      this.loaded = true
      this.loadedAt = Date.now()
    })()

    try {
      await this.loading
    } finally {
      this.loading = null
    }
  }

  async getManifest(code, { force = false } = {}) {
    await this.ensureIndex({ force })
    return this.index.get(code) || null
  }

  async list() {
    await this.ensureIndex()
    return [...this.index.values()]
      .map((m) => summarize(m))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  }

  async overview() {
    await this.ensureIndex()
    const manifests = [...this.index.values()]
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000

    return {
      total: manifests.length,
      enabled: manifests.filter((m) => m.status === 'enabled').length,
      takenDown: manifests.filter((m) => m.status === 'taken_down').length,
      unreleased: manifests.filter((m) => m.status === 'unreleased').length,
      versions: manifests.reduce((n, m) => n + (m.versions || []).length, 0),
      pendingVersions: manifests.reduce(
        (n, m) => n + (m.versions || []).filter((v) => v.state === 'unreleased').length,
        0,
      ),
      storageBytes: manifests.reduce(
        (n, m) => n + (m.versions || []).reduce((s, v) => s + versionSize(v), 0),
        0,
      ),
      weekUpdated: manifests.filter((m) => new Date(m.updatedAt).getTime() > weekAgo).length,
      storageDriver: this.driver.name,
      recentUpdates: [...manifests]
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, 6)
        .map((m) => {
          const s = summarize(m)
          return {
            code: m.code,
            displayName: m.displayName,
            status: m.status,
            currentVersion: m.currentVersion,
            versionCount: s.versionCount,
            size: s.size,
            updatedAt: m.updatedAt,
          }
        }),
    }
  }

  /* ------------------------------ 写 ------------------------------ */

  async createAsset(input, actor) {
    return this.withLock(async () => {
      await this.ensureIndex({ force: true })
      const manifest = createManifest(input, actor, this.defaultActor)
      if (this.index.has(manifest.code)) {
        throw new HttpError(409, `资产 ${manifest.code} 已存在`)
      }
      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({ actor, action: 'dep-register', code: manifest.code, version: '—' })
      return summarize(manifest)
    })
  }

  async updateAsset(code, input, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')

      if (input.displayName !== undefined) {
        const value = String(input.displayName).trim()
        if (!value) throw new HttpError(422, '显示名称不能为空')
        manifest.displayName = value.slice(0, 80)
      }
      if (input.description !== undefined) {
        manifest.description = String(input.description).trim().slice(0, 500)
      }
      if (input.category !== undefined) manifest.category = assertCategory(input.category)
      if (input.os !== undefined) manifest.os = assertOs(input.os)
      if (input.arch !== undefined) manifest.arch = assertArch(input.arch)
      if (input.tags !== undefined) {
        manifest.tags = Array.isArray(input.tags)
          ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
          : []
      }
      if (input.maintainer !== undefined) {
        const value = String(input.maintainer).trim()
        if (value) manifest.maintainer = value.slice(0, 40)
      }
      if (input.homepage !== undefined) {
        manifest.homepage = String(input.homepage).trim().slice(0, 200)
      }
      manifest.updatedAt = nowIso()

      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({ actor, action: 'dep-update', code: manifest.code, version: '—' })
      return summarize(manifest)
    })
  }

  /**
   * 上传一个制品并登记为版本。
   *
   * 流式：不落内存；Gitea 驱动直接 pipe 到 fetch body。
   * 版本不可变：同版本已存在直接 409，不提供覆盖入口。
   */
  async addVersion(code, { version, fileName, stream, expectedSha256, changelog, declaredSize, actor }) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在，请先登记')
      const ver = assertVersion(version)
      if ((manifest.versions || []).some((v) => v.version === ver)) {
        throw new HttpError(409, `版本 ${ver} 已存在，版本不可覆盖`)
      }
      if (!fileName || !String(fileName).trim()) throw new HttpError(422, '文件名必填')
      if (declaredSize && declaredSize > this.maxFileBytes) {
        throw new HttpError(413, `文件超过 ${formatBytes(this.maxFileBytes)} 上限`)
      }

      const storageName = toStorageFileName(fileName)
      const hash = crypto.createHash('sha256')
      let bytes = 0
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk)
          bytes += chunk.length
          if (bytes > this.maxFileBytes) {
            cb(new Error('TOO_LARGE'))
            return
          }
          cb(null, chunk)
        },
      })
      /**
       * 用 pipeline 而不是 pipe：客户端取消上传时 req 会直接销毁，
       * 单纯 pipe 不会把这个中断传给 tap，于是 fetch 一直等一个永远不结束的 body，
       * 写锁也就永远不释放——后面所有上传都会卡在队列里（表现为「一直上传中，进度不动」）。
       * pipeline 会把中断一路传下去，tap 立刻 error，fetch 随之失败，锁正常归还。
       */
      pipeline(stream, tap).catch(() => {})

      let stored
      try {
        stored = await this.driver.putArtifact({
          code: manifest.code,
          version: ver,
          fileName: storageName,
          stream: tap,
          size: declaredSize,
        })
      } catch (err) {
        tap.destroy()
        if (err.message === 'TOO_LARGE') {
          throw new HttpError(413, `文件超过 ${formatBytes(this.maxFileBytes)} 上限`)
        }
        throw err
      }

      if (!bytes) {
        await this.driver.deleteArtifact(stored.path).catch(() => {})
        throw new HttpError(422, '文件为空')
      }
      if (bytes > this.maxFileBytes) {
        await this.driver.deleteArtifact(stored.path).catch(() => {})
        throw new HttpError(413, `文件超过 ${formatBytes(this.maxFileBytes)} 上限`)
      }

      const sha256 = hash.digest('hex')
      if (expectedSha256 && String(expectedSha256).toLowerCase() !== sha256) {
        await this.driver.deleteArtifact(stored.path).catch(() => {})
        throw new HttpError(422, 'sha256 与期望值不一致，已回滚上传')
      }

      const row = {
        version: ver,
        state: 'unreleased',
        publishedAt: nowIso(),
        publisher: actor || this.defaultActor,
        changelog: String(changelog || '').trim().slice(0, 500),
        totalSize: bytes,
        files: [
          {
            name: String(fileName).trim(),
            storageName,
            path: stored.path,
            size: bytes,
            sha256,
            contentType: 'application/octet-stream',
          },
        ],
      }

      manifest.versions = sortVersions([...(manifest.versions || []), row])
      manifest.updatedAt = nowIso()

      try {
        await this.driver.writeManifest(manifest)
      } catch (err) {
        // 两段写没有事务，manifest 失败必须删掉刚写入的字节，
        // 否则会留下绕过「版本不可变」的孤儿制品
        await this.driver.deleteArtifact(stored.path).catch(() => {})
        throw new HttpError(502, `登记版本失败，已回滚制品：${err.message}`)
      }

      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-upload',
        code: manifest.code,
        version: ver,
        sha256,
        size: bytes,
      })
      return { asset: summarize(manifest), version: { ...row, sha256 } }
    })
  }

  async enableVersion(code, version, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')
      const row = (manifest.versions || []).find((v) => v.version === version)
      if (!row) throw new HttpError(404, '版本不存在')
      if (!row.files?.length) throw new HttpError(422, '该版本没有制品文件，请重新上传')

      // 历史版本保持 enabled，允许继续下载与回滚；currentVersion 只决定默认发哪个。
      // 注意：这里不碰 manifest.status —— 资产是否对外提供由「启用资产」独立决定，
      // 一个版本生效不应该顺带把整个资产挂到线上。
      row.state = 'enabled'
      manifest.currentVersion = row.version
      manifest.updatedAt = nowIso()

      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-enable-version',
        code: manifest.code,
        version: row.version,
      })
      return summarize(manifest)
    })
  }

  /**
   * 启用资产：对外提供的总开关，只看资产自身状态。
   * 不校验是否已有生效版本 —— 版本是否可下由版本状态单独决定，
   * 没有生效版本时即使上架，目录页也不会生成条目、下载接口直接 404。
   */
  async enableAsset(code, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')
      if (manifest.status === 'enabled') return summarize(manifest)

      manifest.status = 'enabled'
      manifest.updatedAt = nowIso()
      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-enable',
        code: manifest.code,
        version: manifest.currentVersion || '—',
      })
      return summarize(manifest)
    })
  }

  /** 停用资产：退回待发布。版本状态与制品都保留，随时可以再启用。 */
  async disableAsset(code, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')
      if (manifest.status === 'unreleased') return summarize(manifest)

      manifest.status = 'unreleased'
      manifest.updatedAt = nowIso()
      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-disable',
        code: manifest.code,
        version: manifest.currentVersion || '—',
      })
      return summarize(manifest)
    })
  }

  async takeDown(code, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')
      if (manifest.status === 'taken_down') return summarize(manifest)

      manifest.status = 'taken_down'
      manifest.updatedAt = nowIso()
      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-take-down',
        code: manifest.code,
        version: manifest.currentVersion || '—',
      })
      return summarize(manifest)
    })
  }

  async restore(code, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')

      // 恢复上架只看资产自身，不校验版本 —— 有没有可下载的版本由版本状态决定
      manifest.status = 'enabled'
      manifest.updatedAt = nowIso()
      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-restore',
        code: manifest.code,
        version: manifest.currentVersion || '—',
      })
      return summarize(manifest)
    })
  }

  /**
   * 单版本失效：state 退回 unreleased，制品保留、可重新生效。
   * currentVersion 指向它时顺延到剩下最新的启用版本；一个都不剩就退回待发布。
   */
  async disableVersion(code, version, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')
      const row = (manifest.versions || []).find((v) => v.version === version)
      if (!row) throw new HttpError(404, '版本不存在')
      if (row.state !== 'enabled') return summarize(manifest)

      // 只动版本。资产状态是独立的开关，不因为「没有可用版本」被改回去
      row.state = 'unreleased'
      manifest.currentVersion = this.pickCurrent(manifest, version)
      manifest.updatedAt = nowIso()

      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-disable-version',
        code: manifest.code,
        version,
      })
      return summarize(manifest)
    })
  }

  /** 删单个版本：先清制品再改 manifest，中途失败最多留孤儿文件，不会出现有记录没文件。 */
  async removeVersion(code, version, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')
      const row = (manifest.versions || []).find((v) => v.version === version)
      if (!row) throw new HttpError(404, '版本不存在')

      let removed = 0
      for (const file of row.files || []) {
        await this.driver.deleteArtifact(this.artifactPath(manifest.code, version, file))
        removed += 1
      }

      manifest.versions = (manifest.versions || []).filter((v) => v.version !== version)
      // 同上：删到空也不改资产状态，currentVersion 允许为 null
      manifest.currentVersion = this.pickCurrent(manifest, version)
      manifest.updatedAt = nowIso()

      await this.driver.writeManifest(manifest)
      this.index.set(manifest.code, manifest)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-delete-version',
        code: manifest.code,
        version,
        size: versionSize(row),
        files: removed,
      })
      return { asset: summarize(manifest), removed }
    })
  }

  /** 删整个资产：所有版本的制品 + manifest。仓库里的字节一并清掉，不可恢复。 */
  async removeAsset(code, actor) {
    return this.withLock(async () => {
      const manifest = await this.getManifest(assertCode(code), { force: true })
      if (!manifest) throw new HttpError(404, '资产不存在')

      let removed = 0
      for (const v of manifest.versions || []) {
        for (const file of v.files || []) {
          await this.driver.deleteArtifact(this.artifactPath(manifest.code, v.version, file))
          removed += 1
        }
      }

      await this.driver.deleteManifest(manifest.code)
      this.index.delete(manifest.code)
      this.loadedAt = Date.now()
      await this.record({
        actor,
        action: 'dep-delete',
        code: manifest.code,
        version: manifest.currentVersion || '—',
        versions: (manifest.versions || []).length,
        files: removed,
      })
      return { code: manifest.code, displayName: manifest.displayName, versions: (manifest.versions || []).length, removed }
    })
  }

  /** 制品在 driver 里的相对路径；老数据可能没有 path 字段，用 code/version/storageName 拼。 */
  artifactPath(code, version, file) {
    return file.path || `${code}/${version}/${file.storageName || file.name}`
  }

  /** 从剩下启用的版本里挑版本号最高的作为当前版本；跳过被排除的那个。 */
  pickCurrent(manifest, excludeVersion) {
    const rest = (manifest.versions || [])
      .filter((v) => v.state === 'enabled' && v.version !== excludeVersion)
      .sort((a, b) => compareVersionsDesc(a.version, b.version))
    return rest[0]?.version || null
  }

  /* ------------------------------ 读 ------------------------------ */

  async detail(code) {
    const manifest = await this.getManifest(assertCode(code))
    if (!manifest) throw new HttpError(404, '资产不存在')
    return {
      ...summarize(manifest),
      versions: sortVersions(manifest.versions || []).map((v) => ({
        version: v.version,
        state: v.state,
        publishedAt: v.publishedAt,
        publisher: v.publisher,
        changelog: v.changelog || '',
        size: v.totalSize || versionSize(v),
        sha256: v.files?.[0]?.sha256 || '',
        fileName: v.files?.[0]?.name || '',
        files: v.files || [],
      })),
    }
  }

  /**
   * 下载前判定：
   *   资产未启用 / 已下架 -> 403
   *   版本不存在 -> 404
   *   版本未生效 -> 403
   */
  async prepareDownload(code, version) {
    const manifest = await this.getManifest(assertCode(code))
    if (!manifest) throw new HttpError(404, '资产不存在')
    if (manifest.status !== 'enabled') throw new HttpError(403, '资产还未启用或已下架')

    const row = (manifest.versions || []).find((v) => v.version === version)
    if (!row) throw new HttpError(404, '版本不存在')
    if (row.state !== 'enabled') throw new HttpError(403, '该版本不可下载')

    const file = row.files?.[0]
    if (!file) throw new HttpError(404, '该版本没有制品文件')

    return { manifest, version: row, file }
  }

  async catalog(query = {}) {
    await this.ensureIndex()
    const q = String(query.q || '').trim().toLowerCase()
    const category = query.category && query.category !== 'all' ? String(query.category) : null
    const os = query.os ? String(query.os) : null
    const arch = query.arch ? String(query.arch) : null

    let items = [...this.index.values()].filter((m) => m.status === 'enabled')
    if (category) items = items.filter((m) => m.category === category)
    if (os) items = items.filter((m) => (m.os || []).includes(os))
    if (arch) items = items.filter((m) => (m.arch || []).includes(arch))
    if (q) {
      items = items.filter((m) =>
        [m.code, m.displayName, m.description, ...(m.tags || [])].join(' ').toLowerCase().includes(q),
      )
    }

    return items
      .map((m) => {
        const current = (m.versions || []).find((v) => v.version === m.currentVersion)
        return {
          code: m.code,
          displayName: m.displayName,
          description: m.description,
          category: m.category,
          os: m.os || [],
          arch: m.arch || [],
          currentVersion: m.currentVersion,
          size: current ? current.totalSize || versionSize(current) : 0,
          sha256: current?.files?.[0]?.sha256 || '',
          fileName: current?.files?.[0]?.name || '',
          updatedAt: m.updatedAt,
        }
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  }
}

/** 给 Promise 加超时，超时抛 504；不改变原 Promise 的最终状态，只影响等待方 */
function withTimeout(promise, ms) {
  if (!ms) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, '操作超时，请重试')), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function formatBytes(bytes) {  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
