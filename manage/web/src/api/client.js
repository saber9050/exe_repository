/**
 * 统一请求层。
 *
 * 所有请求都是同源的：开发期由 Vite 代理到本地服务端，生产期由服务端自己托管，
 * 因此不需要给对象存储配 CORS，也不会有任何 S3 密钥进入浏览器。
 */
import { readValue, removeValue, writeValue } from '../lib/storage'

/**
 * 接口前缀。
 *
 * 独立服务挂在根路径，前缀为空；要挂到子路径下时用 VITE_API_BASE 构建。
 */
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')
const TOKEN_KEY = 'dsh.market.token'

/** 与服务端 MAX_PACKAGE_BYTES 保持一致；服务端仍然会再判一次 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export function getToken() {
  return readValue(TOKEN_KEY) || ''
}

export function setToken(token) {
  if (token) writeValue(TOKEN_KEY, token)
  else removeValue(TOKEN_KEY)
}

function buildQuery(query) {
  if (!query) return ''
  const sp = new URLSearchParams()
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  })
  const str = sp.toString()
  return str ? `?${str}` : ''
}

/** 401 时广播，页面据此回到登录态 */
function emitUnauthorized() {
  setToken('')
  window.dispatchEvent(new CustomEvent('dsh:unauthorized'))
}

function authHeaders() {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function request(path, { method = 'GET', query, body, signal, timeout } = {}) {
  const url = `${BASE}${path}${buildQuery(query)}`
  const headers = { Accept: 'application/json', ...authHeaders() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  // 超时与调用方传入的 signal 合并：任意一个触发都中止请求
  const controller = new AbortController()
  let timedOut = false
  let timer = null
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  if (timeout) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
  }

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (timedOut) {
      throw new ApiError(0, `请求超时（${Math.round(timeout / 1000)} 秒），服务端或制品库响应过慢`)
    }
    if (err.name === 'AbortError') throw err
    throw new ApiError(0, '连不上服务端，请确认 npm run server 已启动')
  } finally {
    if (timer) clearTimeout(timer)
  }

  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { message: text }
  }

  if (!res.ok) {
    if (res.status === 401) emitUnauthorized()
    throw new ApiError(res.status, payload?.message || `请求失败（${res.status}）`, payload)
  }
  return payload
}

/**
 * 取二进制（插件包）。
 * 服务端会把对象存储的字节流原样转出来，并在响应头里带上 sha256 供前端核对。
 */
export async function requestBlob(path, { signal } = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, { headers: authHeaders(), signal })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(0, '下载中断，请检查网络后重试')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = `下载失败（${res.status}）`
    try {
      message = JSON.parse(text)?.message || message
    } catch {
      /* 保留默认文案 */
    }
    throw new ApiError(res.status, message)
  }
  const disposition = res.headers.get('content-disposition') || ''
  const matched = disposition.match(/filename="([^"]+)"/)
  return {
    blob: await res.blob(),
    filename: matched ? matched[1] : 'plugin.tgz',
    sha256: res.headers.get('x-checksum-sha256') || '',
    size: Number(res.headers.get('content-length')) || 0,
  }
}
