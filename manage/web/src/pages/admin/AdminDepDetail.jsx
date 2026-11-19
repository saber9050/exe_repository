import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  deleteDep,
  enableDep,
  deleteDepVersion,
  disableDepVersion,
  enableDepVersion,
  fetchDep,
  fetchDepMeta,
  restoreDep,
  takeDownDep,
  uploadDepVersion,
} from '../../api/deps'
import { PausedError, abortUploadSession, uploadDepVersionChunked } from '../../api/upload'
import { sha256OfFile } from '../../utils/hash'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import Badge from '../../components/Badge'
import ConfirmDialog from '../../components/ConfirmDialog'
import EmptyState from '../../components/EmptyState'
import {
  Archive,
  CircleAlert,
  Download,
  Loader,
  Refresh,
  Upload,
  X,
} from '../../components/Icons'
import {
  STATUS_META,
  VERSION_STATE_META,
  formatBytes,
  formatDate,
  formatDuration,
  timeAgo,
} from '../../utils/format'

export default function AdminDepDetail() {
  const { code } = useParams()
  const { user } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const [asset, setAsset] = useState(null)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyVersion, setBusyVersion] = useState('')
  const [confirmDown, setConfirmDown] = useState(false)
  const [takingDown, setTakingDown] = useState(false)
  // 删除/失效的确认目标：{ scope: 'asset' } 或 { scope: 'version', version }
  const [delTarget, setDelTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [enabling, setEnabling] = useState(false)

  const [version, setVersion] = useState('')
  const [changelog, setChangelog] = useState('')
  const [file, setFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | hashing | uploading | paused
  const [progress, setProgress] = useState(0)
  const [loaded, setLoaded] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [eta, setEta] = useState(0)
  const [hashState, setHashState] = useState('idle') // idle | running | done
  /** 已请求暂停，正在等在传的分片落地 */
  const [pausing, setPausing] = useState(false)
  const pauseRequestedRef = useRef(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const abortRef = useRef(null)
  const phaseRef = useRef('idle')
  /** sha256 任务：选完文件就开始算，不等点「上传」 */
  const hashJobRef = useRef({ token: 0, file: null, sha256: '', promise: null })
  /** 速率采样：只保留最近 3 秒，用总平均会让速度「只降不升」 */
  const rateRef = useRef({ stage: '', samples: [] })
  /** 速率再做一层指数平滑，避免剩余时间跟着抖动 */
  const smoothRateRef = useRef(0)
  /** 当前分片会话，取消时用来 Abort 掉 S3 分片 */
  const sessionRef = useRef(null)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const load = useCallback(() => {
    setLoading(true)
    return fetchDep(code)
      .then((res) => setAsset(res.asset))
      .catch((err) => {
        toast(err.message || '加载失败', 'error')
        if (err.status === 404) navigate('/admin/deps', { replace: true })
      })
      .finally(() => setLoading(false))
  }, [code, navigate, toast])

  useEffect(() => {
    load()
    fetchDepMeta()
      .then(setMeta)
      .catch(() => {})
  }, [load])

  const maxBytes = meta?.maxFileBytes || 20 * 1024 * 1024 * 1024
  /** 小于阈值的小文件走单请求，省两次往返；其余走分片 */
  const chunkedThreshold = meta?.chunkedThresholdBytes || 32 * 1024 * 1024
  const categoryLabel = (key) =>
    (meta?.categories || []).find((c) => c.key === key)?.label || key

  /**
   * 3 秒滑动窗口的即时速率（B/s）。
   *
   * 用「第一次采样到当前」的平均会让速度只降不升：网络从 2 MB/s 提到 8 MB/s，
   * 显示也不会变。只取最近 3 秒才能反映当下。
   */
  const trackRate = (stage, bytes) => {
    const now = Date.now()
    const rate = rateRef.current
    if (rate.stage !== stage) {
      rate.stage = stage
      rate.samples = []
    }
    rate.samples.push({ t: now, bytes })
    while (rate.samples.length > 2 && now - rate.samples[0].t > 3000) rate.samples.shift()

    const first = rate.samples[0]
    const seconds = (now - first.t) / 1000
    if (seconds < 0.25) return 0

    const instant = Math.max(0, (bytes - first.bytes) / seconds)
    // 指数平滑：新值只占三成，剩余时间不会一秒一个样
    smoothRateRef.current = smoothRateRef.current
      ? smoothRateRef.current * 0.7 + instant * 0.3
      : instant
    return smoothRateRef.current
  }

  /**
   * 算整体 sha256。选完文件就开跑：用户填版本号、写更新说明的这十几秒
   * 里，几 GB 的摘要已经算完了，点上传时能直接进传输。
   */
  const startHash = useCallback((f) => {
    const token = hashJobRef.current.token + 1
    hashJobRef.current.token = token
    hashJobRef.current.file = f
    hashJobRef.current.sha256 = ''
    setHashState('running')
    rateRef.current = { stage: 'hash', samples: [] }
    smoothRateRef.current = 0

    const promise = sha256OfFile(f, (percent, done, total) => {
      if (hashJobRef.current.token !== token) return
      const rate = trackRate('hash', done)
      setProgress(percent)
      setLoaded(done)
      if (rate > 0) {
        setSpeed(rate)
        setEta((total - done) / rate)
      }
    }).then((sha) => {
      if (hashJobRef.current.token !== token) return ''
      hashJobRef.current.sha256 = sha
      setHashState(sha ? 'done' : 'idle')
      setSpeed(0)
      setEta(0)
      // 后台算完了但用户还没点上传，别把进度条留在 100%
      if (phaseRef.current === 'idle') setProgress(0)
      return sha
    })

    hashJobRef.current.promise = promise
    return promise
  }, [])

  const pickFile = (f) => {
    if (!f) return
    setError('')
    if (f.size > maxBytes) {
      setError(`文件 ${formatBytes(f.size)} 超过上限 ${formatBytes(maxBytes)}`)
      return
    }
    setProgress(0)
    setLoaded(0)
    setSpeed(0)
    setEta(0)
    setFile(f)
    startHash(f)
  }

  const runUpload = async () => {
    if (phase === 'uploading' || phase === 'hashing') return
    setError('')
    if (!file) return setError('请选择制品文件')
    if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version.trim())) {
      return setError('版本号需符合 semver，例如 1.4.2')
    }
    if ((asset?.versions || []).some((v) => v.version === version.trim())) {
      return setError('该版本已存在，版本不可覆盖（409）')
    }

    const controller = new AbortController()
    abortRef.current = controller
    pauseRequestedRef.current = false
    setPausing(false)
    const useChunked = file.size > chunkedThreshold

    try {
      /**
       * 整体 sha256 只在需要时算一次：分片模式用它做完整校验，
       * 单请求模式由服务端边收边算（这里只当「期望值」）。
       */
      let sha256 = hashJobRef.current.file === file ? hashJobRef.current.sha256 : ''
      if (useChunked && !sha256) {
        setPhase('hashing')
        setProgress(0)
        setLoaded(0)
        setSpeed(0)
        setEta(0)
        const job = hashJobRef.current.file === file && hashJobRef.current.promise
        sha256 = await (job || startHash(file))
        if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError')
        if (!sha256) {
          setPhase('idle')
          setError('无法计算文件校验和，请换用 Chrome / Edge 后重试')
          return
        }
      }

      setPhase('uploading')
      setProgress(0)
      setLoaded(0)
      setSpeed(0)
      setEta(0)
      rateRef.current = { stage: 'upload', samples: [] }
      smoothRateRef.current = 0

      const handleProgress = (percent, done, totalArg) => {
        const totalBytes = totalArg || file.size
        setProgress(percent)
        setLoaded(done)
        const rate = trackRate('upload', done)
        if (rate > 0) {
          setSpeed(rate)
          setEta(Math.max(0, (totalBytes - done) / rate))
        }
      }

      const res = useChunked
        ? await uploadDepVersionChunked({
            code,
            version: version.trim(),
            file,
            sha256,
            changelog,
            signal: controller.signal,
            onSession: (session) => {
              sessionRef.current = session
            },
            onProgress: handleProgress,
            shouldPause: () => pauseRequestedRef.current,
          })
        : await uploadDepVersion({
            code,
            version: version.trim(),
            file,
            changelog,
            signal: controller.signal,
            onProgress: handleProgress,
          })

      const sha = res?.version?.sha256 || ''
      toast(`上传完成${sha ? `，sha256 ${sha.slice(0, 12)}…` : ''}，等待生效`, 'success')
      setFile(null)
      setVersion('')
      setChangelog('')
      setProgress(0)
      setLoaded(0)
      setSpeed(0)
      setEta(0)
      setHashState('idle')
      setPhase('idle')
      hashJobRef.current = { token: hashJobRef.current.token, file: null, sha256: '', promise: null }
      sessionRef.current = null
      if (inputRef.current) inputRef.current.value = ''
      load()
    } catch (err) {
      if (err.name === 'PausedError') {
        // 软暂停：在传的分片已经落地，进度和会话都保留，点继续能直接接着传
        pauseRequestedRef.current = false
        setPausing(false)
        setSpeed(0)
        setEta(0)
        setPhase('paused')
        return
      }
      if (err.name === 'AbortError' || controller.signal.aborted) {
        // 暂停：保留进度、文件与会话，点「继续」接着传；取消：回到初始态并清掉分片
        // 走到这里只剩「取消」：暂停走的是 PausedError，不会 abort
        if (sessionRef.current?.uploadId) {
          abortUploadSession({ code, uploadId: sessionRef.current.uploadId }).catch(() => {})
        }
        sessionRef.current = null
        toast('已取消上传', 'info')
        setProgress(0)
        setLoaded(0)
        setSpeed(0)
        setEta(0)
        setPhase('idle')
      } else {
        setError(err.message || '上传失败')
        toast(err.message || '上传失败', 'error')
        setProgress(0)
        setLoaded(0)
        setSpeed(0)
        setEta(0)
        setPhase('idle')
      }
    } finally {
      abortRef.current = null
    }
  }

  const submitUpload = (e) => {
    e.preventDefault()
    runUpload()
  }

  const cancelUpload = () => {
    pauseRequestedRef.current = false
    setPausing(false)
    setPhase('idle')
    setProgress(0)
    setLoaded(0)
    setSpeed(0)
    setEta(0)
    abortRef.current?.abort()
  }

  const togglePause = () => {
    if (phase === 'paused') {
      runUpload()
      return
    }
    if (phase !== 'uploading' || pausing) return
    /**
     * 软暂停：不 abort。
     * abort 会掐断正在传的分片，而 S3 里半片无效 —— 暂停时如果一片都没传完，
     * 继续就等于从零开始。这里只置标志，让 worker 在下一个分片边界停下，
     * 已发出去的那几片继续传完再结束。
     */
    pauseRequestedRef.current = true
    setPausing(true)
  }

  const onEnable = async (v) => {
    setBusyVersion(v)
    try {
      await enableDepVersion(code, v)
      toast(`v${v} 已生效`, 'success')
      load()
    } catch (err) {
      toast(err.message || '生效失败', 'error')
    } finally {
      setBusyVersion('')
    }
  }

  const onTakeDown = async () => {
    setTakingDown(true)
    try {
      await takeDownDep(code)
      toast('已下架', 'success')
      setConfirmDown(false)
      load()
    } catch (err) {
      toast(err.message || '下架失败', 'error')
    } finally {
      setTakingDown(false)
    }
  }

  const onRestore = async () => {
    try {
      await restoreDep(code)
      toast('已恢复上架', 'success')
      load()
    } catch (err) {
      toast(err.message || '恢复失败', 'error')
    }
  }

  const onEnableAsset = async () => {
    setEnabling(true)
    try {
      await enableDep(code)
      toast('资产已启用，客户端可以下载已生效版本', 'success')
      load()
    } catch (err) {
      toast(err.message || '启用失败', 'error')
    } finally {
      setEnabling(false)
    }
  }

  const onDisable = async (v) => {
    setBusyVersion(v)
    try {
      await disableDepVersion(code, v)
      toast(`v${v} 已失效，制品仍保留，可重新生效`, 'success')
      load()
    } catch (err) {
      toast(err.message || '失效失败', 'error')
    } finally {
      setBusyVersion('')
    }
  }

  /** 删除确认：资产级删完回列表，版本级删完留在详情页刷新。 */
  const onDelete = async () => {
    if (!delTarget) return
    setDeleting(true)
    try {
      if (delTarget.scope === 'asset') {
        const res = await deleteDep(code)
        toast(`${asset.displayName} 已删除，清理 ${res?.removed ?? 0} 个制品文件`, 'success')
        setDelTarget(null)
        navigate('/admin/deps', { replace: true })
        return
      }
      const res = await deleteDepVersion(code, delTarget.version)
      toast(`v${delTarget.version} 已删除，清理 ${res?.removed ?? 0} 个文件`, 'success')
      setDelTarget(null)
      load()
    } catch (err) {
      toast(err.message || '删除失败', 'error')
    } finally {
      setDeleting(false)
    }
  }

  if (loading && !asset) {
    return (
      <div className="admin-page">
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    )
  }
  if (!asset) return null

  /**
   * 进度信息分三块：
   *   进度条内 —— 只放百分比，字号小、居中，一眼看到大概
   *   左下   —— 阶段 + 已传/总量。整数百分比在慢速网络下几秒才涨 1%，
   *            只有「614 KB / 30.0 MB」这种连续变化的字节数才能让人确信没卡住
   *   右下   —— 速率 + 剩余时间
   */
  const progressView = (() => {
    const rate = speed > 0 ? `${formatBytes(speed)}/s` : ''
    const size = `${formatBytes(loaded)} / ${formatBytes(file?.size || 0)}`
    const remain =
      eta > 0 && Number.isFinite(eta) && eta < 24 * 3600 ? `剩余 ${formatDuration(eta)}` : ''

    if (phase === 'hashing') {
      return {
        label: `${progress}%`,
        left: `计算校验和 · ${size}`,
        right: [rate, remain].filter(Boolean).join(' · '),
      }
    }
    if (phase === 'paused') {
      return {
        label: `${progress}%`,
        left: `已暂停 · ${size}`,
        right: '点「继续」从缺失的分片接着传',
      }
    }
    if (pausing) {
      return {
        label: `${progress}%`,
        left: `正在暂停 · ${size}`,
        right: '等待当前分片写入…',
      }
    }
    if (progress >= 100) return { label: '100%', left: '上传完成', right: '' }
    if (progress >= 99) {
      return {
        label: '99%',
        left: '分片已传完，服务端合并登记中…',
        right: rate,
      }
    }
    return { label: `${progress}%`, left: `上传中 · ${size}`, right: [rate, remain].filter(Boolean).join(' · ') }
  })()

  const state = STATUS_META[asset.status] || STATUS_META.unreleased

  return (
    <div className="admin-page">
      <div className="admin-toolbar">
        <Link to="/admin/deps" className="btn btn--ghost btn--sm">
          返回依赖库
        </Link>
        <span className="mono muted">{asset.code}</span>
        <div className="admin-toolbar__right">
          <button className="btn btn--ghost btn--sm" onClick={load} title="刷新">
            <Refresh size={14} />
          </button>
          {asset.status === 'taken_down' ? (
            <button className="btn btn--secondary btn--sm" onClick={onRestore}>
              <Refresh size={14} />
              恢复上架
            </button>
          ) : asset.status === 'unreleased' ? (
            <button
              className="btn btn--primary btn--sm"
              onClick={onEnableAsset}
              disabled={enabling}
              title="对外提供下载，与版本是否生效无关"
            >
              {enabling ? <Loader size={14} className="spin" /> : <Refresh size={14} />}
              启用资产
            </button>
          ) : (
            <button className="btn btn--ghost btn--sm ptable__danger" onClick={() => setConfirmDown(true)}>
              下架
            </button>
          )}
          <button
            className="btn btn--ghost btn--sm ptable__danger"
            onClick={() => setDelTarget({ scope: 'asset' })}
            title="删除资产及其全部版本制品，不可恢复"
          >
            删除
          </button>
        </div>
      </div>

      <section className="apanel">
        <div className="dephead">
          <div className="dephead__main">
            <h1 className="dephead__title">{asset.displayName}</h1>
            <div className="dephead__meta">
              <Badge tone={state.tone} dot>
                {state.label}
              </Badge>
              <Badge tone="outline">{categoryLabel(asset.category)}</Badge>
              {(asset.os || []).map((os) => (
                <Badge key={os} tone="neutral">
                  {os}
                </Badge>
              ))}
              {(asset.arch || []).map((arch) => (
                <Badge key={arch} tone="neutral">
                  {arch}
                </Badge>
              ))}
              <span className="muted">更新 {timeAgo(asset.updatedAt)}</span>
            </div>
            {asset.description && <p className="dephead__desc">{asset.description}</p>}
          </div>
          <div className="dephead__side">
            <span className="dephead__label">当前版本</span>
            <strong className="mono dephead__version">{asset.currentVersion || '—'}</strong>
            <span className="muted">
              {asset.versions.length} 个版本 · {formatBytes(asset.size)}
            </span>
          </div>
        </div>
      </section>

      <div className="depgrid">
        <section className="apanel apanel--flush">
          <header className="apanel__head">
            <div>
              <h2>版本列表</h2>
              <p>未生效的版本只在管理端可见</p>
            </div>
          </header>

          {asset.versions.length === 0 ? (
            <EmptyState
              compact
              icon={Archive}
              title="还没有版本"
              description="在右侧上传第一个制品，确认无误后再点生效。"
            />
          ) : (
            <table className="ptable">
              <thead>
                <tr>
                  <th style={{ width: 92 }}>版本</th>
                  <th style={{ width: 76 }}>状态</th>
                  <th>文件</th>
                  <th style={{ width: 84 }}>大小</th>
                  <th style={{ width: 132 }}>发布</th>
                  <th className="ptable__actions-head" style={{ width: 168 }}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {asset.versions.map((v) => {
                  const vs = VERSION_STATE_META[v.state] || VERSION_STATE_META.unreleased
                  const isCurrent = v.version === asset.currentVersion
                  return (
                    <tr key={v.version}>
                      <td className="mono nowrap">
                        v{v.version}
                        {isCurrent && <span className="dephead__current">current</span>}
                      </td>
                      <td>
                        <Badge tone={vs.tone}>{vs.label}</Badge>
                      </td>
                      <td>
                        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                          <span className="nowrap" title={v.fileName}>
                            {v.fileName || '—'}
                          </span>
                          {v.sha256 ? (
                            <span className="mono muted" title={v.sha256} style={{ fontSize: 11 }}>
                              sha256 {v.sha256.slice(0, 12)}…
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="mono muted nowrap">{formatBytes(v.size)}</td>
                      <td className="muted nowrap">
                        {formatDate(v.publishedAt)}
                        <div style={{ fontSize: 11 }}>{v.publisher}</div>
                      </td>
                      <td>
                        <div className="ptable__actions">
                          {v.state === 'unreleased' ? (
                            <button
                              className="btn btn--primary btn--sm"
                              disabled={busyVersion === v.version}
                              onClick={() => onEnable(v.version)}
                            >
                              {busyVersion === v.version ? (
                                <Loader size={12} className="spin" />
                              ) : null}
                              生效
                            </button>
                          ) : (
                            <>
                              <a
                                className="btn btn--ghost btn--sm"
                                href={`/client/deps/${asset.code}/versions/${v.version}/download`}
                              >
                                <Download size={13} />
                                下载
                              </a>
                              <button
                                className="btn btn--ghost btn--sm"
                                disabled={busyVersion === v.version}
                                onClick={() => onDisable(v.version)}
                                title="停止提供下载，制品保留"
                              >
                                {busyVersion === v.version ? (
                                  <Loader size={12} className="spin" />
                                ) : null}
                                失效
                              </button>
                            </>
                          )}
                          <button
                            className="btn btn--ghost btn--sm ptable__danger"
                            onClick={() => setDelTarget({ scope: 'version', version: v.version })}
                            title="删除该版本及制品文件，不可恢复"
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
          )}
        </section>

        <section className="apanel">
          <header className="apanel__head">
            <div>
              <h2>上传版本</h2>
              <p>分片上传，断开后可从缺失分片续传</p>
            </div>
          </header>

          <form className="depbody" onSubmit={submitUpload}>
            <label className="field">
              <span className="field__label">版本号</span>
              <input
                className="input mono"
                value={version}
                onChange={(e) => setVersion(e.target.value.trim())}
                placeholder="14.40.33810"
                disabled={phase === 'uploading' || phase === 'hashing'}
              />
              <span className="field__hint">同版本不可覆盖，重复上传返回 409</span>
            </label>

            {!file ? (
              <div
                className={`dropzone ${dragOver ? 'is-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  if (phase !== 'uploading' && phase !== 'hashing') pickFile(e.dataTransfer.files?.[0])
                }}
                onClick={() => phase !== 'uploading' && phase !== 'hashing' && inputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
                }}
              >
                <span className="dropzone__icon">
                  <Archive size={22} />
                </span>
                <strong>把安装包拖进来，或点击选择</strong>
                <span className="dropzone__hint">
                  exe / msi / zip / 补丁包 · 单文件 ≤ {formatBytes(maxBytes)}
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  hidden
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
              </div>
            ) : (
              <div className="filecard">
                <span className="filecard__icon">
                  <Archive size={18} />
                </span>
                <div className="filecard__info">
                  <strong className="mono">{file.name}</strong>
                  <span>
                    {formatBytes(file.size)}
                    {phase === 'hashing' || hashState === 'running'
                      ? ` · 校验中 ${progress}%`
                      : hashState === 'done'
                        ? ' · 校验和已就绪'
                        : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setFile(null)
                    // 作废后台的校验任务：让它的回调不再回写 UI
                    hashJobRef.current = {
                      token: hashJobRef.current.token + 1,
                      file: null,
                      sha256: '',
                      promise: null,
                    }
                    setHashState('idle')
                    setProgress(0)
                    setLoaded(0)
                    setSpeed(0)
                    setEta(0)
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                  disabled={phase === 'uploading' || phase === 'hashing'}
                  aria-label="移除文件"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            <label className="field" style={{ marginTop: 14 }}>
              <span className="field__label">更新说明</span>
              <textarea
                className="textarea"
                rows={2}
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="修了什么、影响哪些平台"
                disabled={phase === 'uploading' || phase === 'hashing'}
              />
            </label>

            {phase !== 'idle' && (
              <>
                <div className="progress" style={{ marginTop: 12 }}>
                  <div className="progress__bar" style={{ width: `${progress}%` }} />
                  <span className="progress__label">{progressView.label}</span>
                </div>
                <div className="progress__meta">
                  <span>{progressView.left}</span>
                  <span>{progressView.right}</span>
                </div>
              </>
            )}

            {error && (
              <div className="alert alert--error alert--sm">
                <CircleAlert size={15} />
                <span>{error}</span>
              </div>
            )}

            {phase !== 'idle' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 14 }}>
                <button type="button" className="btn btn--ghost" onClick={cancelUpload}>
                  取消上传
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={togglePause}
                  disabled={phase === 'hashing' || pausing}
                  title={phase === 'hashing' ? '校验和计算中，暂时无法暂停' : pausing ? '正在等待当前分片写入' : ''}
                >
                  {phase === 'paused' ? '继续' : pausing ? '暂停中…' : '暂停'}
                </button>
              </div>
            ) : (
              <button
                className="btn btn--primary btn--block"
                type="submit"
                disabled={!file}
                style={{ marginTop: 14 }}
              >
                <Upload size={15} />
                开始上传
              </button>
            )}
            {phase === 'paused' && (
              <p className="field__hint" style={{ marginTop: 6 }}>
                已暂停。已写入的分片都保留在服务端，点「继续」只补缺失的分片。
              </p>
            )}
            <p className="field__hint" style={{ marginTop: 8 }}>
              版本上传后是「待生效」，需要手动生效才可下载；资产是否上架由「启用资产」单独控制。
            </p>
          </form>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDown}
        title="确认下架这个依赖？"
        description={
          <>
            下架 <strong>{asset.displayName}</strong> 后，客户端接口立刻返回「资产已下架」。
            字节与版本都会保留，随时可以恢复。操作人：{user?.name || '—'}。
          </>
        }
        confirmText="确认下架"
        busy={takingDown}
        onConfirm={onTakeDown}
        onCancel={() => setConfirmDown(false)}
      />

      <ConfirmDialog
        open={Boolean(delTarget)}
        title={delTarget?.scope === 'asset' ? '确认彻底删除这个依赖？' : `确认删除 v${delTarget?.version || ''}？`}
        description={
          delTarget?.scope === 'asset' ? (
            <>
              会删除 <strong>{asset.displayName}</strong>（<code className="mono">{asset.code}</code>）
              及其全部 <strong>{asset.versions.length}</strong> 个版本的制品文件
              （共 {formatBytes(asset.size)}），存储里的 manifest 与字节一并清掉。
              下载页会立即不再返回它，<strong>不可恢复</strong>。
              <br />
              请逐字输入资产标识：
              <code className="mono"> {asset.code}</code>
            </>
          ) : (
            <>
              会删除 <strong>v{delTarget?.version}</strong> 的制品文件并从版本列表移除，
              不可恢复。如果只是想停止下载，用「失效」即可，制品会保留。
            </>
          )
        }
        confirmText={delTarget?.scope === 'asset' ? '删除并清空制品' : '确认删除'}
        verifyText={delTarget?.scope === 'asset' ? asset.code : ''}
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setDelTarget(null)}
      />
    </div>
  )
}
