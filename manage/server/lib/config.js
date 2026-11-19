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

export const config = {
  // 下载端 portal 默认 8787，管理端错开
  port: num(process.env.PORT, 8788),
  distDir: path.resolve(ROOT, '../web/dist'),

  // Gitea 作为唯一制品存储：资产清单、制品、审计都落在同一个仓库里
  giteaUrl: (process.env.GITEA_URL || 'http://47.103.196.145:3000').replace(/\/+$/, ''),
  giteaToken: process.env.GITEA_TOKEN || '',
  owner: process.env.GITEA_OWNER || '',
  repo: process.env.GITEA_REPO || 'my-dependency',
  branch: process.env.GITEA_BRANCH || 'main',

  // 启动时仓库不存在就自动建（含初始提交与分支）。关掉就得手工建仓并初始化。
  autoCreateRepo: (process.env.GITEA_AUTO_CREATE_REPO || 'true').toLowerCase() !== 'false',
  // 自动建出来的仓库是否私有。默认私有，避免清单被匿名浏览。
  repoPrivate: (process.env.GITEA_REPO_PRIVATE || 'true').toLowerCase() !== 'false',

  // 管理端账号（平台账号，不是 Gitea 账号；Gitea 令牌只存在于服务端）
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'dsh@2026',
  adminName: process.env.ADMIN_NAME || '平台管理员',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  sessionTtlSeconds: num(process.env.SESSION_TTL_SECONDS, 12 * 3600),

  auditLimit: num(process.env.AUDIT_LIMIT, 200),
  // 目录索引的缓存时间。写入会由本进程立即失效，这里的 TTL 只影响「别人直接改仓库」
  // 何时被看到；链路访问 Gitea 一次约 2 秒，别设太小，否则每个请求都在重新扫。
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 30000),
  requestTimeoutMs: num(process.env.GITEA_TIMEOUT_MS, 20000),

  /* ---------------- 依赖库 ---------------- */

  // 只走 Gitea：manifest 写仓库，制品写 generic registry，不落本地磁盘
  // 仅下载计数（state.json）落本地，丢几秒无所谓
  depDataDir: path.resolve(ROOT, process.env.DEP_DATA_DIR || 'data/deps'),
  // 单文件上限，默认 2 GiB
  depMaxFileBytes: num(process.env.DEP_MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024),
  // manifest 在仓库里的目录
  depGiteaDir: (process.env.DEP_GITEA_DIR || 'deps').replace(/^\/+|\/+$/g, ''),
}

export function assertConfig() {
  const missing = []
  if (!config.giteaToken) missing.push('GITEA_TOKEN')
  if (!config.giteaUrl) missing.push('GITEA_URL')
  if (!config.owner) missing.push('GITEA_OWNER')
  if (!config.repo) missing.push('GITEA_REPO')
  if (missing.length) {
    throw new Error(
      [
        `缺少配置：${missing.join(', ')}`,
        '在 Gitea「设置 → 应用 → 生成令牌」创建令牌，至少勾选：',
        '  repository: Read and Write  （写 manifest、读资产清单）',
        '  package:    Read and Write  （依赖制品走 generic registry）',
        `填进 server/.env 后重启。当前目标：${config.owner}/${config.repo}@${config.branch}`,
      ].join('\n'),
    )
  }
}
