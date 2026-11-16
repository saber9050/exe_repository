export type DownloadProgress = {
  loaded: number;
  total: number | null;
};

const DIRECT_LINK_THRESHOLD = 300 * 1024 * 1024; // 超过 300MB 交给浏览器原生下载，避免页面吃满内存

function triggerBrowserDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 带进度的下载。走同一套 /client/deps 链接，Range 由服务端透传，
 * 超时或中断后重新点击即可续传（服务端支持 206 时不会从头再来）。
 *
 * knownSize 来自 catalog，省掉一次 HEAD——Gitea 的 generic 端点不响应 HEAD。
 */
export async function downloadWithProgress(
  url: string,
  fileName: string,
  knownSize: number,
  onProgress: (p: DownloadProgress) => void,
): Promise<'streamed' | 'native'> {
  if (knownSize > DIRECT_LINK_THRESHOLD) {
    triggerBrowserDownload(url);
    return 'native';
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ message: `下载失败（${res.status}）` }));
    throw new Error(body.message || `下载失败（${res.status}）`);
  }

  const total = Number(res.headers.get('content-length')) || knownSize || null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
  }

  const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return 'streamed';
}
