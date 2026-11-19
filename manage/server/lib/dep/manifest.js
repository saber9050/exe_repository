/**
 * 依赖资产模型。
 *
 * 一个资产 = 一个 manifest.json，状态机、版本表、校验和全在里面。
 * 对象存储只存字节，不做任何判定。
 */
import { HttpError } from '../http-error.js'

export const CATEGORIES = [
  { key: 'installer', label: '安装包' },
  { key: 'runtime', label: '运行时' },
  { key: 'patch', label: '补丁' },
]

export const OS_LIST = [
  { key: 'win7', label: 'Windows 7' },
  { key: 'win10', label: 'Windows 10+' },
  { key: 'macos', label: 'macOS' },
  { key: 'linux', label: 'Linux' },
]

export const ARCH_LIST = [
  { key: 'x64', label: 'x64（64 位）' },
  { key: 'x86', label: 'x86（32 位）' },
  { key: 'arm64', label: 'arm64' },
]

export const ASSET_STATES = ['unreleased', 'enabled', 'taken_down']

const CODE_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export const nowIso = () => new Date().toISOString()

export function assertCode(input) {
  const code = String(input || '').trim().toLowerCase()
  if (!CODE_RE.test(code)) {
    throw new HttpError(422, '资产标识只能是小写字母、数字、点、下划线、连字符，2-40 位')
  }
  return code
}

export function assertVersion(input) {
  const v = String(input || '').trim()
  if (!VERSION_RE.test(v)) throw new HttpError(422, '版本号需符合 semver，例如 1.4.2 / 2.0.0-rc.1')
  return v
}

export function assertCategory(input) {
  const key = String(input || CATEGORIES[0].key).trim()
  if (!CATEGORIES.some((c) => c.key === key)) throw new HttpError(422, '分类不合法')
  return key
}

function pickList(input, allowed, field) {
  if (input === undefined || input === null || input === '') return []
  const list = Array.isArray(input) ? input : [input]
  const out = []
  for (const item of list) {
    const key = String(item).trim().toLowerCase()
    if (!key) continue
    if (!allowed.some((x) => x.key === key)) throw new HttpError(422, `${field} 取值不合法：${item}`)
    if (!out.includes(key)) out.push(key)
  }
  return out
}

export const assertOs = (input) => pickList(input, OS_LIST, 'os')
export const assertArch = (input) => pickList(input, ARCH_LIST, 'arch')

/**
 * 制品在存储里的文件名。
 *
 * 对象存储本身不限扩展名，仍然压平的原因有两条：
 *   1. 前置链路（WAF / 下载防护）会**直接重置**这些扩展名的上传请求
 *      —— .exe .msi .dll .cab .zip .rar .iso .dmg .apk .gz .tar .txt .bin
 *      实测表现是连接被 RST、Empty reply from server，字节都发完了也没响应。
 *      分片上传已经绕开了它（请求体里没有文件名），但预签名直连场景仍会命中。
 *   2. 直连对象存储时，带 .exe 的 key 会让网关/浏览器的下载策略行为不可控。
 *
 * 所以存储名统一压成 .dat，原始文件名另外存在 manifest 的 name 字段，
 * 下载时用 Content-Disposition 的 RFC 5987 形式还原。
 */
export function toStorageFileName(originalName, index = 1) {
  const raw = String(originalName || '').trim()
  const dot = raw.lastIndexOf('.')
  const base = dot > 0 ? raw.slice(0, dot) : raw
  let safeBase = base
    .replace(/[^a-zA-Z0-9._+-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._+-]+|[._+-]+$/g, '')
  // 纯中文名会被整段替换掉，只剩数字或空串，补个可读前缀避免叫 "1.dat"
  if (!safeBase || !/[a-zA-Z]/.test(safeBase)) safeBase = `file-${index}`
  return `${safeBase}.dat`
}

export function createManifest(input, actor, defaultActor) {
  const code = assertCode(input.code)
  const displayName = String(input.displayName || '').trim()
  if (!displayName) throw new HttpError(422, '显示名称必填')
  if (displayName.length > 80) throw new HttpError(422, '显示名称不要超过 80 字')

  const description = String(input.description || '').trim()
  if (description.length > 500) throw new HttpError(422, '描述不要超过 500 字')

  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : []

  return {
    code,
    displayName,
    description,
    category: assertCategory(input.category),
    os: assertOs(input.os),
    arch: assertArch(input.arch),
    tags,
    maintainer: String(input.maintainer || actor || '').trim() || defaultActor || '平台管理员',
    homepage: String(input.homepage || '').trim(),
    status: 'unreleased',
    currentVersion: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    versions: [],
  }
}

export function versionSize(version) {
  return (version?.files || []).reduce((sum, f) => sum + (Number(f.size) || 0), 0)
}

export function assetSize(manifest) {
  return (manifest?.versions || []).reduce((sum, v) => sum + versionSize(v), 0)
}

/**
 * 版本号比较（降序用）：先比 major/minor/patch，再看预发布标签。
 * 1.1.1 > 1.0.2，1.0.0 > 1.0.0-rc.1 —— 版本号小的即使后上传也排在下面。
 */
export function compareVersionsDesc(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa.major !== pb.major) return pb.major - pa.major
  if (pa.minor !== pb.minor) return pb.minor - pa.minor
  if (pa.patch !== pb.patch) return pb.patch - pa.patch
  if (pa.pre && !pb.pre) return 1
  if (!pa.pre && pb.pre) return -1
  return String(pb.pre).localeCompare(String(pa.pre))
}

function parseVersion(input) {
  const raw = String(input || '0.0.0').split('+')[0]
  const dash = raw.indexOf('-')
  const core = dash === -1 ? raw : raw.slice(0, dash)
  const pre = dash === -1 ? '' : raw.slice(dash + 1)
  const nums = core.split('.').map((n) => parseInt(n, 10) || 0)
  return { major: nums[0] || 0, minor: nums[1] || 0, patch: nums[2] || 0, pre }
}

/** 版本列表统一按版本号从高到低，不按上传时间。 */
export function sortVersions(list) {
  return [...(list || [])].sort((a, b) => compareVersionsDesc(a.version, b.version))
}

export function summarize(manifest) {
  const versions = manifest.versions || []
  const current = versions.find((v) => v.version === manifest.currentVersion) || null
  return {
    code: manifest.code,
    displayName: manifest.displayName,
    description: manifest.description,
    category: manifest.category,
    os: manifest.os || [],
    arch: manifest.arch || [],
    tags: manifest.tags || [],
    maintainer: manifest.maintainer,
    homepage: manifest.homepage || '',
    status: manifest.status,
    currentVersion: manifest.currentVersion,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    versionCount: versions.length,
    enabledVersionCount: versions.filter((v) => v.state === 'enabled').length,
    fileCount: versions.reduce((n, v) => n + (v.files || []).length, 0),
    size: assetSize(manifest),
    currentFiles: current ? current.files || [] : [],
  }
}
