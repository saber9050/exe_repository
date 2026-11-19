/** 依赖库接口：与插件库共用同一套 Bearer 会话与请求层 */
import { ApiError, getToken, request } from './client'

/** 服务端没返回上限时的兜底值，与 server/lib/config.js 的默认值一致 */
export const DEP_MAX_BYTES = 2 * 1024 * 1024 * 1024

export function fetchDepMeta(signal) {
  return request('/server/deps/meta', { signal })
}

export function fetchDepStats(signal) {
  return request('/server/deps/stats', { signal })
}

export function fetchDeps(params = {}, signal) {
  return request('/server/deps', {
    query: { q: params.q || '', status: params.status || 'all', category: params.category || 'all' },
    signal,
  })
}

export function fetchDep(code, signal) {
  return request(`/server/deps/${encodeURIComponent(code)}`, { signal })
}

export function createDep(payload) {
  return request('/server/deps', { method: 'POST', body: payload })
}

export function updateDep(code, payload) {
  return request(`/server/deps/${encodeURIComponent(code)}`, { method: 'PUT', body: payload })
}

export function enableDepVersion(code, version) {
  return request(
    `/server/deps/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}/enable`,
    { method: 'POST' },
  )
}

export function enableDep(code) {
  return request(`/server/deps/${encodeURIComponent(code)}/enable`, { method: 'POST' })
}

export function disableDep(code) {
  return request(`/server/deps/${encodeURIComponent(code)}/disable`, { method: 'POST' })
}

export function disableDepVersion(code, version) {
  return request(
    `/server/deps/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}/disable`,
    { method: 'POST' },
  )
}

export function deleteDepVersion(code, version) {
  return request(
    `/server/deps/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}`,
    { method: 'DELETE' },
  )
}

export function deleteDep(code) {
  return request(`/server/deps/${encodeURIComponent(code)}`, { method: 'DELETE' })
}

export function takeDownDep(code) {
  return request(`/server/deps/${encodeURIComponent(code)}/take-down`, { method: 'POST' })
}

export function restoreDep(code) {
  return request(`/server/deps/${encodeURIComponent(code)}/restore`, { method: 'POST' })
}

/**
 * 上传制品：XHR 裸流 + 进度。
 *
 * 试过 fetch + ReadableStream 实现「暂停发送」，在有 HTTP 代理的环境下会
 * 报 net::ERR_ALPN_NEGOTIATION_FAILED（代理隧道对流式请求体协商失败），
 * 而开发机基本都开着代理。所以退回 XHR：稳定、能取消，但无法暂停发送，
 * 暂停只能中断、继续时重传。
 */
export function uploadDepVersion({ code, version, file, changelog, onProgress, signal }) {
  const query = new URLSearchParams()
  query.set('version', version)
  query.set('file_name', file.name)
  if (changelog) query.set('changelog', changelog)

  const url = `/server/deps/${encodeURIComponent(code)}/versions?${query.toString()}`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return
      onProgress?.(Math.round((e.loaded / e.total) * 100), e.loaded, e.total)
    }
    xhr.onload = () => {
      let body = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100, file.size, file.size)
        resolve(body)
      } else {
        reject(new ApiError(xhr.status, body?.message || `上传失败（${xhr.status}）`, body))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, '网络中断，上传未完成'))
    xhr.onabort = () => reject(new ApiError(0, '已取消上传'))
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}
