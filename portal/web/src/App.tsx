import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCatalog, type CatalogResponse, type Dependency } from './lib/api';

import { DependencyCard, type DownloadState } from './components/DependencyCard';
import { VersionDrawer } from './components/VersionDrawer';
import { IconSearch, IconShield } from './components/Icons';

const EMPTY: DownloadState = { status: 'idle' };

const CATEGORY_ORDER = ['installer', 'runtime', 'driver', 'patch', 'other'];

const PLATFORM_FILTERS = [
  { key: 'all', label: '全部系统' },
  { key: 'win7', label: 'Windows 7' },
  { key: 'win10', label: 'Windows 10+' },
  { key: 'macos', label: 'macOS' },
  { key: 'linux', label: 'Linux' },
];

const ARCH_OPTIONS = [
  { value: 'x64', label: 'x64（64 位）' },
  { value: 'x86', label: 'x86（32 位）' },
  { value: 'arm64', label: 'arm64' },
];

export default function App() {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [platform, setPlatform] = useState('all');
  const [arch, setArch] = useState('');
  const [drawerItem, setDrawerItem] = useState<Dependency | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchCatalog(refresh ? { refresh: true } : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : '目录加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const notify = useCallback((type: 'ok' | 'err', text: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ type, text });
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  /**
   * 下载由 <a href> 交给浏览器原生处理，下载任务归浏览器管，刷新页面不中断。
   * 这里只做「刚点过」的视觉反馈，不介入下载本身。
   */
  const startDownload = useCallback(
    (item: Dependency, version?: string) => {
      const ver = version || item.version;
      const key = `${item.key}@${ver}`;

      setDownloads((prev) => ({ ...prev, [key]: { status: 'done' } }));
      notify('ok', `已开始下载 ${item.file_name}`);

      window.setTimeout(() => {
        setDownloads((prev) => ({ ...prev, [key]: EMPTY }));
      }, 2500);
    },
    [notify],
  );

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return items.filter((i) => {
      if (category !== 'all' && i.category !== category) return false;
      if (platform !== 'all' && i.platform !== platform) return false;
      if (arch && i.arch !== arch) return false;
      if (!kw) return true;
      return (
        i.name.toLowerCase().includes(kw) ||
        i.code.toLowerCase().includes(kw) ||
        i.description.toLowerCase().includes(kw) ||
        i.platform_label.toLowerCase().includes(kw) ||
        i.tags.some((t) => t.toLowerCase().includes(kw))
      );
    });
  }, [items, category, platform, arch, query]);

  /** 分类按实际数据生成，不出现点了必然为空的筛选项。 */
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    items.forEach((i) => seen.set(i.category, i.category_label));
    const list = [...seen.entries()]
      .sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))
      .map(([key, label]) => ({ key, label }));
    return list.length > 1 ? [{ key: 'all', label: '全部类型' }, ...list] : [];
  }, [items]);

  /** 架构选项固定列出三档，32 位不因为暂时没有制品而从下拉里消失。 */
  const showArchFilter = items.length > 0;

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden />

      <header className="topbar">
        <div className="brand">
          <div className="brand__mark">
            <IconShield size={20} />
          </div>
          <div className="brand__text">
            <span className="brand__name">公共资源中心</span>
            <span className="brand__sub">依赖库</span>
          </div>
        </div>
      </header>

      <main>
        <section className="hero">
          <span className="eyebrow">WINDOWS · MACOS · LINUX</span>
          <h1>
            运行时依赖<span className="hero__accent">下载中心</span>
          </h1>
          <p className="hero__desc">
            按系统选择对应构建：Windows 7、Windows 10 及以上、macOS、Linux，下载即用。
          </p>
        </section>

        <section className="toolbar">
          <div className="search">
            <IconSearch size={17} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索组件名称或关键词"
              aria-label="搜索组件"
            />
            {query && (
              <button type="button" className="search__clear" onClick={() => setQuery('')}>
                清除
              </button>
            )}
          </div>

          <div className="segmented" role="group" aria-label="系统平台">
            {PLATFORM_FILTERS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={platform === p.key ? 'is-active' : ''}
                onClick={() => setPlatform(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {categories.length > 0 && (
            <>
              <span className="toolbar__sep" aria-hidden />
              <div className="chips">
                {categories.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`chip ${category === c.key ? 'is-active' : ''}`}
                    onClick={() => setCategory(c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="toolbar__right">
            {showArchFilter && (
              <label className="select">
                <select value={arch} onChange={(e) => setArch(e.target.value)} aria-label="架构筛选">
                  <option value="">全部架构</option>
                  {ARCH_OPTIONS.map((a) => (
                    <option value={a.value} key={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="icon-text" onClick={() => load(true)} disabled={loading}>
              刷新
            </button>
          </div>
        </section>

        {error && (
          <div className="alert">
            <strong>加载失败</strong>
            <span>{error}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => load(true)}>
              重试
            </button>
          </div>
        )}

        {loading ? (
          <section className="grid">
            {[0, 1, 2].map((i) => (
              <div className="card card--skeleton" key={i}>
                <div className="sk sk--icon" />
                <div className="sk sk--line" />
                <div className="sk sk--line sk--short" />
                <div className="sk sk--block" />
              </div>
            ))}
          </section>
        ) : filtered.length > 0 ? (
          <section className="grid">
            {filtered.map((item) => (
              <DependencyCard
                key={item.key}
                item={item}
                state={downloads[`${item.key}@${item.version}`]}
                onDownload={startDownload}
                onShowVersions={setDrawerItem}
              />
            ))}
          </section>
        ) : (
          <section className="empty">
            <div className="empty__icon">∅</div>
            <h3>{items.length === 0 ? '暂时没有可下载的内容' : '没有匹配的结果'}</h3>
            <p>
              {items.length === 0
                ? '组件正在陆续上架，稍后再来看看。'
                : '换个关键词，或把系统和类型筛回「全部」。'}
            </p>
            {(query || category !== 'all' || platform !== 'all' || arch) && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setQuery('');
                  setCategory('all');
                  setPlatform('all');
                  setArch('');
                }}
              >
                清空筛选
              </button>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <span>© 2026 公共资源中心</span>
      </footer>

      <VersionDrawer item={drawerItem} onClose={() => setDrawerItem(null)} onDownload={startDownload} />

      {toast && (
        <div className={`toast toast--${toast.type}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
