import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { CircleAlert, Loader, Lock, LogoMark, ShieldCheck, User } from '../../components/Icons'

export default function AdminLogin() {
  const { user, login } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (user) {
    const to = location.state?.from || '/admin'
    return <Navigate to={to} replace />
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.username || !form.password) {
      setError('请输入账号与密码')
      return
    }
    setLoading(true)
    try {
      await login(form.username.trim(), form.password)
      toast('登录成功', 'success')
      navigate(location.state?.from || '/admin', { replace: true })
    } catch (err) {
      setError(err.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login">
      <aside className="login__brand">
        <Link to="/" className="login__brand-top">
          <LogoMark size={30} />
          <span>依赖库管理端</span>
        </Link>
        <div className="login__brand-body">
          <h1>管理端</h1>
          <ul className="login__features">
            <li>
              <ShieldCheck size={15} />
              版本不可变，重复上传直接拒绝
            </li>
            <li>
              <ShieldCheck size={15} />
              sha256 由服务端实算，上传值只作比对
            </li>
            <li>
              <ShieldCheck size={15} />
              下架不删字节，可随时重新生效
            </li>
          </ul>

          <div className="login__flow">
            <div className="login__flow-step">
              <span>01</span>
              登记资产
            </div>
            <i />
            <div className="login__flow-step">
              <span>02</span>
              上传制品
            </div>
            <i />
            <div className="login__flow-step">
              <span>03</span>
              生效上线
            </div>
          </div>
        </div>
      </aside>

      <main className="login__panel">
        <form className="login__form" onSubmit={submit}>
          <h2>登录管理端</h2>
          <p className="login__sub">使用平台账号登录，登录态只在本服务内有效。</p>

          {error && (
            <div className="alert alert--error alert--sm">
              <CircleAlert size={15} />
              <span>{error}</span>
            </div>
          )}

          <label className="field">
            <span className="field__label">
              <User size={13} />
              账号
            </span>
            <input
              className="input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="admin"
              autoComplete="username"
              autoFocus
            />
          </label>

          <label className="field">
            <span className="field__label">
              <Lock size={13} />
              密码
            </span>
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </label>

          <button className="btn btn--primary btn--lg btn--block" disabled={loading} type="submit">
            {loading ? <Loader size={16} className="spin" /> : null}
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
      </main>
    </div>
  )
}
