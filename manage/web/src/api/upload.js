/**
 * 分片上传器。
 *
 * 协议：创建会话 → 并发 PUT 分片 → complete。
 * 断点续传靠服务端返回的 parts 列表（ListParts 是唯一事实源），
 * 所以「暂停 / 刷新页面 / 换浏览器」都能接着传，不会从 0 重来。
 *
 * 进度口径是「已确认字节 / 总字节」，跨分片累加 —— 比 XHR 单请求的
 * upload.onprogress 更准，也是暂停后能正确恢复的原因。
 */
import { ApiError, getToken } from './client'

const RETRY_DELAYS = [500, 1000, 2000]
const STORAGE_PREFIX = 'dep.upload.'

function authHeaders(extra = {}) {
  const token = getToken()
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { message: text }
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.message || `请求失败（${res.status}）`, body)
  }
  return body
}

/** 单分片 sha256：一片 8 MiB，主线程摘要足够快，不值得再起 Worker */
async function chunkSha256(blob) {
  if (!globalThis.crypto?.subtle) return ''
  try {
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return hex
  } catch {
    return ''
  }
}

export function isSessionLost(err) {
  const code = err?.body?.code
  return code === 'UPLOAD_EXPIRED' || code === 'UPLOAD_NOT_FOUND' || err?.status === 410 || err?.status === 404
}

function resumeKey({ code, version, fileName, size }) {
  return `${STORAGE_PREFIX}${code}.${version}.${fileName}.${size}`
}

export function rememberSession(params, uploadId) {
  try {
    localStorage.setItem(resumeKey(params), uploadId)
  } catch {
    /* 隐私模式下写不了，忽略 */
  }
}

export function forgetSession(params) {
  try {
    localStorage.removeItem(resumeKey(params))
  } catch {
    /* 忽略 */
  }
}

export function recalledSession(params) {
  try {
    return localStorage.getItem(resumeKey(params)) || ''
  } catch {
    return ''
  }
}

/* ------------------------------ 会话 ------------------------------ */

export async function getUploadSession({ code, uploadId }) {
  return requestJson(
    `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}`,
    { headers: authHeaders() },
  )
}

/**
 * 创建会话；同版本已有进行中的会话时复用它（不产生第二份分片）。
 */
export async function createUploadSession({ code, version, fileName, size, sha256, changelog }) {
  try {
    return await requestJson(`/server/deps/${encodeURIComponent(code)}/uploads`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ version, fileName, size, sha256, changelog }),
    })
  } catch (err) {
    const existing = err?.body?.existingUploadId
    if (err?.status === 409 && err?.body?.code === 'UPLOAD_IN_PROGRESS' && existing) {
      return getUploadSession({ code, uploadId: existing })
    }
    throw err
  }
}

export async function abortUploadSession({ code, uploadId }) {
  return requestJson(
    `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}`,
    { method: 'DELETE', headers: authHeaders() },
  )
}

/* ------------------------------ 分片 ------------------------------ */

async function putPart({ code, uploadId, partNumber, blob, signal, onBytes }) {
  for (let attempt = 0; ; attempt += 1) {
    let res
    try {
      const headers = authHeaders({ 'Content-Type': 'application/octet-stream' })
      const sha = await chunkSha256(blob)
      if (sha) headers['X-Chunk-Sha256'] = sha

      res = await fetch(
        `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}` +
          `/parts/${partNumber}`,
        { method: 'PUT', headers, body: blob, signal },
      )
    } catch (err) {
      if (err.name === 'AbortError') throw err
      if (attempt >= RETRY_DELAYS.length) {
        throw new ApiError(0, '网络中断，分片上传失败')
      }
      await sleep(RETRY_DELAYS[attempt])
      continue
    }

    if (res.ok) {
      onBytes?.(blob.size)
      return res.json().catch(() => ({}))
    }

    const text = await res.text().catch(() => '')
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { message: text }
    }

    // 5xx 才重试；校验失败重试一次（重传同号会覆盖旧分片）
    const retriable = res.status >= 500 || body?.code === 'CHUNK_CHECKSUM_MISMATCH'
    if (!retriable || attempt >= RETRY_DELAYS.length) {
      throw new ApiError(res.status, body?.message || `分片上传失败（${res.status}）`, body)
    }
    await sleep(RETRY_DELAYS[attempt])
  }
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 分片上传一个制品。
 *
 * @param {object} p
 * @param {string} p.code
 * @param {string} p.version
 * @param {File} p.file
 * @param {string} p.sha256          整体 sha256（hash.js 算出，可为空）
 * @param {string} [p.changelog]
 * @param {number} [p.concurrency]   并发分片数，默认 3
 * @param {(percent:number, loaded:number, total:number) => void} [p.onProgress]
 * @param {(session:object) => void} [p.onSession] 会话建立时回调（UI 记 uploadId）
 * @param {AbortSignal} [p.signal]
 */
export async function uploadDepVersionChunked({
  code,
  version,
  file,
  sha256,
  changelog,
  concurrency = 3,
  onProgress,
  onSession,
  signal,
}) {
  const params = { code, version, fileName: file.name, size: file.size }

  const session = await createUploadSession({
    code,
    version,
    fileName: file.name,
    size: file.size,
    sha256,
    changelog,
  })

  const { uploadId, partSize, partCount } = session
  rememberSession(params, uploadId)
  onSession?.(session)

  const done = new Set((session.parts || []).map((p) => p.partNumber))
  let uploaded = (session.parts || []).reduce((n, p) => n + (Number(p.size) || 0), 0)
  onProgress?.(percentOf(uploaded, file.size), uploaded, file.size)

  const pending = []
  for (let n = 1; n <= partCount; n += 1) if (!done.has(n)) pending.push(n)

  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const partNumber = pending[cursor]
      cursor += 1

      const start = (partNumber - 1) * partSize
      const blob = file.slice(start, Math.min(start + partSize, file.size))

      await putPart({
        code,
        uploadId,
        partNumber,
        blob,
        signal,
        onBytes: (bytes) => {
          uploaded += bytes
          onProgress?.(percentOf(uploaded, file.size), uploaded, file.size)
        },
      })
    }
  }

  const workers = Math.max(1, Math.min(concurrency, pending.length || 1))
  await Promise.all(Array.from({ length: workers }, worker))

  const result = await requestJson(
    `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}/complete`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
      signal,
    },
  )

  forgetSession(params)
  onProgress?.(100, file.size, file.size)
  return result
}

function percentOf(loaded, total) {
  if (!total) return 0
  return Math.min(99, Math.floor((loaded / total) * 100))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
