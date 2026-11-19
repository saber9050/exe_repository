/**
 * 浏览器侧计算 sha256，作为上传的「期望值」（X-Expected-Sha256）。
 * 依据方案 2.8-C：校验和唯一来源是 Hub 对最终字节的实算结果，
 * 前端算出的值只用于比对，不直接入库。
 */
export async function sha256OfFile(file, onProgress) {
  if (!file) return ''
  if (!globalThis.crypto?.subtle) return ''

  const chunkSize = 4 * 1024 * 1024
  const total = file.size
  if (total <= chunkSize) {
    const buf = await file.arrayBuffer()
    onProgress?.(100)
    return toHex(await crypto.subtle.digest('SHA-256', buf))
  }

  // 分片读取后一次性摘要（文件上限 50MB，内存可控）
  const chunks = []
  for (let offset = 0; offset < total; offset += chunkSize) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, total))
    chunks.push(new Uint8Array(await slice.arrayBuffer()))
    onProgress?.(Math.round((Math.min(offset + chunkSize, total) / total) * 100))
  }
  const merged = new Uint8Array(total)
  let cursor = 0
  chunks.forEach((c) => {
    merged.set(c, cursor)
    cursor += c.length
  })
  return toHex(await crypto.subtle.digest('SHA-256', merged))
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
