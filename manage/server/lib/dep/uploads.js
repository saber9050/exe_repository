/**
 * 分片上传会话。
 *
 * 一个会话 = 一份 `uploads/{uploadId}.json` + 一个 S3 MultipartUpload。
 * 设计上有三处刻意的取舍：
 *
 *   1. 分片阶段不写会话 JSON。已传分片一律以 `ListParts` 为唯一事实源，
 *      会话里只放「创建时才知道」的元信息（版本、文件名、partSize、过期时间）。
 *      否则每传一片就要重写一次 JSON，256 片就是 256 次无谓写。
 *   2. 对外 uploadId 由本模块生成，S3 的 MultipartUploadId 只存在服务端。
 *      客户端拿到的 ID 拼不出任何直连对象存储的请求。
 *   3. complete 成功后会话标记为 done 并保留（含结果），不立刻删。
 *      这样「complete 超时后重试」是幂等的，而不是 404 让人以为失败。
 */
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from '../http-error.js'
import { assertCode, assertVersion, nowIso, toStorageFileName } from './manifest.js'

const MiB = 1024 * 1024
/** S3 规范硬下限：除最后一片外，每片必须 ≥ 5 MiB，低于这个值 Complete 会被拒 */
const S3_MIN_PART = 5 * MiB
const MIN_PART = 8 * MiB
const MAX_PART = 5 * 1024 * MiB
const MAX_REQUESTED_PART = 64 * MiB

/** 分片规划：partSize 既要够大（少片），又要保证片数不超上限 */
export function planParts(size, { minPart = MIN_PART, maxParts = 10000, requested = 0 } = {}) {
  if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(size)) {
    throw new HttpError(422, '文件大小不合法', { code: 'INVALID_SIZE' })
  }
  const requestedSize = Math.min(Math.max(Number(requested) || 0, 0), MAX_REQUESTED_PART)
  const byLimit = Math.ceil(size / maxParts)
  // 下限兜住 S3 的 5 MiB 规则：哪怕 DEP_PART_SIZE 配成 1 MiB 也不能低于它，
  // 否则前 N-1 片会被对象存储拒绝，且报错出现在 Complete 那一步，很难定位
  const floor = Math.max(Number(minPart) || 0, S3_MIN_PART)
  let partSize = Math.max(floor, byLimit, requestedSize)
  // 对齐到 1 MiB，避免出现 8388609 这种怪异值
  partSize = Math.ceil(partSize / MiB) * MiB
  if (partSize > MAX_PART) {
    throw new HttpError(413, '文件超过对象存储单片上限', { code: 'FILE_TOO_LARGE' })
  }
  const partCount = Math.ceil(size / partSize)
  if (partCount > maxParts) {
    throw new HttpError(413, `分片数超过 ${maxParts} 上限`, { code: 'FILE_TOO_LARGE' })
  }
  return { partSize, partCount }
}

/** 第 n 片应有的字节数（末片是余数） */
export function expectedPartSize(partNumber, partSize, partCount, totalSize) {
  if (partNumber < partCount) return partSize
  return totalSize - (partCount - 1) * partSize
}

function newUploadId() {
  return `up_${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`
}

const sessionKey = (uploadId) => `uploads/${uploadId}.json`
const UPLOAD_PREFIX = 'uploads/'

export class UploadManager {
  /**
   * @param {object} p
   * @param {object} p.driver            存储驱动（MinIO 对象存储）
   * @param {object} p.cfg               { partSize, maxParts, ttlHours, maxFileBytes, verifyMode }
   * @param {(payload: object) => Promise<object>} p.commit 登记版本（DepStore.commitVersion）
   */
  constructor({ driver, cfg, commit }) {
    this.driver = driver
    this.cfg = cfg
    this.commit = commit
  }

  /**
   * 列出会话文件（相对 key，如 `up_xxx.json`）。
   * 前缀由 driver.meta.list 负责拼，这里只关心逻辑前缀 `uploads/`。
   */
  async listSessions() {
    if (typeof this.driver.meta.list !== 'function') return []
    try {
      return await this.driver.meta.list(UPLOAD_PREFIX)
    } catch {
      throw new HttpError(502, '读取上传会话失败：存储不可用，请稍后重试', {
        code: 'STORAGE_UNAVAILABLE',
      })
    }
  }


