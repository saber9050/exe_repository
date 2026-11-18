/**
 * 依赖目录：从仓库的 manifest.json 生成下载页的目录项。
 *
 * 数据来源是管理端（exe-release）写入的 `deps/{code}/manifest.json`，
 * 不是 generic 包的元数据 —— 制品文件名被统一压成 .dat 以规避前置链路拦截，
 * 原始文件名、分类、平台、版本状态都只存在于 manifest 里。
 *
 * 可见性口径与管理端保持一致：
 *   资产 status === 'enabled' 才展示；版本 state === 'enabled' 才可下载。
 */

import { listManifests, getManifest } from './gitea.js';

/** 平台口径。key 与管理端 OS_LIST 一致。 */
export const PLATFORMS = {
  win7: { key: 'win7', os: 'windows', label: 'Windows 7' },
  win10: { key: 'win10', os: 'windows', label: 'Windows 10+' },
  macos: { key: 'macos', os: 'macos', label: 'macOS' },
  linux: { key: 'linux', os: 'linux', label: 'Linux' },
};

/** 分类口径。与管理端 CATEGORIES 保持同一份。 */
const CATEGORY_LABEL = {
  installer: '安装包',
  runtime: '运行时',
  patch: '补丁',
};

/**
 * 旧数据的平台别名。管理端早期只有笼统的 windows，
 * 现在拆成 win7 / win10 两档，历史资产按 win10 处理，重新编辑 manifest 才会真正区分。
 */
const OS_ALIAS = { windows: 'win10' };

function fileNameOf(version) {
  const file = (version?.files || [])[0];
  return {
    name: file?.name || '',
    storageName: file?.storageName || file?.path?.split('/').pop() || '',
    size: Number(file?.size ?? version?.totalSize ?? 0),
  };
}

function downloadUrl(code, version) {
  return `/client/deps/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}/download`;
}

/** 版本号比较（降序）：1.1.1 排在 1.0.2 前面，与上传时间无关。 */
function compareVersionDesc(a, b) {
  const parse = (input) => {
    const raw = String(input || '0.0.0').split('+')[0];
    const dash = raw.indexOf('-');
    const core = dash === -1 ? raw : raw.slice(0, dash);
    const pre = dash === -1 ? '' : raw.slice(dash + 1);
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { major: nums[0] || 0, minor: nums[1] || 0, patch: nums[2] || 0, pre };
  };
  const x = parse(a);
  const y = parse(b);
  if (x.major !== y.major) return y.major - x.major;
  if (x.minor !== y.minor) return y.minor - x.minor;
  if (x.patch !== y.patch) return y.patch - x.patch;
  if (x.pre && !y.pre) return 1;
  if (!x.pre && y.pre) return -1;
  return String(y.pre).localeCompare(String(x.pre));
}

/** 只认已启用版本，版本号高的排前面。 */
function enabledVersions(manifest) {
  return (manifest.versions || [])
    .filter((v) => v.state === 'enabled')
    .sort((a, b) => compareVersionDesc(a.version, b.version));
}

/** 把一份 manifest 展开成目录项：os × arch 的每种组合各一条。 */
function toItems(manifest) {
  if (manifest.status !== 'enabled') return [];

  const versions = enabledVersions(manifest);
  if (versions.length === 0) return [];

  /**
   * 推荐版本 = 版本号最高的已启用版本，不看管理端的 currentVersion。
   * 管理端的「当前版本」是给内部回滚用的，对外下载页永远推最新的那个。
   */
  const latest = versions[0];
  const file = fileNameOf(latest);
  const category = manifest.category || '';
  const platforms = [];
  for (const raw of manifest.os || []) {
    const key = OS_ALIAS[raw] || raw;
    if (PLATFORMS[key] && platforms.indexOf(key) === -1) platforms.push(key);
  }
  const arches = (manifest.arch || []).filter(Boolean);
  if (platforms.length === 0 || arches.length === 0) return [];

  const items = [];
  for (const platformKey of platforms) {
    const p = PLATFORMS[platformKey];
    for (const arch of arches) {
      items.push({
        code: manifest.code,
        key: `${manifest.code}@${platformKey}@${arch}`,
        platform: p.key,
        platform_label: p.label,
        os: p.os,
        arch,
        name: manifest.displayName || manifest.code,
        description: manifest.description || '',
        category,
        category_label: CATEGORY_LABEL[category] || category,
        tags: Array.isArray(manifest.tags) ? manifest.tags : [],
        version: latest.version,
        file_name: file.name,
        size: file.size,
        updated_at: latest.publishedAt || manifest.updatedAt || null,
        download_url: downloadUrl(manifest.code, latest.version),
        versions: versions.map((v) => ({
          version: v.version,
          created_at: v.publishedAt || null,
          changelog: v.changelog || '',
          file_name: fileNameOf(v).name,
          download_url: downloadUrl(manifest.code, v.version),
          is_latest: v.version === latest.version,
        })),
      });
    }
  }
  return items;
}

let cache = { at: 0, items: [] };
const TTL = 15_000;

export async function getCatalog({ q = '', os = '', arch = '', platform = '', refresh = false } = {}) {
  const now = Date.now();
  if (refresh || now - cache.at > TTL) {
    const items = [];
    try {
      const manifests = await listManifests();
      for (const manifest of manifests) {
        items.push(...toItems(manifest));
      }
      items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    } catch (err) {
      // 仓库不可读时别把已有缓存冲掉，返回上一次结果比空白页好
      console.error('[catalog] 读取 manifest 失败:', err.message);
      if (cache.items.length === 0) throw err;
      return { items: cache.items, updated_at: new Date(cache.at).toISOString() };
    }
    cache = { at: now, items };
  }

  let items = cache.items;
  if (os && os !== 'all') items = items.filter((i) => i.os === os);
  if (arch && arch !== 'all') items = items.filter((i) => i.arch === arch);
  if (platform && platform !== 'all') items = items.filter((i) => i.platform === platform);
  if (q) {
    const kw = String(q).toLowerCase();
    items = items.filter(
      (i) =>
        i.code.toLowerCase().includes(kw) ||
        i.name.toLowerCase().includes(kw) ||
        i.description.toLowerCase().includes(kw) ||
        i.category_label.toLowerCase().includes(kw) ||
        i.platform_label.toLowerCase().includes(kw) ||
        i.tags.some((t) => String(t).toLowerCase().includes(kw)),
    );
  }
  return { items, updated_at: new Date(cache.at).toISOString() };
}

/**
 * 下载前校验：资产必须启用、版本必须启用，且能拿到存储名。
 * 平台/架构参数在这个模型下不参与定位（一个资产对应一套平台声明），
 * 保留入参只是为了兼容旧链接。
 */
export async function findVersion(code, version) {
  const manifest = await getManifest(code);
  if (!manifest) return null;
  if (manifest.status !== 'enabled') return null;

  const row = (manifest.versions || []).find((v) => v.version === version);
  if (!row || row.state !== 'enabled') return null;

  const file = fileNameOf(row);
  if (!file.storageName) return null;

  return {
    code,
    version,
    fileName: file.name,
    storageName: file.storageName,
    size: file.size,
  };
}
