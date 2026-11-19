import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteDep, enableDep, fetchDeps, fetchDepMeta, restoreDep, takeDownDep } from '../../api/deps'
import { useToast } from '../../context/ToastContext'
import Badge from '../../components/Badge'
import ConfirmDialog from '../../components/ConfirmDialog'
import EmptyState from '../../components/EmptyState'
import { Archive, CircleAlert, Eye, Loader, PlusCircle, Refresh, Search } from '../../components/Icons'
import { STATUS_META, formatBytes, timeAgo } from '../../utils/format'

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'enabled', label: '已启用' },
  { key: 'unreleased', label: '待生效' },
  { key: 'taken_down', label: '已下架' },
]

export default function AdminDeps() {
  const { toast } = useToast()
  const [items, setItems] = useState([])
  const [facets, setFacets] = useState({})
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [category, setCategory] = useState('all')
  const [busy, setBusy] = useState('')
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [delTarget, setDelTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    fetchDepMeta()
      .then(setMeta)
      .catch(() => {})
  }, [])

  const load = () => {
    setLoading(true)
    setError('')
    fetchDeps({ q, status, category })
      .then((res) => {
        setItems(res.items)
        setFacets(res.facets || {})
      })
      .catch((err) => setError(err.message || '加载失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    const timer = setTimeout(load, 200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, category])

  const categoryLabel = useMemo(() => {
    const map = {}
    ;(meta?.categories || []).forEach((c) => {
      map[c.key] = c.label
    })
    return map
  }, [meta])

  const onTakeDown = async () => {
    const target = confirmTarget
    if (!target) return
    setBusy(target.code)
    try {
      await takeDownDep(target.code)
      toast(`${target.displayName} 已下架`, 'success')
      setConfirmTarget(null)
      load()
    } catch (err) {
      toast(err.message || '下架失败', 'error')
    } finally {
      setBusy('')
    }
  }

  /** 启用资产：只要版本层面有生效的就能上架，否则后端返回 422。 */
  const onEnable = async (item) => {
    setBusy(item.code)
    try {
      await enableDep(item.code)
      toast(`${item.displayName} 已启用`, 'success')
      load()
    } catch (err) {
      toast(err.message || '启用失败', 'error')
    } finally {
      setBusy('')
    }
  }

  const onRestore = async (item) => {
    setBusy(item.code)
    try {
      await restoreDep(item.code)
      toast(`${item.displayName} 已恢复上架`, 'success')
      load()
    } catch (err) {
      toast(err.message || '恢复失败', 'error')
    } finally {
      setBusy('')
    }
  }

  /** 彻底删除：manifest 与所有版本制品一起清掉，不可恢复。 */
  const onDelete = async () => {
    const target = delTarget
    if (!target) return
    setBusy(target.code)
    setDeleting(true)
    try {
      const res = await deleteDep(target.code)
      toast(`${target.displayName} 已删除，清理 ${res?.removed ?? 0} 个制品文件`, 'success')
      setDelTarget(null)
      load()
    } catch (err) {
      toast(err.message || '删除失败', 'error')
    } finally {
      setBusy('')
      setDeleting(false)
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-toolbar">
        <div className="searchfield">
          <Search size={15} className="searchfield__icon" />
          <input
            className="searchfield__input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标识或名称"
          />
        </div>
        <div className="segmented">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`segmented__item ${status === f.key ? 'is-active' : ''}`}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
              <span className="segmented__count">{facets[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <select
          className="select"
          style={{ width: 132 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="all">全部分类</option>
          {(meta?.categories || []).map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <div className="admin-toolbar__right">
          <button className="btn btn--ghost btn--sm" onClick={load} title="刷新">
            <Refresh size={14} />
          </button>
          <Link to="/admin/deps/new" className="btn btn--primary btn--sm">
            <PlusCircle size={14} />
            登记依赖
          </Link>
        </div>
      </div>

      {error && (
        <div className="alert alert--error">
          <CircleAlert size={16} />
          <div>
            <strong>加载失败</strong>
            <p>{error}</p>
          </div>
          <button className="btn btn--secondary btn--sm" onClick={load}>
            重试
          </button>
        </div>
      )}

      <div className="apanel apanel--flush">
        <table className="ptable">
          <thead>
            <tr>
              <th>依赖</th>
              <th>分类</th>
              <th>平台</th>
              <th>状态</th>
              <th>最新版本</th>
              <th>总大小</th>
              <th>更新</th>
              <th className="ptable__actions-head">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk${i}`}>
                  <td colSpan={8}>
                    <div className="skeleton" style={{ height: 20 }} />
                  </td>
                </tr>
              ))}

            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    compact
                    icon={Archive}
                    title={q || status !== 'all' || category !== 'all' ? '没有匹配的依赖' : '依赖库还是空的'}
                    description={
                      q || status !== 'all' || category !== 'all'
                        ? '换个关键词，或清掉筛选条件。'
                        : '先登记一个资产，再上传 exe、系统组件或补丁。'
                    }
                  />
                </td>
              </tr>
            )}

            {!loading &&
              items.map((item) => {
                const state = STATUS_META[item.status] || STATUS_META.unreleased
                return (
                  <tr key={item.code}>
                    <td>
                      <Link to={`/admin/deps/${item.code}`} className="ptable__name">
                        <span className="depicon">
                          <Archive size={16} />
                        </span>
                        <span className="ptable__name-text">
                          <span className="ptable__display">{item.displayName}</span>
                          <span className="mono ptable__pkg">{item.code}</span>
                        </span>
                      </Link>
                    </td>
                    <td>{categoryLabel[item.category] || item.category}</td>
                    <td className="muted nowrap">
                      {(item.os || []).join(' / ') || '—'}
                      {item.arch?.length ? ` · ${item.arch.join(',')}` : ''}
                    </td>
                    <td>
                      <Badge tone={state.tone} dot>
                        {state.label}
                      </Badge>
                    </td>
                    <td className="mono">{item.currentVersion || '—'}</td>
                    <td className="mono muted">{formatBytes(item.size)}</td>
                    <td className="muted nowrap" title={item.updatedAt}>
                      {timeAgo(item.updatedAt)}
                    </td>
                    <td>
                      <div className="ptable__actions">
                        <Link className="btn btn--ghost btn--sm" to={`/admin/deps/${item.code}`}>
                          <Eye size={13} />
                          详情
                        </Link>
                        {item.status === 'taken_down' ? (
                          <button
                            className="btn btn--secondary btn--sm"
                            disabled={busy === item.code}
                            onClick={() => onRestore(item)}
                          >
                            {busy === item.code ? <Loader size={13} className="spin" /> : null}
                            恢复
                          </button>
                        ) : item.status === 'unreleased' ? (
                          <button
                            className="btn btn--primary btn--sm"
                            disabled={busy === item.code}
                            onClick={() => onEnable(item)}
                            title="对外提供下载，与版本是否生效无关"
                          >
                            {busy === item.code ? <Loader size={13} className="spin" /> : null}
                            启用
                          </button>
                        ) : (
                          <button
                            className="btn btn--ghost btn--sm ptable__danger"
                            disabled={busy === item.code}
                            onClick={() => setConfirmTarget(item)}
                          >
                            下架
                          </button>
                        )}
                        <button
                          className="btn btn--ghost btn--sm ptable__danger"
                          disabled={busy === item.code}
                          onClick={() => setDelTarget(item)}
                          title="删除资产及其全部版本制品，不可恢复"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <p className="admin-note">
        制品走 <code>generic registry</code> 的字节通道，不进 git 历史；只有「已启用」且版本「已生效」才对外提供下载。
      </p>

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        title="确认下架这个依赖？"
        description={
          confirmTarget ? (
            <>
              下架 <strong>{confirmTarget.displayName}</strong> 后，客户端接口会立刻返回
              「资产已下架」。字节与版本都会保留，随时可以恢复上架。
            </>
          ) : null
        }
        confirmText="确认下架"
        busy={Boolean(confirmTarget) && busy === confirmTarget.code}
        onConfirm={onTakeDown}
        onCancel={() => setConfirmTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(delTarget)}
        title="确认彻底删除这个依赖？"
        description={
          delTarget ? (
            <>
              会删除 <strong>{delTarget.displayName}</strong>（<code className="mono">{delTarget.code}</code>）
              及其全部 <strong>{delTarget.versionCount ?? delTarget.versions?.length ?? 0}</strong> 个版本的制品
              （共 {formatBytes(delTarget.size)}），Gitea 里的 manifest 与字节一并清掉。
              下载页会立即不再返回它，<strong>不可恢复</strong>。
              <br />
              请逐字输入资产标识：
              <code className="mono"> {delTarget.code}</code>
            </>
          ) : null
        }
        confirmText="删除并清空制品"
        verifyText={delTarget?.code || ''}
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setDelTarget(null)}
      />
    </div>
  )
}