  /* ------------------------------ 会话读写 ------------------------------ */

  async readSession(uploadId) {
    if (!uploadId || !/^up_[a-z0-9]+$/.test(uploadId)) return null
    try {
      const { data } = await this.driver.meta.getJson(sessionKey(uploadId))
      return data || null
    } catch {
      throw new HttpError(502, '读取上传会话失败：存储不可用，请稍后重试', {
        code: 'STORAGE_UNAVAILABLE',
      })
    }
  }

  async writeSession(session) {
    await this.driver.meta.putJson(sessionKey(session.uploadId), session)
    return session
  }

  async dropSession(uploadId) {
    await this.driver.meta.deleteKey(sessionKey(uploadId)).catch(() => {})
  }

  isExpired(session) {
    return Date.now() > new Date(session.expiresAt).getTime()
  }

  /** 过期清理：Abort 掉 S3 分片并删会话。失败不抛错，别把查询接口带崩。 */
  async expire(session) {
    await this.driver.abortUpload({ relPath: session.relPath, uploadId: session.s3UploadId }).catch(() => {})
    await this.dropSession(session.uploadId)
  }

  /** 校验路径里的 code 与会话归属一致，防串号 */
  assertBelongs(session, code) {
    if (session.code !== assertCode(code)) {
      throw new HttpError(404, '上传会话不存在', { code: 'UPLOAD_NOT_FOUND' })
    }
  }

  /** 已传分片 + 派生进度。ListParts 是唯一事实源。 */
  async describe(session) {
    const parts = session.state === 'done'
      ? []
      : await this.driver
          .listParts({ relPath: session.relPath, uploadId: session.s3UploadId })
          .catch(() => [])

    const receivedParts = parts.length
    const receivedBytes = parts.reduce((n, p) => n + (Number(p.size) || 0), 0)
    const uploaded = new Set(parts.map((p) => p.partNumber))
    const missingParts = []
    for (let n = 1; n <= session.partCount; n += 1) {
      if (!uploaded.has(n)) missingParts.push(n)
    }
    const state =
      session.state === 'done'
        ? 'done'
        : receivedParts === 0
          ? 'created'
          : 'uploading'

    return {
      uploadId: session.uploadId,
      code: session.code,
      version: session.version,
      fileName: session.fileName,
      storageName: session.storageName,
      objectKey: session.relPath,
      size: session.size,
      sha256: session.sha256,
      changelog: session.changelog || '',
      partSize: session.partSize,
      partCount: session.partCount,
      state,
      receivedParts,
      receivedBytes,
      percent: session.size ? Math.floor((receivedBytes / session.size) * 100) : 0,
      parts: parts.map((p) => ({
        partNumber: p.partNumber,
        size: p.size,
        etag: p.etag,
        uploadedAt: p.lastModified || null,
      })),
      missingParts: missingParts.slice(0, 200),
      truncated: missingParts.length > 200,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      actor: session.actor,
    }
  }

  /* ------------------------------ 创建 ------------------------------ */

  /**
   * 创建会话。调用方已完成「资产存在 + 版本未占用」的预检。
   * 这里只做并发会话去重与 S3 Multipart 初始化。
   */
  async create({ code, version, fileName, size, sha256, changelog, actor, partSize: requestedPartSize }) {
    const safeCode = assertCode(code)
    const ver = assertVersion(version)
    const name = String(fileName || '').trim()
    if (!name) throw new HttpError(422, '文件名必填', { code: 'INVALID_FILENAME' })

    const total = Number(size)
    if (total > this.cfg.maxFileBytes) {
      throw new HttpError(
        413,
        `文件超过 ${formatBytes(this.cfg.maxFileBytes)} 上限`,
        { code: 'FILE_TOO_LARGE' },
      )
    }

    const checksum = String(sha256 || '').trim().toLowerCase()
    if (this.cfg.verifyMode !== 'none' && !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new HttpError(422, 'sha256 必须是 64 位小写十六进制', { code: 'INVALID_CHECKSUM' })
    }

    const { partSize, partCount } = planParts(total, {
      minPart: this.cfg.partSize,
      maxParts: this.cfg.maxParts,
      requested: requestedPartSize,
    })

    // 同资产同版本已有未完成会话：直接拒绝并带出 uploadId，
    // 客户端据此续传，避免重复点上传产生两份分片
    const existing = await this.findActive(safeCode, ver)
    if (existing) {
      throw new HttpError(409, `版本 ${ver} 已有进行中的上传，请续传或先取消`, {
        code: 'UPLOAD_IN_PROGRESS',
        existingUploadId: existing.uploadId,
      })
    }

    const storageName = toStorageFileName(name)
    const relPath = `${safeCode}/${ver}/${storageName}`

    const { uploadId: s3UploadId } = await this.driver.createUpload({
      relPath,
      contentType: 'application/octet-stream',
    })

    const createdAt = nowIso()
    const session = {
      uploadId: newUploadId(),
      code: safeCode,
      version: ver,
      fileName: name,
      storageName,
      relPath,
      size: total,
      sha256: checksum,
      changelog: String(changelog || '').trim().slice(0, 500),
      partSize,
      partCount,
      state: 'created',
      s3UploadId,
      createdAt,
      expiresAt: new Date(Date.now() + this.cfg.ttlHours * 3600 * 1000).toISOString(),
      actor: actor || '',
    }

    await this.writeSession(session)
    return this.describe(session)
  }

