import type { Dependency } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { IconCheck, IconDownload, IconPackage, IconPlatform } from './Icons';

export type DownloadState = {
  status: 'idle' | 'running' | 'done' | 'error';
  loaded: number;
  total: number | null;
};

type Props = {
  item: Dependency;
  state?: DownloadState;
  onDownload: (item: Dependency, version?: string) => void;
  onShowVersions: (item: Dependency) => void;
};

const CATEGORY_CLASS: Record<string, string> = {
  runtime: 'cat-runtime',
  driver: 'cat-driver',
  patch: 'cat-patch',
  tool: 'cat-tool',
};

export function DependencyCard({ item, state, onDownload, onShowVersions }: Props) {
  const running = state?.status === 'running';
  const percent =
    running && state?.total ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : null;

  return (
    <article className="card">
      <div className="card__top">
        <div className={`card__icon ${CATEGORY_CLASS[item.category] || 'cat-runtime'}`}>
          <IconPackage size={22} />
        </div>
        <div className="card__title">
          <h3>{item.name}</h3>
          <code className="card__code">{item.code}</code>
        </div>
        <div className="card__badges">
          <span className={`tag tag--platform platform-${item.platform}`}>{item.platform_label}</span>
          <span className={`tag tag--arch arch-${item.arch}`}>{item.arch}</span>
        </div>
      </div>

      {item.description && <p className="card__desc">{item.description}</p>}

      <div className="card__tags">
        <span className="tag tag--ghost">{item.category_label}</span>
        {item.tags
          .filter((t) => t !== item.category_label)
          .map((t) => (
            <span className="tag tag--ghost" key={t}>
              {t}
            </span>
          ))}
      </div>

      <dl className="card__meta">
        <div>
          <dt>最新版本</dt>
          <dd className="mono">v{item.version}</dd>
        </div>
        <div>
          <dt>文件大小</dt>
          <dd className="mono">{formatBytes(item.size)}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd className="mono">{formatDate(item.updated_at)}</dd>
        </div>
      </dl>

      <div className="card__foot">
        <span className={`platform platform-${item.platform}`}>
          <IconPlatform os={item.os} size={15} />
          {item.platform_label}
        </span>

        <div className="card__actions">
          {item.versions.length > 1 && (
            <button type="button" className="btn btn--ghost" onClick={() => onShowVersions(item)}>
              版本
              <span className="btn__count">{item.versions.length}</span>
            </button>
          )}

          <button
            type="button"
            className="btn btn--primary"
            disabled={running}
            onClick={() => onDownload(item)}
          >
            {running ? (
              <>
                <span className="spinner" />
                {percent !== null ? `${percent}%` : formatBytes(state?.loaded ?? 0)}
              </>
            ) : state?.status === 'done' ? (
              <>
                <IconCheck size={16} />
                已下载
              </>
            ) : (
              <>
                <IconDownload size={16} />
                下载
              </>
            )}
          </button>
        </div>
      </div>

      {running && (
        <div className="card__progress">
          <span style={{ width: `${percent ?? 8}%` }} />
        </div>
      )}
    </article>
  );
}
