/**
 * localStorage 的安全包装。
 *
 * 在 sandbox iframe（预览面板）、隐私模式、禁用 Cookie 等环境里，
 * 读写 localStorage 会直接抛 SecurityError。一旦抛在 render 期间，
 * 整个 React 树会被卸载，页面就变成白屏 —— 所以这里统一降级到内存。
 */
const memory = new Map()

function canUseStorage() {
  try {
    const probe = '__dsh_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

const available = typeof window !== 'undefined' && canUseStorage()

export function readValue(key) {
  if (!available) return memory.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

export function writeValue(key, value) {
  memory.set(key, value)
  if (!available) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 配额满或被禁用时只留内存副本 */
  }
}

export function removeValue(key) {
  memory.delete(key)
  if (!available) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* noop */
  }
}
