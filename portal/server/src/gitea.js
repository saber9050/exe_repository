/**
 * Gitea 客户端：读资产清单（manifest）+ 流式转发制品字节。
 *
 * 依赖库的事实来源是仓库里的 manifest.json，不是 generic 包的元数据：
 *   {repo}/{depsDir}/{code}/manifest.json   ← 元数据（分类/平台/版本/原始文件名）
 *   generic package                          ← 只有字节，文件名被压成 .dat
 * 所以目录页必须读 manifest，靠文件名猜平台那套在这里行不通。
 *
 * manifest.json 由管理端（exe-release）写入，结构见那边的 server/lib/dep/manifest.js。
 */

const BASE = (process.env.GITEA_BASE_URL || 'http://47.103.196.145:3000').replace(/\/+$/, '');
const OWNER = process.env.GITEA_OWNER || 'zxp';
const REPO = process.env.GITEA_REPO || 'my-dependency';
const DEPS_DIR = (process.env.GITEA_DEPS_DIR || 'deps').replace(/^\/+|\/+$/g, '');
const BRANCH = process.env.GITEA_BRANCH || 'main';
const TOKEN = process.env.GITEA_TOKEN || '';

const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');

function authHeaders() {
  return TOKEN ? { Authorization: `token ${TOKEN}` } : {};
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', ...authHeaders() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Gitea ${res.status} ${path} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 读单个资产的 manifest；不存在或解析失败返回 null，不打断整体目录。 */
async function readManifest(code) {
  const url =
    `${BASE}/api/v1/repos/${enc(OWNER)}/${enc(REPO)}/raw/` +
    `${enc(`${DEPS_DIR}/${code}/manifest.json`)}?ref=${encodeURIComponent(BRANCH)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...authHeaders() } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 列出全部资产 manifest。
 * 先列 deps 目录拿到 code 列表，再并发读各自的 manifest.json。
 * 目录不存在（还没登记过任何资产）时返回空数组，不报错。
 */
export async function listManifests() {
  let entries;
  try {
    entries = await api(
      `/api/v1/repos/${enc(OWNER)}/${enc(REPO)}/contents/${enc(DEPS_DIR)}?ref=${encodeURIComponent(BRANCH)}`,
    );
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }

  const codes = (Array.isArray(entries) ? entries : [])
    .filter((e) => e.type === 'dir')
    .map((e) => e.name);

  const manifests = await Promise.all(codes.map((code) => readManifest(code)));
  return manifests.filter(Boolean);
}

/** 取某个资产的最新 manifest（下载前校验用）。 */
export async function getManifest(code) {
  return readManifest(code);
}

/**
 * 流式读取制品。透传 Range，让浏览器/客户端能续传。
 * fileName 用 manifest 里的 storageName（.dat），不是用户看到的原始名。
 */
export async function openArtifact(code, version, fileName, range) {
  const url =
    `${BASE}/api/packages/${encodeURIComponent(OWNER)}/generic/` +
    `${encodeURIComponent(code)}/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`;
  const headers = { ...authHeaders() };
  if (range) headers.Range = range;
  return fetch(url, { headers });
}

export const giteaConfig = {
  base: BASE,
  owner: OWNER,
  repo: REPO,
  depsDir: DEPS_DIR,
  authenticated: Boolean(TOKEN),
};