  /** 找同资产同版本的未完成会话（只要还有效） */
  async findActive(code, version) {
    let items = []
    try {
      items = await this.listSessions()
    } catch {
      return null
    }
    for (const item of items) {
      if (!String(item.key).endsWith('.json')) continue
      const uploadId = String(item.key).replace(/\.json$/, '')
      const session = await this.readSession(uploadId).catch(() => null)
      if (!session) continue
      if (session.state === 'done') continue
      if (session.code !== code || session.version !== version) continue
      if (this.isExpired(session)) {
        await this.expire(session)
        continue
      }
      return session
    }
    return null
  }

  /* ------------------------------ 查询 ------------------------------ */

  async get({ code, uploadId }) {
    const session = await this.readSession(uploadId)
    if (!session) throw new HttpError(404, '上传会话不存在', { code: 'UPLOAD_NOT_FOUND' })
    this.assertBelongs(session, code)

    if (session.state === 'done') {
      throw new HttpError(409, '该上传已完成', {
        code: 'UPLOAD_COMPLETED',
        versionUrl: `/server/deps/${encodeURIComponent(session.code)}`,
      })
    }
    if (this.isExpired(session)) {
      await this.expire(session)
      throw new HttpError(410, '上传会话已过期，请重新发起', { code: 'UPLOAD_EXPIRED' })
    }
    return this.describe(session)
  }

  async list({ code, state = 'active' }) {
    const safeCode = code ? assertCode(code) : ''
    const keys = await this.listSessions()

    const items = []
    for (const item of keys) {
      const key = String(item.key)
      if (!key.endsWith('.json')) continue
      const uploadId = key.replace(/\.json$/, '')
      const session = await this.readSession(uploadId).catch(() => null)
      if (!session) continue
      if (safeCode && session.code !== safeCode) continue

      if (this.isExpired(session)) {
        // done 会话只是留着给重复 complete 返回同一结果，过期就静默删掉
        if (session.state === 'done') await this.dropSession(session.uploadId)
        else await this.expire(session)
        continue
      }
      if (state !== 'all' && session.state === 'done') continue

      const described = await this.describe(session)
      items.push({
        uploadId: described.uploadId,
        code: described.code,
        version: described.version,
        fileName: described.fileName,
        size: described.size,
        receivedBytes: described.receivedBytes,
        percent: described.percent,
        state: described.state,
        createdAt: described.createdAt,
        expiresAt: described.expiresAt,
      })
    }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return { items, total: items.length }
  }

  /* ------------------------------ 分片 ------------------------------ */

