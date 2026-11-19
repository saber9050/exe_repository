import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createDep, fetchDepMeta } from '../../api/deps'
import { useToast } from '../../context/ToastContext'
import { CircleAlert, CircleCheck, Info, Loader, PlusCircle } from '../../components/Icons'

const CODE_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/

const emptyForm = {
  code: '',
  displayName: '',
  description: '',
  category: 'runtime',
  os: ['win10'],
  arch: ['x64'],
}

function Chips({ options, value, onChange, disabled }) {
  return (
    <div className="chips">
      {options.map((option) => {
        const on = value.includes(option.key)
        return (
          <button
            type="button"
            key={option.key}
            className={`chip ${on ? 'is-active' : ''}`}
            disabled={disabled}
            onClick={() =>
              onChange(on ? value.filter((x) => x !== option.key) : [...value, option.key])
            }
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default function AdminDepNew() {
  const { toast } = useToast()
  const navigate = useNavigate()
  const [meta, setMeta] = useState(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchDepMeta()
      .then(setMeta)
      .catch(() => {})
  }, [])

  const patch = (next) => setForm((f) => ({ ...f, ...next }))

  const codeError = form.code && !CODE_RE.test(form.code) ? '只能小写字母、数字、点、下划线、连字符，2-40 位' : ''

  const checks = useMemo(
    () => [
      { ok: CODE_RE.test(form.code), label: '资产标识符合规范' },
      { ok: Boolean(form.displayName.trim()), label: '已填显示名称' },
      { ok: form.os.length > 0 && form.arch.length > 0, label: '已选适用平台与架构' },
    ],
    [form],
  )

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!CODE_RE.test(form.code)) return setError('资产标识不合法')
    if (!form.displayName.trim()) return setError('请填显示名称')
    if (!form.os.length || !form.arch.length) return setError('请选择适用平台与架构')

    setSubmitting(true)
    try {
      const res = await createDep({
        code: form.code.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        category: form.category,
        os: form.os,
        arch: form.arch,
      })
      toast('已登记，接下来上传第一个版本', 'success')
      navigate(`/admin/deps/${res.asset.code}`, { replace: true })
    } catch (err) {
      setError(err.message || '登记失败')
      toast(err.message || '登记失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-toolbar">
        <Link to="/admin/deps" className="btn btn--ghost btn--sm">
          返回依赖库
        </Link>
      </div>

      <form className="publish" onSubmit={submit}>
        <div className="publish__main">
          <section className="apanel">
            <header className="apanel__head">
              <div>
                <h2>登记依赖资产</h2>
                <p>只写元数据，制品在详情页上传</p>
              </div>
            </header>

            <div className="formgrid">
              <label className="field formgrid__full">
                <span className="field__label">资产标识</span>
                <input
                  className={`input mono ${codeError ? 'input--error' : ''}`}
                  value={form.code}
                  onChange={(e) => patch({ code: e.target.value.toLowerCase().trim() })}
                  placeholder="vc-redist-x64"
                  disabled={submitting}
                  autoFocus
                />
                {codeError ? (
                  <span className="field__hint field__hint--error">{codeError}</span>
                ) : (
                  <span className="field__hint">
                    登记后不可改。下载路径与存储路径都用它，只能用 ASCII
                  </span>
                )}
              </label>

              <label className="field formgrid__full">
                <span className="field__label">显示名称</span>
                <input
                  className="input"
                  value={form.displayName}
                  onChange={(e) => patch({ displayName: e.target.value })}
                  placeholder="VC++ 运行库 x64"
                  disabled={submitting}
                />
              </label>

              <label className="field">
                <span className="field__label">分类</span>
                <select
                  className="select"
                  value={form.category}
                  onChange={(e) => patch({ category: e.target.value })}
                  disabled={submitting}
                >
                  {(meta?.categories || [{ key: 'runtime', label: '运行时' }]).map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field formgrid__full">
                <span className="field__label">适用系统</span>
                <Chips
                  options={meta?.os || [{ key: 'win10', label: 'Windows 10+' }]}
                  value={form.os}
                  onChange={(os) => patch({ os })}
                  disabled={submitting}
                />
              </div>

              <div className="field formgrid__full">
                <span className="field__label">架构</span>
                <Chips
                  options={meta?.arch || [{ key: 'x64', label: 'x64' }]}
                  value={form.arch}
                  onChange={(arch) => patch({ arch })}
                  disabled={submitting}
                />
              </div>

              <label className="field formgrid__full">
                <span className="field__label">说明</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={form.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="Windows 上多数 exe 安装包的前置依赖，缺了会报 0xc000007b。"
                  disabled={submitting}
                />
              </label>
            </div>

            {error && (
              <div className="alert alert--error alert--sm">
                <CircleAlert size={15} />
                <span>{error}</span>
              </div>
            )}

            <div className="publish__actions">
              <button className="btn btn--primary btn--lg" type="submit" disabled={submitting}>
                {submitting ? <Loader size={16} className="spin" /> : <PlusCircle size={16} />}
                {submitting ? '登记中…' : '登记并去上传'}
              </button>
              <Link to="/admin/deps" className="btn btn--ghost btn--lg">
                取消
              </Link>
            </div>
          </section>
        </div>

        <aside className="publish__side">
          <div className="side-card">
            <div className="side-card__head">
              <CircleCheck size={15} />
              <span>登记检查</span>
            </div>
            <ul className="checklist">
              {checks.map((c) => (
                <li key={c.label} className={c.ok ? 'is-ok' : ''}>
                  <span className="checklist__mark">{c.ok ? <CircleCheck size={11} /> : null}</span>
                  {c.label}
                </li>
              ))}
            </ul>
            <p className="side-card__note">
              标识一旦登记就固定，后续版本、下载路径都依赖它。
            </p>
          </div>

          <div className="side-card">
            <div className="side-card__head">
              <Info size={15} />
              <span>存储位置</span>
            </div>
            <dl className="meta-list meta-list--tight">
              <div>
                <dt>驱动</dt>
                <dd>MinIO 对象存储（分片上传）</dd>
              </div>
              <div>
                <dt>单文件上限</dt>
                <dd>{meta ? `${Math.round(meta.maxFileBytes / 1024 / 1024)} MB` : '—'}</dd>
              </div>
              <div>
                <dt>初始状态</dt>
                <dd>待生效</dd>
              </div>
            </dl>
          </div>
        </aside>
      </form>
    </div>
  )
}
