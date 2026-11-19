export function formatBytes(bytes, digits = 1) {
  const n = Number(bytes)
  if (!n || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${units[i]}`
}

export function formatCount(n) {
  const num = Number(n) || 0
  if (num >= 10000) return `${(num / 10000).toFixed(1).replace(/\.0$/, '')} 万`
  if (num >= 1000) return num.toLocaleString('zh-CN')
  return String(num)
}

/**
 * 剩余时间：秒数 -> 「1 小时 5 分」「2 分 13 秒」「8 秒」
 * 只保留两级，避免「1 小时 5 分 23 秒」这种读起来费劲的串。
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 1) return '不到 1 秒'
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`
}

export function timeAgo(iso) {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return formatDate(iso)
}

export function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${formatDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function shortSha(sha = '') {
  if (!sha) return '—'
  return `${sha.slice(0, 12)}…${sha.slice(-6)}`
}

export function latestEnabledVersion(plugin) {
  if (!plugin?.versions?.length) return null
  return plugin.versions.find((v) => v.state === 'enabled') || plugin.versions[0]
}

export const TYPE_META = {
  MCP: { label: 'MCP 服务', tone: 'brand', desc: '接入外部系统与工具' },
  Skill: { label: 'Skill 技能', tone: 'purple', desc: '可复用的任务能力' },
  Agent: { label: 'Agent 智能体', tone: 'teal', desc: '端到端的执行角色' },
  Wiki: { label: 'Wiki 知识包', tone: 'warn', desc: '随包分发的知识库' },
}

export const STATUS_META = {
  enabled: { label: '已启用', tone: 'ok' },
  unreleased: { label: '待生效', tone: 'warn' },
  taken_down: { label: '已下架', tone: 'neutral' },
}

export const VERSION_STATE_META = {
  enabled: { label: '可用', tone: 'ok' },
  unreleased: { label: '待生效', tone: 'warn' },
  taken_down: { label: '已下架', tone: 'neutral' },
}

export const AUDIT_ACTION_META = {
  upload: { label: '上传版本', tone: 'brand' },
  enable: { label: '生效', tone: 'ok' },
  'take-down': { label: '下架', tone: 'neutral' },
  register: { label: '登记插件', tone: 'purple' },
  delete: { label: '删除插件', tone: 'danger' },

  // 依赖库动作。下载不产生审计记录，只有计数，所以这里没有 download。

  // 依赖库：与插件库共用同一份 audit.json，action 用 dep- 前缀区分
  'dep-register': { label: '登记资产', tone: 'purple' },
  'dep-update': { label: '改元信息', tone: 'neutral' },
  'dep-upload': { label: '上传制品', tone: 'brand' },
  'dep-enable-version': { label: '版本生效', tone: 'ok' },
  'dep-disable-version': { label: '版本失效', tone: 'warn' },
  'dep-enable': { label: '启用资产', tone: 'ok' },
  'dep-disable': { label: '停用资产', tone: 'warn' },
  'dep-take-down': { label: '下架资产', tone: 'neutral' },
  'dep-restore': { label: '恢复上架', tone: 'teal' },
  'dep-delete-version': { label: '删除版本', tone: 'danger' },
  'dep-delete': { label: '删除资产', tone: 'danger' },
}

/** 审计条目的归属：老记录没有 scope 字段，一律算插件库 */
export const AUDIT_SCOPE_META = {
  plugin: { label: '插件库', tone: 'brand' },
  dep: { label: '依赖库', tone: 'teal' },
}

export const auditScopeOf = (item) => (item?.scope === 'dep' ? 'dep' : 'plugin')
