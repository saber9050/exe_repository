/**
 * 配置加载。
 *
 * 顺序：进程环境变量 > server/.env
 * 只做最朴素的一层解析，避免为了几个变量再装一个 dotenv。
 *
 * 这是依赖库管理端的独立服务，仓库根就是 server/ 自己，前端产物在 ../web/dist。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** server/ 目录（本文件在 server/lib/ 下） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

loadEnvFile(path.join(ROOT, '.env'))

const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback
  return String(v).toLowerCase() !== 'false'
}

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

export const config = {
  // 下载端 portal 默认 8787，管理端错开
  port: num(process.env.PORT, 8788),
  distDir: path.resolve(ROOT, '../web/dist'),

  // 管理端账号（平台账号，与对象存储的 key 无关；S3 凭据只存在于服务端）
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'dsh@2026',
  adminName: process.env.ADMIN_NAME || '平台管理员',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  sessionTtlSeconds: num(process.env.SESSION_TTL_SECONDS, 12 * 3600),

  auditLimit: num(process.env.AUDIT_LIMIT, 200),
  // 目录索引的缓存时间。写入会由本进程立即失效，这里的 TTL 只影响「别人直接改存储」
  // 何时被看到；别设太小，否则每个请求都在重新扫 manifest。
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 30000),

  /* ---------------- 对象存储 ---------------- */

  minio: {
    endpoint: (process.env.MINIO_ENDPOINT || '127.0.0.1').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    port: num(process.env.MINIO_PORT, 9000),
    useSsl: bool(process.env.MINIO_USE_SSL, false),
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || '',
    bucket: process.env.MINIO_BUCKET || 'dep-artifacts',
    region: process.env.MINIO_REGION || 'us-east-1',
    // 桶内额外前缀，留空表示 deps/ 与 meta/ 直接在桶根
    prefix: (process.env.MINIO_PREFIX || '').replace(/^\/+|\/+$/g, ''),
    // 桶不存在时自动创建（默认私有，不挂任何匿名策略）
    autoCreateBucket: bool(process.env.MINIO_AUTO_CREATE_BUCKET, true),
    // 中断的分片多久后由存储侧自动清理；0 表示不配这条生命周期规则
    abortIncompleteDays: num(process.env.MINIO_ABORT_INCOMPLETE_DAYS, 1),
  },

  /* ---------------- 依赖库 ---------------- */

  // manifest 写 meta/ 前缀，制品写 deps/ 前缀；本地不落任何状态。
  // 唯一硬上限是 10000 片 × partSize，所以放到 20 GiB 很安全。
  depMaxFileBytes: num(process.env.DEP_MAX_FILE_BYTES, 20 * GiB),

  /* ---------------- 分片上传 ---------------- */

  // 单片大小。S3 下限 5 MiB，这里取 8 MiB 留余量；客户端可要求更大，服务端取 max。
  depPartSize: num(process.env.DEP_PART_SIZE, 8 * MiB),
  depMaxParts: num(process.env.DEP_MAX_PARTS, 10000),
  // 会话有效期，过期后分片被 Abort
  depUploadTtlHours: num(process.env.DEP_UPLOAD_TTL_HOURS, 24),
  // chunk：逐片校验；full：完成后再全量复算；none：只校验大小
  depVerifyMode: (() => {
    const mode = String(process.env.DEP_VERIFY_MODE || 'chunk').toLowerCase()
    return ['chunk', 'full', 'none'].includes(mode) ? mode : 'chunk'
  })(),
  // 小于此值前端走单请求直传，省两次往返
  depChunkedThreshold: num(process.env.DEP_CHUNKED_THRESHOLD, 32 * MiB),
}

export function assertConfig() {
  const missing = []
  if (!config.minio.accessKey) missing.push('MINIO_ACCESS_KEY')
  if (!config.minio.secretKey) missing.push('MINIO_SECRET_KEY')
  if (!config.minio.bucket) missing.push('MINIO_BUCKET')
  if (!missing.length) return

  throw new Error(
    [
      `缺少配置：${missing.join(', ')}`,
      `需要指向一个可用的 MinIO（${config.minio.endpoint}:${config.minio.port}）。`,
      '在 MinIO 控制台「Access Keys」建一对密钥，桶上按前缀授权后填进 server/.env：',
      '  MINIO_ENDPOINT=127.0.0.1   MINIO_PORT=9000   MINIO_USE_SSL=false',
      '  MINIO_ACCESS_KEY=...       MINIO_SECRET_KEY=...',
      '  MINIO_BUCKET=dep-artifacts',
    ].join('\n'),
  )
}
