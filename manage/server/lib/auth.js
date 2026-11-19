/** 管理端会话：HMAC 签名的轻量 token，不引第三方 JWT 库。 */
import crypto from 'node:crypto'
import { config } from './config.js'

const b64 = (input) => Buffer.from(input).toString('base64url')

function sign(payloadB64) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payloadB64)
    .digest('base64url')
}

export function issueToken(user) {
  const payload = {
    u: user.username,
    n: user.name,
    r: 'admin',
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
  }
  const body = b64(JSON.stringify(payload))
  return `${body}.${sign(body)}`
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = sign(body)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload?.exp || payload.exp * 1000 < Date.now()) return null
  return payload
}

export function login(username, password) {
  const ok =
    String(username || '') === config.adminUser && String(password || '') === config.adminPassword
  if (!ok) return null
  const user = { username: config.adminUser, name: config.adminName, role: 'admin' }
  return { token: issueToken(user), user }
}

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const payload = verifyToken(token)
  if (!payload) {
    res.status(401).json({ message: '登录已过期，请重新登录' })
    return
  }
  req.admin = payload
  next()
}
