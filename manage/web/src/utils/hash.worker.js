/**
 * 增量 sha256 Worker。
 *
 * 为什么必须在 Worker 里跑：浏览器 crypto.subtle 不支持流式摘要，只能先
 * arrayBuffer() 再 digest，2 GiB 文件会直接把内存打爆（旧实现就是这么写的，
 * 注释里还留着"文件上限 50MB"的老前提）。hash-wasm 支持 update 逐块喂，
 * 在 Worker 里跑还不会卡住上传界面。
 */
import { createSHA256 } from 'hash-wasm'

const CHUNK = 4 * 1024 * 1024

self.onmessage = async (event) => {
  const file = event.data
  try {
    const hasher = await createSHA256()
    hasher.init()

    const total = file.size
    for (let offset = 0; offset < total; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, total)
      const buffer = await file.slice(offset, end).arrayBuffer()
      hasher.update(new Uint8Array(buffer))
      self.postMessage({ type: 'progress', percent: Math.round((end / total) * 100) })
    }

    self.postMessage({ type: 'done', sha256: hasher.digest('hex') })
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || '校验和计算失败' })
  }
}
