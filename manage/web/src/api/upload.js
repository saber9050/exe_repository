/**
 * 分片上传器。
 *
 * 协议：创建会话 → 并发 PUT 分片 → complete。
 * 断点续传靠服务端返回的 parts 列表（ListParts 是唯一事实源），
 * 所以「暂停 / 刷新页面 / 换浏览器」都能接着传，不会从 0 重来。
 *
 * 进度为什么不用 fetch：
 *   fetch 没有上传进度事件，只能在分片完成时拿到「又少一片」，
 *   8 MiB 一片 + 3 并发，界面就会一次跳 1~3%，慢速网络下几秒不动。
 *   这里用 XHR 拿 upload.onprogress，把每个分片「已发送字节」聚合起来，
 *   进度才是连续的。代价是代码比 fetch 长一点，值得。
 *
 * 进度口径：已完成分片字节 + 各在传分片的已发送字节，节流 100ms 上报。
 * 百分比封顶 99，100 留给服务端 complete 之后。
 */
import { ApiError, getToken } from './client'

const RETRY_DELAYS = [500, 1000, 2000]

/**
 * 暂停信号：不是 AbortError。
 * 区别很重要 —— Abort 会掐断正在传的分片（S3 里半片无效，等于白传），
 * 暂停要的是「不再取新片、把当前这几片传完再停」。
 */
export class PausedError extends Error {
  constructor() {
    super('paused')
    this.name = 'PausedError'
  }
}
const STORAGE_PREFIX = 'dep.upload.'
const EMIT_INTERVAL_MS = 100
const MAX_PERCENT = 99

/**
 * 把「用户取消」与「暂停中断」两个信号合并成一个。
 * putPart 只接受一个 signal，但暂停时需要能中断其它在传分片。
 */
function mergeSignals(a, b) {
  if (!a) return b
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (a.aborted || b.aborted) {
    controller.abort()
    return controller.signal
  }
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}

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

/* ------------------------------ 单一分片 ------------------------------ */

/**
 * 用 XHR 发一片。
 * @param {(sent: number) => void} [onSent] 本片已发送字节，随上传实时回调
 */
function putPartXhr({ url, blob, headers, signal, onSent }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    for (const [key, value] of Object.entries(headers)) {
      if (value) xhr.setRequestHeader(key, value)
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onSent?.(event.loaded)
    }

    let abortedByUser = false
    const onAbort = () => {
      abortedByUser = true
      xhr.abort()
    }
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    xhr.onload = () => {
      cleanup()
      let body = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        body = { message: xhr.responseText }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body || {})
        return
      }
      reject(new ApiError(xhr.status, body?.message || `分片上传失败（${xhr.status}）`, body))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new ApiError(0, '网络中断，分片上传失败'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(abortedByUser ? new DOMException('aborted', 'AbortError') : new ApiError(0, '已取消上传'))
    }

    xhr.send(blob)
  })
}