  async putPart({ code, uploadId, partNumber, size, chunkSha256, stream }) {
    const session = await this.readSession(uploadId)
    if (!session) throw new HttpError(404, '上传会话不存在', { code: 'UPLOAD_NOT_FOUND' })
    this.assertBelongs(session, code)

    if (session.state === 'done') {
      throw new HttpError(409, '该上传已完成', { code: 'UPLOAD_COMPLETED' })
    }
    if (this.isExpired(session)) {
      await this.expire(session)
      throw new HttpError(410, '上传会话已过期，请重新发起', { code: 'UPLOAD_EXPIRED' })
    }

    const n = Number(partNumber)
    if (!Number.isInteger(n) || n < 1 || n > session.partCount) {
      throw new HttpError(400, `分片号必须在 1~${session.partCount} 之间`, {
        code: 'INVALID_PART_NUMBER',
      })
    }

    const expected = expectedPartSize(n, session.partSize, session.partCount, session.size)
    if (!size) {
      throw new HttpError(411, '分片请求必须带 Content-Length', { code: 'LENGTH_REQUIRED' })
    }
    if (size > expected) {
      throw new HttpError(413, `第 ${n} 片应为 ${expected} 字节，收到 ${size} 字节`, {
        code: 'PART_TOO_LARGE',
      })
    }
    if (size < expected) {
      throw new HttpError(422, `第 ${n} 片应为 ${expected} 字节，收到 ${size} 字节`, {
        code: 'PART_SIZE_MISMATCH',
        expected,
        actual: size,
      })
    }

    const expectChecksum = String(chunkSha256 || '').trim().toLowerCase()
    const useChecksum = this.cfg.verifyMode !== 'none' && /^[0-9a-f]{64}$/.test(expectChecksum)
    const hash = useChecksum ? crypto.createHash('sha256') : null
    let bytes = 0

    const tap = new Transform({
      transform(chunk, _enc, cb) {
        if (hash) hash.update(chunk)
        bytes += chunk.length
        cb(null, chunk)
      },
    })

    /**
     * 用 pipeline 而不是 pipe：客户端中断时 req 会直接销毁，
     * 单纯 pipe 不会把这个中断传给 tap，S3 那边会一直等一个永不结束的 body，
     * 表现就是「分片传到一半不动，也不报错」。
     */
    pipeline(stream, tap).catch(() => {})

    let stored
    try {
      stored = await this.driver.uploadPart({
        relPath: session.relPath,
        uploadId: session.s3UploadId,
        partNumber: n,
        stream: tap,
        size,
      })
    } catch (err) {
      tap.destroy()
      throw err
    }

    if (bytes !== expected) {
      throw new HttpError(422, `第 ${n} 片实际写入 ${bytes} 字节，应为 ${expected} 字节`, {
        code: 'PART_SIZE_MISMATCH',
        expected,
        actual: bytes,
      })
    }

    if (useChecksum) {
      const actual = hash.digest('hex')
      if (actual !== expectChecksum) {
        // 分片已写入但内容不符：客户端重传同号即可覆盖，S3 的分片是同号替换语义
        throw new HttpError(422, '分片校验失败，请重传该片', {
          code: 'CHUNK_CHECKSUM_MISMATCH',
          expected: expectChecksum,
          actual,
        })
      }
    }

    // 会话状态只在第一次上传时落一次，之后由 ListParts 推导，不每片写 JSON
    if (session.state === 'created') {
      session.state = 'uploading'
      this.writeSession(session).catch(() => {})
    }

    /**
     * 刻意不在这里调 ListParts：那会让每片多一次对象存储请求（256 片就是 256 次）。
     * 客户端本来就清楚自己传完了多少，进度以它自己的累计为准；查询接口
     * GET /uploads/{id} 会给准确值。
     */
    return {
      partNumber: n,
      etag: stored.etag,
      size: stored.size || size,
      totalParts: session.partCount,
    }
  }

  /* ------------------------------ 完成 ------------------------------ */

