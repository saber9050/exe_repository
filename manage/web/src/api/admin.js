/** 管理端接口：登录、登记、上传、生效、下架、审计 */
import { ApiError, getToken, request } from './client'

export function login(username, password) {
  return request('/server/auth/login', { method: 'POST', body: { username, password } })
}

export function fetchAdminPlugins(params = {}, signal) {
  return request('/server/plugins', {
    query: { q: params.q || '', status: params.status || 'all' },
    signal,
  })
}

export function fetchStats(signal) {
  return request('/server/stats', { signal })
}

export function fetchAudit(signal) {
  return request('/server/audit', { signal })
}

export function registerPlugin(payload) {
  return request('/server/plugins', { method: 'POST', body: payload })
}

export function updateMeta(name, payload) {
  return request(`/server/plugins/${encodeURIComponent(name)}`, { method: 'PUT', body: payload })
}

export function enableVersion(name, version) {
  return request(
    `/server/plugins/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/enable`,
    { method: 'POST' },
  )
}

export function takeDown(name) {
  return request(`/server/plugins/${encodeURIComponent(name)}/take-down`, { method: 'POST' })
}

/**
 * 彻底删除：清单、说明与全部版本制品一起从对象存储删掉，不可恢复。
 * confirm 必须原样传包名，服务端会逐字符比对后才会动手。
 */
export function deletePlugin(name, confirm) {
  return request(`/server/plugins/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    body: { confirm },
  })
}

/**
 * 上传制品：二进制裸流，元数据走查询串。
 * 浏览器先用 sha256 算一遍期望值，服务端边收边算，不一致直接 422；
 * 入库的永远是服务端实算值，前端算的只用于提前发现传输损坏。
 *
 * 用 XHR 而不是 fetch，是因为 fetch 没有上传进度事件。
 */
export function uploadVersion({ name, version, file, sha256, changelog, onProgress }) {
  const query = new URLSearchParams()
  query.set('version', version)
  query.set('file_name', file.name)
  if (changelog) query.set('changelog', changelog)

  const url = `/server/plugins/${encodeURIComponent(name)}/versions?${query.toString()}`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', 'application/gzip')
    if (sha256) xhr.setRequestHeader('X-Expected-Sha256', sha256)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let body = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve(body)
      } else {
        reject(new ApiError(xhr.status, body?.message || `上传失败（${xhr.status}）`, body))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, '网络中断，上传未完成'))
    xhr.ontimeout = () => reject(new ApiError(0, '上传超时'))
    xhr.send(file)
  })
}
