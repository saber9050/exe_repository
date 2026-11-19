import { useEffect, useMemo, useState } from 'react'
import { fetchAudit } from '../../api/admin'
import Badge from '../../components/Badge'
import CopyButton from '../../components/CopyButton'
import EmptyState from '../../components/EmptyState'
import { CircleAlert, Loader, ScrollText, Search } from '../../components/Icons'
import { AUDIT_ACTION_META, formatBytes, formatDateTime, shortSha } from '../../utils/format'

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'upload', label: '上传' },
  { key: 'enable', label: '生效' },
  { key: 'take-down', label: '下架' },
  { key: 'delete', label: '删除' },
  { key: 'download', label: '下载' },
]

/**
 * 一个筛选项对应的底层 action。
 *
 * 两个库的动作名不同但语义同类（上传 / 生效 / 下架 / 删除），
 * 只按 action 字符串精确匹配的话，点「上传」会把依赖库的上传全滤掉，
 * 看起来就像这些记录不属于任何类型。
 */
const ACTION_GROUPS = {
  upload: ['upload', 'dep-upload'],
  enable: ['enable', 'dep-enable', 'dep-enable-version'],
  'take-down': ['take-down', 'dep-take-down'],
  delete: ['delete', 'dep-delete', 'dep-delete-version'],
  download: ['download'],
}

export default function AdminAudit() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    setLoading(true)
    fetchAudit()
      .then((res) => setItems(res.items))
      .catch((err) => setError(err.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const group = ACTION_GROUPS[action]
    return items.filter((a) => {
      if (action !== 'all' && group && !group.includes(a.action)) return false
      if (!kw) return true
      return [a.actor, a.code, a.version, a.sha256].join(' ').toLowerCase().includes(kw)
    })
  }, [items, action, q])

  return (
    <div className="admin-page">
      <div className="admin-toolbar">
        <div className="searchfield">
          <Search size={15} className="searchfield__icon" />
          <input
            className="searchfield__input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按主体、包名、版本或校验码搜索"
          />
        </div>
        <div className="segmented">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`segmented__item ${action === f.key ? 'is-active' : ''}`}
              onClick={() => setAction(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="admin-toolbar__spacer" />
        <span className="admin-toolbar__meta">共 {filtered.length} 条</span>
      </div>

      {error && (
        <div className="alert alert--error">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="apanel apanel--flush">
        <table className="ptable ptable--audit">
          <thead>
            <tr>
              <th>时间</th>
              <th>主体</th>
              <th>操作</th>
              <th>对象</th>
              <th>大小</th>
              <th>校验码</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7}>
                  <div className="apanel__loading">
                    <Loader size={18} className="spin" />
                    加载中…
                  </div>
                </td>
              </tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState compact icon={ScrollText} title="没有匹配的审计记录" />
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((a) => {
                const meta = AUDIT_ACTION_META[a.action] || { label: a.action, tone: 'neutral' }
                return (
                  <tr key={a.id}>
                    <td className="muted nowrap">{formatDateTime(a.at)}</td>
                    <td>{a.actor}</td>
                    <td>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                    <td>
                      <span className="mono ptable__obj">{a.code}</span>
                      {a.version && a.version !== '—' && (
                        <span className="mono muted"> @{a.version}</span>
                      )}
                    </td>
                    <td className="mono muted">{a.size ? formatBytes(a.size) : '—'}</td>
                    <td>
                      {a.sha256 ? (
                        <span className="sha-row">
                          <span className="mono muted">{shortSha(a.sha256)}</span>
                          <CopyButton value={a.sha256} label="" className="icon-copy" size={12} />
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {a.result === 'failed' ? (
                        <span className="audit-fail">
                          <CircleAlert size={13} />
                          失败 {a.errorCode ? `· ${a.errorCode}` : ''}
                        </span>
                      ) : (
                        <span className="audit-ok">成功</span>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <p className="admin-note">
        所有写操作都记进 audit.json：主体 / 包名 / 版本 / sha256 / 大小 / 结果。
        写操作在落盘成功后记账，失败与幂等空操作不留痕；下载审计在流式结束后异步写入，不阻塞返回流。
      </p>
    </div>
  )
}