  async complete({ code, uploadId, actor }) {
    const session = await this.readSession(uploadId)
    if (!session) throw new HttpError(404, '上传会话不存在', { code: 'UPLOAD_NOT_FOUND' })
    this.assertBelongs(session, code)

    // 幂等：重复 complete 直接返回首次结果
    if (session.state === 'done' && session.result) return session.result

    if (this.isExpired(session)) {
      await this.expire(session)
      throw new HttpError(410, '上传会话已过期，请重新发起', { code: 'UPLOAD_EXPIRED' })
    }

    const parts = await this.driver.listParts({
      relPath: session.relPath,
      uploadId: session.s3UploadId,
    })

    const uploaded = new Map(parts.map((p) => [p.partNumber, p]))
    const missing = []
    for (let n = 1; n <= session.partCount; n += 1) if (!uploaded.has(n)) missing.push(n)
    if (missing.length) {
      throw new HttpError(409, `还有 ${missing.length} 个分片未上传`, {
        code: 'MISSING_PARTS',
        missingParts: missing.slice(0, 200),
        truncated: missing.length > 200,
      })
    }

    const actualSize = parts.reduce((n, p) => n + (Number(p.size) || 0), 0)
    if (actualSize !== session.size) {
      throw new HttpError(422, `合并后大小 ${actualSize} 与声明的 ${session.size} 不一致`, {
        code: 'SIZE_MISMATCH',
        expected: session.size,
        actual: actualSize,
      })
    }

    let completed
    try {
      completed = await this.driver.completeUpload({
        relPath: session.relPath,
        uploadId: session.s3UploadId,
        parts,
      })
    } catch (err) {
      // 合并失败：分片还留着，客户端可以重试 complete
      throw err
    }

    // 大小以对象属性为准，S3 的分片大小之和偶尔会比实际对象多几个字节
    const stat = await this.driver.statArtifact(session.relPath).catch(() => null)
    if (stat && stat.size !== session.size) {
      await this.driver.deleteArtifact(session.relPath).catch(() => {})
      await this.dropSession(session.uploadId)
      throw new HttpError(422, `对象实际大小 ${stat.size} 与声明不一致，已回滚`, {
        code: 'SIZE_MISMATCH',
        expected: session.size,
        actual: stat.size,
      })
    }

    // full 模式：全量读回复算，挡的是「客户端自己算错/被篡改」
    let sha256 = session.sha256
    if (this.cfg.verifyMode === 'full' && session.sha256) {
      const actual = await this.hashObject(session.relPath)
      if (actual !== session.sha256) {
        await this.driver.deleteArtifact(session.relPath).catch(() => {})
        await this.dropSession(session.uploadId)
        throw new HttpError(422, '整体校验失败，已回滚', {
          code: 'CHECKSUM_MISMATCH',
          expected: session.sha256,
          actual,
        })
      }
      sha256 = actual
    }

    let result
    try {
      result = await this.commit({
        code: session.code,
        version: session.version,
        fileName: session.fileName,
        storageName: session.storageName,
        relPath: session.relPath,
        size: session.size,
        sha256,
        changelog: session.changelog,
        actor: actor || session.actor,
        partCount: session.partCount,
        partSize: session.partSize,
      })
    } catch (err) {
      // 登记失败（含版本被抢占）：字节刚合并出来但没进 manifest，必须删掉，
      // 否则留下一个绕过「版本不可变」的孤儿对象。
      await this.driver.deleteArtifact(session.relPath).catch(() => {})
      await this.dropSession(session.uploadId)
      if (err instanceof HttpError) throw err
      throw new HttpError(502, `登记版本失败，已回滚制品：${err.message}`, {
        code: 'MANIFEST_WRITE_FAILED',
      })
    }

    const payload = {
      ...result,
      upload: {
        partCount: session.partCount,
        partSize: session.partSize,
        durationMs: Date.now() - new Date(session.createdAt).getTime(),
      },
    }

    // 保留 done 会话，让重复 complete 幂等；过期后由 list/查询惰性清理
    session.state = 'done'
    session.completedAt = nowIso()
    session.result = payload
    await this.writeSession(session).catch(() => {})

    return payload
  }

  /** 从对象存储流式读回算 sha256：不落盘、不整体进内存 */
  async hashObject(relPath) {
    const res = await this.driver.fetchArtifact(relPath)
    const hash = crypto.createHash('sha256')
    for await (const chunk of res.body) hash.update(chunk)
    return hash.digest('hex')
  }

  /* ------------------------------ 取消 ------------------------------ */

  async abort({ code, uploadId }) {
    const session = await this.readSession(uploadId)
    if (!session) return { ok: true, uploadId, aborted: false }
    this.assertBelongs(session, code)

    if (session.state === 'done') {
      throw new HttpError(409, '该上传已完成，不能取消', { code: 'UPLOAD_COMPLETED' })
    }

    await this.driver.abortUpload({ relPath: session.relPath, uploadId: session.s3UploadId })
    await this.dropSession(uploadId)
    return { ok: true, uploadId, aborted: true }
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
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