async function putPart({ code, uploadId, partNumber, blob, signal, onSent }) {
  const url =
    `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}` +
    `/parts/${partNumber}`

  for (let attempt = 0; ; attempt += 1) {
    try {
      const headers = authHeaders({ 'Content-Type': 'application/octet-stream' })
      const sha = await chunkSha256(blob)
      if (sha) headers['X-Chunk-Sha256'] = sha
      return await putPartXhr({ url, blob, headers, signal, onSent })
    } catch (err) {
      if (err.name === 'AbortError') throw err

      const errorCode = err?.body?.code
      // 5xx 与校验失败可重试：校验失败重传同号会覆盖旧分片
      const retriable =
        err.status === undefined || err.status >= 500 || errorCode === 'CHUNK_CHECKSUM_MISMATCH'
      if (!retriable || attempt >= RETRY_DELAYS.length) throw err

      // 重试前把本片计数清零，否则新旧两条连接的字节会叠加成虚高进度
      onSent?.(0)
      await sleep(RETRY_DELAYS[attempt])
    }
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
 *   100ms 节流；loaded 含在传分片的已发送字节，所以是连续的
 * @param {(session:object) => void} [p.onSession] 会话建立时回调（UI 记 uploadId）
 * @param {() => boolean} [p.shouldPause] 返回 true 时停止调度新分片，
 *   等在传的分片落地后抛 PausedError（不是 AbortError）
 * @param {AbortSignal} [p.signal] 取消上传用，会立刻掐断在传分片
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
  shouldPause,
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

  const total = file.size
  let doneBytes = 0
  const inflight = new Map() // partNumber -> 已发送字节
  let lastEmit = 0

  /**
   * 暂停时用来中断「多余」的在传分片。
   *
   * 不加这个的话，3 个 worker 都卡在 await putPart，每个都要等自己那片传完，
   * 实际等待时间是最慢那片；慢速网络下点暂停要等好几分钟才有反应。
   * 现在的语义是：谁先传完谁留下，剩下的立刻 abort —— 最多等一片，而不是三片。
   */
  const pauseController = new AbortController()
  const partSignal = mergeSignals(signal, pauseController.signal)

  /** 节流上报：XHR 的 progress 触发很密，每帧 setState 会把主线程拖住 */
  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - lastEmit < EMIT_INTERVAL_MS) return
    lastEmit = now
    let sent = 0
    for (const value of inflight.values()) sent += value
    const loaded = Math.min(total, doneBytes + sent)
    const percent = total > 0 ? Math.min(MAX_PERCENT, Math.floor((loaded / total) * 100)) : 0
    onProgress?.(percent, loaded, total)
  }

  // 续传：已完成的分片直接计入
  const done = new Set((session.parts || []).map((p) => Number(p.partNumber)))
  for (const p of session.parts || []) doneBytes += Number(p.size) || 0
  emit(true)

  const pending = []
  for (let n = 1; n <= partCount; n += 1) if (!done.has(n)) pending.push(n)

  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      // 暂停：不再取新片；已经发出去的那片由下面的 await 等它传完
      if (shouldPause?.()) throw new PausedError()
      const partNumber = pending[cursor]
      cursor += 1

      const start = (partNumber - 1) * partSize
      const blob = file.slice(start, Math.min(start + partSize, total))

      inflight.set(partNumber, 0)
      emit()

      try {
        await putPart({
          code,
          uploadId,
          partNumber,
          blob,
          signal: partSignal,
          onSent: (sent) => {
            /**
             * 不能用 max 兜底：重试时旧连接可能已经发到 8 MiB，新连接从 0 开始，
             * 取 max 会让进度卡在旧值上一整个分片的时长。直接覆盖，允许回退
             * 最多一个分片（0.4%），比「不动」好判断得多。
             */
            inflight.set(partNumber, sent)
            emit()
          },
        })
      } catch (err) {
        // 被 pauseController 掐断的：这是暂停，不是用户取消
        if (err?.name === 'AbortError') {
          if (shouldPause?.()) throw new PausedError()
          throw err
        }
        throw err
      }

      inflight.delete(partNumber)
      doneBytes += blob.size
      emit(true)

      // 自己这片已经落地，且收到了暂停请求：手里这一片算数，让其它在传的立刻停
      if (shouldPause?.()) {
        pauseController.abort()
        throw new PausedError()
      }
    }
  }

  const workers = Math.max(1, Math.min(concurrency, pending.length || 1))
  /**
   * 用 allSettled：暂停时第一个跑完的 worker 会 abort 其余在传的，
   * 它们以 AbortError 结束而不是在这里抛出去 —— 全部 settle 才是真的停了。
   */
  const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()))
  const failed = settled.find((r) => r.status === 'rejected')?.reason
  if (failed) throw failed

  // 分片都已落地，剩下是服务端合并 + 登记，进度停在 99 等结果
  onProgress?.(MAX_PERCENT, total, total)

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
  onProgress?.(100, total, total)
  return result
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
