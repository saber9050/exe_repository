/**
 * 依赖目录。
 *
 * 生产环境这里读 MySQL 的 asset / asset_version（row_kind='main' 且 enabled）。
 * 本地测试版没有 Hub 数据库，直接以 Gitea generic 包为事实来源：
 * 包在 Gitea 上 = 已发布，包的最新版本 = 生效版本。
 *
 * 平台维度：Windows / macOS / Linux，其中 Windows 再分 win7 与 win10+（含 Win11）。
 * 判定顺序是「文件名里的平台与架构标识」→ META 配置 → 默认值，因此上传时按
 *   xxx-win7.exe / xxx-win10.exe / xxx-macos-arm64.dmg / xxx-linux-x64.deb
 * 命名即可自动归位；认不出平台的制品不会进目录。
 */

import { listPackages, listFiles } from './gitea.js';

/** 平台口径。win10 覆盖 Win10 / Win11。 */
export const PLATFORMS = {
  win7: { key: 'win7', os: 'windows', label: 'Windows 7', short: 'Win 7' },
  win10: { key: 'win10', os: 'windows', label: 'Windows 10+', short: 'Win 10+' },
  macos: { key: 'macos', os: 'macos', label: 'macOS', short: 'macOS' },
  linux: { key: 'linux', os: 'linux', label: 'Linux', short: 'Linux' },
};

const DEFAULT_PLATFORM = 'win10';
const DEFAULT_ARCH = 'x64';

/** 展示层元信息。Gitea 里没登记的包会走 fallback，不会因为漏配而消失。 */
const META = {
  'demo-cli': {
    name: 'Demo CLI',
    description: '轻量命令行工具。',
    category: 'tool',
    tags: ['命令行'],
  },
  'runtime-pack': {
    name: '内置运行时组件包',
    description: '运行时组件，可独立更新。',
    category: 'runtime',
    tags: ['运行时'],
  },
};

const CATEGORY_LABEL = {
  runtime: '运行时',
  driver: '驱动',
  patch: '补丁',
  tool: '工具',
};

function metaOf(code) {
  const m = META[code] || {};
  const category = m.category || 'runtime';
  return {
    name: m.name || code,
    description: m.description || '',
    category,
    categoryLabel: CATEGORY_LABEL[category] || '运行时',
    platform: m.platform || DEFAULT_PLATFORM,
    arch: m.arch || DEFAULT_ARCH,
    tags: m.tags || [],
  };
}

/**
 * 从文件名识别平台。认不出返回 null —— 这类文件（插件、说明、校验文件）不进依赖库目录。
 * 注意 .zip 太通用，只有文件名带 mac 字样时才当作 macOS 制品。
 */
export function detectPlatform(fileName, fallback = DEFAULT_PLATFORM) {
  const n = String(fileName).toLowerCase();
  if (/win(dows)?[\s._-]?7\b/.test(n)) return 'win7';
  if (/win(dows)?[\s._-]?(10|11)/.test(n)) return 'win10';
  if (/mac\s?os|osx|darwin/.test(n) || /\.(dmg|pkg)$/.test(n)) return 'macos';
  if (/linux|ubuntu|debian|centos|fedora|rocky/.test(n) || /\.(deb|rpm|appimage)$/.test(n) || /\.tar\.gz$/.test(n)) {
    return 'linux';
  }
  if (/\.exe$/.test(n)) return /win7/.test(n) ? 'win7' : fallback;
  return null;
}

/** 从文件名识别架构，识别不到用配置兜底。 */
export function detectArch(fileName, fallback = DEFAULT_ARCH) {
  const n = String(fileName).toLowerCase();
  if (/arm64|aarch64/.test(n)) return 'arm64';
  if (/x64|amd64|x86[_-]64/.test(n)) return 'x64';
  if (/(^|[^a-z0-9])(x86|i386|ia32|386)([^a-z0-9]|$)/.test(n)) return 'x86';
  return fallback;
}

function downloadUrl(code, version, platform, arch) {
  const params = new URLSearchParams({ platform, arch });
  return `/client/deps/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}/download?${params}`;
}

