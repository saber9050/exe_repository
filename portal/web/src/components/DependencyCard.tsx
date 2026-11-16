import type { Dependency } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { IconCheck, IconDownload, IconPackage, IconPlatform } from './Icons';

/** 下载交给浏览器原生处理，页面只记「刚点过」这一下，不再维护进度。 */
export type DownloadState = {
  status: 'idle' | 'done';
};

type Props = {
  item: Dependency;
  state?: DownloadState;
  onDownload: (item: Dependency, version?: string) => void;
  onShowVersions: (item: Dependency) => void;
};

const CATEGORY_CLASS: Record<string, string> = {
  installer: 'cat-installer',
  runtime: 'cat-runtime',
  driver: 'cat-driver',
  patch: 'cat-patch',
  other: 'cat-other',
};

export function DependencyCard({ item, state, onDownload, onShowVersions }: Props) {
  const clicked = state?.status === 'done';

  return (
    <article className="card">
      <div className="card__top">
        <div className={`card__icon ${CATEGORY_CLASS[item.category] || 'cat-other'}`}>
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
        <span className={`tag tag--category ${CATEGORY_CLASS[item.category] || 'cat-other'}`}>
          {item.category_label}
        </span>
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

          <a
            className={`btn btn--primary ${clicked ? 'is-clicked' : ''}`}
            href={item.download_url}
            onClick={() => onDownload(item)}
          >
            {clicked ? (
              <>
                <IconCheck size={16} />
                已开始
              </>
            ) : (
              <>
                <IconDownload size={16} />
                下载
              </>
            )}
          </a>
        </div>
      </div>
    </article>
  );
}
