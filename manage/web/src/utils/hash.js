/**
 * 浏览器侧计算 sha256，作为上传的「期望值」。
 *
 * 完整文件不能一次读进内存：2 GiB 的安装包会直接把 tab 打崩。这里走
 * Worker + hash-wasm 的增量摘要，逐 4 MiB 喂一次，内存恒定，也不卡界面。
 *
 * 依据方案：校验和的唯一来源仍是服务端实算结果，前端算出的值只用于比对。
 */

/** 超过这个大小就必须用 Worker，否则主线程会卡死 */
const INLINE_LIMIT = 8 * 1024 * 1024

/**
 * @param {File} file
 * @param {(percent: number) => void} [onProgress] 0~100
 * @returns {Promise<string>} 小写 hex；算不了时返回空串（调用方按「不校验」处理）
 */
export async function sha256OfFile(file, onProgress) {
  if (!file) return ''
  if (!file.size) return ''

  if (file.size <= INLINE_LIMIT || typeof Worker === 'undefined') {
    return sha256Inline(file, onProgress)
  }

  let worker
  try {
    worker = new Worker(new URL('./hash.worker.js', import.meta.url), { type: 'module' })
  } catch {
    // Worker 起不来（老浏览器 / 严格 CSP）时退回主线程，慢但不阻断上传
    return sha256Inline(file, onProgress)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      worker.terminate()
      resolve(value)
    }

    worker.onmessage = (event) => {
      const msg = event.data || {}
      if (msg.type === 'progress') onProgress?.(msg.percent)
      else if (msg.type === 'done') finish(msg.sha256 || '')
      else if (msg.type === 'error') finish('')
    }
    worker.onerror = () => finish('')

    try {
      worker.postMessage(file)
    } catch {
      finish('')
    }
  })
}

/** 主线程兜底：小文件或 Worker 不可用 */
async function sha256Inline(file, onProgress) {
  try {
    if (globalThis.crypto?.subtle) {
      const buffer = await file.arrayBuffer()
      onProgress?.(100)
      return toHex(await crypto.subtle.digest('SHA-256', buffer))
    }
  } catch {
    /* 落到下面用 wasm */
  }
  try {
    const { createSHA256 } = await import('hash-wasm')
    const hasher = await createSHA256()
    hasher.init()
    const chunk = 4 * 1024 * 1024
    for (let offset = 0; offset < file.size; offset += chunk) {
      const end = Math.min(offset + chunk, file.size)
      hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()))
      onProgress?.(Math.round((end / file.size) * 100))
    }
    return hasher.digest('hex')
  } catch {
    return ''
  }
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
