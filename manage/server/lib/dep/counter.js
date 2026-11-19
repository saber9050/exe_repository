/**
 * 依赖下载计数。
 *
 * 内存累加 + 4 秒防抖落盘到 <dataDir>/state.json。
 * 只做计数，不记流水：依赖库没有操作审计。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

export function createDepCounter({ dataDir }) {
  const stateFile = path.join(dataDir, 'state.json')
  let counters = null
  let dirty = false
  let flushTimer = null

  async function load() {
    if (counters) return counters
    try {
      const parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
      counters = { downloads: parsed?.downloads || {} }
    } catch {
      counters = { downloads: {} }
    }
    return counters
  }

  async function flush() {
    if (!dirty || !counters) return
    dirty = false
    const tmp = `${stateFile}.${process.pid}.tmp`
    try {
      await fsp.mkdir(dataDir, { recursive: true })
      await fsp.writeFile(tmp, `${JSON.stringify({ downloads: counters.downloads }, null, 2)}\n`, 'utf8')
      await fsp.rename(tmp, stateFile)
    } catch {
      dirty = true
    }
  }

  return {
    async bumpDownload(code) {
      const state = await load()
      state.downloads[code] = Number(state.downloads[code] || 0) + 1
      dirty = true
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          flush().catch(() => {})
        }, 4000)
        if (typeof flushTimer.unref === 'function') flushTimer.unref()
      }
    },

    async counts() {
      const state = await load()
      return state.downloads
    },

    flush,
  }
}