/** 版本号比较：优先按数字段，非数字段退回字符串比较。 */
function compareVersion(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Gitea 的 list 接口按「包 + 版本」逐行返回，这里按包名聚合并倒序。 */
function groupByPackage(pkgs) {
  const map = new Map();
  for (const pkg of pkgs) {
    if (!map.has(pkg.name)) map.set(pkg.name, []);
    map.get(pkg.name).push(pkg);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const byTime = new Date(b.created_at || 0) - new Date(a.created_at || 0);
      if (byTime !== 0) return byTime;
      return compareVersion(b.version, a.version);
    });
  }
  return map;
}

/** 把一个版本里的制品按「平台 @ 架构」分组，同一组合多个文件取体积最大的。 */
function groupByTarget(files, meta) {
  const map = new Map();
  for (const f of files) {
    const platform = detectPlatform(f.name, meta.platform);
    if (!platform) continue;
    const arch = detectArch(f.name, meta.arch);
    const key = `${platform}@${arch}`;
    const prev = map.get(key);
    if (!prev || f.size > prev.file.size) map.set(key, { platform, arch, file: f });
  }
  return map;
}

/** 一个包的每个「平台 @ 架构」各出一条目录项。 */
async function buildItems(code, versions) {
  const meta = metaOf(code);

  // 逐版本查一次文件清单，才能让版本列表只出现真正含该平台构建的版本，
  // 不给用户点到必然 404 的旧版本。生产环境这些信息来自 asset_version，没有额外请求。
  const perVersion = await Promise.all(
    versions.map(async (v) => {
      const files = await listFiles(code, v.version).catch(() => []);
      return { ...v, targets: groupByTarget(files, meta) };
    }),
  );

  const latest = perVersion[0];
  const items = [];

  for (const [key, { platform, arch, file }] of latest.targets) {
    const p = PLATFORMS[platform];
    items.push({
      code,
      key: `${code}@${key}`,
      platform: p.key,
      platform_label: p.label,
      os: p.os,
      arch,
      name: meta.name,
      description: meta.description,
      category: meta.category,
      category_label: meta.categoryLabel,
      tags: meta.tags,
      version: latest.version,
      file_name: file.name,
      size: file.size,
      sha256: file.sha256,
      updated_at: latest.created_at || null,
      download_url: downloadUrl(code, latest.version, platform, arch),
      versions: perVersion
        .filter((v) => v.targets.has(key))
        .map((v) => ({
          version: v.version,
          created_at: v.created_at || null,
          download_url: downloadUrl(code, v.version, platform, arch),
          is_latest: v.version === latest.version,
        })),
    });
  }
  return items;
}

let cache = { at: 0, items: [] };
const TTL = 15_000;

export async function getCatalog({ q = '', os = '', arch = '', platform = '', refresh = false } = {}) {
  const now = Date.now();
  if (refresh || now - cache.at > TTL) {
    const groups = groupByPackage(await listPackages());
    const items = [];
    for (const [code, versions] of groups) {
      try {
        items.push(...(await buildItems(code, versions)));
      } catch (err) {
        console.error(`[catalog] 跳过 ${code}:`, err.message);
      }
    }
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    cache = { at: now, items };
  }

  let items = cache.items;
  if (os && os !== 'all') items = items.filter((i) => i.os === os);
  if (arch && arch !== 'all') items = items.filter((i) => i.arch === arch);
  if (platform && platform !== 'all') items = items.filter((i) => i.platform === platform);
  if (q) {
    const kw = q.toLowerCase();
    items = items.filter(
      (i) =>
        i.code.toLowerCase().includes(kw) ||
        i.name.toLowerCase().includes(kw) ||
        i.description.toLowerCase().includes(kw) ||
        i.platform_label.toLowerCase().includes(kw) ||
        i.tags.some((t) => t.toLowerCase().includes(kw)),
    );
  }
  return { items, updated_at: new Date(cache.at).toISOString() };
}

/** 下载前校验：版本存在，且该版本里有对应平台 + 架构的制品。 */
export async function findVersion(code, version, platform, arch) {
  let files;
  try {
    files = await listFiles(code, version);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  const targets = groupByTarget(files, metaOf(code));
  const key = platform && arch ? `${platform}@${arch}` : null;
  const hit = key ? targets.get(key) : [...targets.values()].sort((a, b) => b.file.size - a.file.size)[0];
  if (!hit) return null;
  return { code, version, fileName: hit.file.name, size: hit.file.size, sha256: hit.file.sha256 };
}
