import { useEffect } from 'react';
import type { Dependency } from '../lib/api';
import { formatDate } from '../lib/format';
import { IconClose, IconDownload } from './Icons';

type Props = {
  item: Dependency | null;
  onClose: () => void;
  onDownload: (item: Dependency, version: string) => void;
};

export function VersionDrawer({ item, onClose, onDownload }: Props) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [item, onClose]);

  if (!item) return null;

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label={`${item.name} 版本列表`}>
      <div className="drawer__mask" onClick={onClose} />
      <aside className="drawer__panel">
        <header className="drawer__head">
          <div>
            <h2>{item.name}</h2>
            <code className="card__code">{item.code}</code>
          </div>
          <button type="button" className="icon-btn icon-btn--lg" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </header>

        <p className="drawer__hint">旧版本保留用于回退，标有「最新」的是推荐版本。</p>

        <ul className="versions">
          {item.versions.map((v) => (
            <li key={v.version} className={`versions__row ${v.is_latest ? 'is-latest' : ''}`}>
              <div className="versions__info">
                <div className="versions__ver">
                  <span className="mono">v{v.version}</span>
                  {v.is_latest && <span className="tag tag--live">最新</span>}
                </div>
                <span className="versions__date">{formatDate(v.created_at)}</span>
              </div>
              <a
                className={`btn ${v.is_latest ? 'btn--primary' : 'btn--ghost'} btn--sm`}
                href={v.download_url}
                onClick={() => onDownload(item, v.version)}
              >
                <IconDownload size={15} />
                下载
              </a>
            </li>
          ))}
        </ul>

        <div className="drawer__foot">
          <div className="field">
            <span className="field__label">文件名</span>
            <code className="mono">{item.file_name}</code>
          </div>
          <div className="field">
            <span className="field__label">适用系统</span>
            <code className="mono">
              {item.platform_label} · {item.arch}
            </code>
          </div>
        </div>
      </aside>
    </div>
  );
}
