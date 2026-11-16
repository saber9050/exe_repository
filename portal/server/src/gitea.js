/**
 * Gitea generic registry 客户端。
 *
 * 只做三件事：列包、取某版本的文件清单、把字节流出去。
 * 判定（enabled / 版本可用 / 下架）不在这里，属于 Hub 的职责。
 *
 * 实测（Gitea 1.22）：
 *   GET /api/v1/packages/{owner}?type=generic          -> 每个包的最新版本一行
 *   GET /api/v1/packages/{owner}/generic/{name}/{ver}/files -> 文件清单，自带 sha256
 *   GET /api/packages/{owner}/generic/{name}/{ver}/{file}   -> 字节，支持 Range（206）
 * 没有「列某包全部版本」的 API，历史版本只能由 Hub 的 asset_version 提供，
 * 本地测试版因此只展示最新版本。
 */

const BASE = (process.env.GITEA_BASE_URL || 'http://47.103.196.145:3000').replace(/\/+$/, '');
const OWNER = process.env.GITEA_OWNER || 'ly';
const TOKEN = process.env.GITEA_TOKEN || '';

function authHeaders() {
  return TOKEN ? { Authorization: `token ${TOKEN}` } : {};
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...authHeaders(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Gitea ${res.status} ${path} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 列出 owner 下全部 generic 包（分页拉全）。返回的是「包 + 其最新版本」。 */
export async function listPackages() {
  const out = [];
  let page = 1;
  for (;;) {
    const batch = await api(
      `/api/v1/packages/${encodeURIComponent(OWNER)}?type=generic&page=${page}&limit=50`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 50) break;
    page += 1;
    if (page > 20) break; // 防御，避免异常分页把服务拖死
  }
  return out;
}

/** 某版本的文件清单。Gitea 的 Size 字段首字母大写，别跟着写成 size。 */
export async function listFiles(name, version) {
  const files = await api(
    `/api/v1/packages/${encodeURIComponent(OWNER)}/generic/` +
      `${encodeURIComponent(name)}/${encodeURIComponent(version)}/files`,
  );
  return (Array.isArray(files) ? files : []).map((f) => ({
    name: f.name,
    size: Number(f.Size ?? f.size ?? 0),
    sha256: f.sha256 || null,
  }));
}

/**
 * 流式读取制品。透传 Range，让浏览器/客户端能续传。
 * 返回的是原始 Response，由调用方 pipe。
 */
export async function openArtifact(name, version, fileName, range) {
  const url =
    `${BASE}/api/packages/${encodeURIComponent(OWNER)}/generic/` +
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`;
  const headers = { ...authHeaders() };
  if (range) headers.Range = range;
  return fetch(url, { headers });
}

export const giteaConfig = { base: BASE, owner: OWNER, authenticated: Boolean(TOKEN) };
