import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { fetchDepMeta } from '../../api/deps'
import {
  ArrowLeft,
  LayoutDashboard,
  Layers,
  LogOut,
  LogoMark,
  Package,
  PlusCircle,
  ScrollText,
} from '../../components/Icons'

const NAV = [
  { to: '/admin/deps', icon: Layers, label: '依赖库' },
  { to: '/admin/audit', icon: ScrollText, label: '审计日志' },
]

const TITLES = {
  '/admin/deps': ['依赖库', 'exe、系统组件与补丁的登记、上传与生效'],
  '/admin/deps/new': ['登记依赖', '填写元数据，随后上传第一个版本'],
  '/admin/audit': ['审计日志', '上传、生效、下架与下载留痕'],
}

export default function AdminLayout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [store, setStore] = useState(null)

  useEffect(() => {
    // 依赖库自己的 meta 里就带仓库信息（owner/repo/branch），不必再打插件库的接口
    fetchDepMeta()
      .then((res) => setStore(res.store))
      .catch(() => {})
  }, [])

  if (!user) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />
  }

  const [title, subtitle] =
    TITLES[location.pathname] ||
    (location.pathname.startsWith('/admin/deps/')
      ? ['依赖详情', '版本、校验和与上下架']
      : ['管理端', ''])

  return (
    <div className="admin">
      <aside className="admin__side">
        <Link to="/admin/deps" className="admin__brand">
          <LogoMark size={26} />
          <span>
            依赖库 <em>管理端</em>
          </span>
        </Link>

        <nav className="admin__nav">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `admin__navlink ${isActive ? 'is-active' : ''}`}
              >
                <Icon size={16} />
                {item.label}
              </NavLink>
            )
          })}
        </nav>

        <div className="admin__side-foot">
          <div className="admin__user">
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <div className="admin__user-info">
              <strong>{user.name}</strong>
              <span>{user.username}</span>
            </div>
            <button className="icon-btn" onClick={logout} title="退出登录">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      <div className="admin__main">
        <header className="admin__topbar">
          <div>
            <h1 className="admin__title">{title}</h1>
            {subtitle && <p className="admin__subtitle">{subtitle}</p>}
          </div>
          <div className="admin__topbar-right">
            {store && (
              <span className="env-chip mono" title="制品库（MinIO 对象存储）">
                MinIO · {store.bucket}
              </span>
            )}
            <span className="admin__env">
              <span className="status-dot" />
              服务端正常
            </span>
          </div>
        </header>

        <nav className="admin__mobile-nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="admin__mobile-link">
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="admin__content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
