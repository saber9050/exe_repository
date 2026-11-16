export type Platform = 'win7' | 'win10' | 'macos' | 'linux';
export type Os = 'windows' | 'macos' | 'linux';

export type DependencyVersion = {
  version: string;
  created_at: string;
  download_url: string;
  is_latest: boolean;
};

export type Dependency = {
  code: string;
  /** code@platform@arch，同一组件的不同平台构建用这个区分 */
  key: string;
  platform: Platform;
  platform_label: string;
  os: Os;
  name: string;
  description: string;
  category: 'runtime' | 'driver' | 'patch' | 'tool';
  category_label: string;
  tags: string[];
  arch: string;
  version: string;
  file_name: string;
  size: number;
  sha256: string | null;
  updated_at: string | null;
  download_url: string;
  versions: DependencyVersion[];
};

export type CatalogResponse = {
  items: Dependency[];
  updated_at: string;
};

export async function fetchCatalog(params?: {
  q?: string;
  os?: string;
  arch?: string;
  platform?: string;
  refresh?: boolean;
}): Promise<CatalogResponse> {
  const search = new URLSearchParams();
  if (params?.q) search.set('q', params.q);
  if (params?.os) search.set('os', params.os);
  if (params?.arch) search.set('arch', params.arch);
  if (params?.platform) search.set('platform', params.platform);
  if (params?.refresh) search.set('refresh', '1');

  const res = await fetch(`/client/deps/catalog?${search.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: '请求失败' }));
    throw new Error(body.message || `请求失败（${res.status}）`);
  }
  return res.json();
}
