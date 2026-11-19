import { Navigate, Route, Routes } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import AdminLayout from './pages/admin/AdminLayout'
import AdminLogin from './pages/admin/AdminLogin'
import AdminDeps from './pages/admin/AdminDeps'
import AdminDepNew from './pages/admin/AdminDepNew'
import AdminDepDetail from './pages/admin/AdminDepDetail'
import AdminAudit from './pages/admin/AdminAudit'

/**
 * 依赖库管理端路由。
 *
 * 分离之后这个服务只做依赖库：根路径直接进资产列表，没有市场/插件页面。
 */
export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Navigate to="/admin/deps" replace />} />
        <Route path="/admin/login" element={<AdminLogin />} />

        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/deps" replace />} />
          <Route path="deps" element={<AdminDeps />} />
          <Route path="deps/new" element={<AdminDepNew />} />
          <Route path="deps/:code" element={<AdminDepDetail />} />
          <Route path="audit" element={<AdminAudit />} />
        </Route>

        <Route path="*" element={<Navigate to="/admin/deps" replace />} />
      </Routes>
    </ErrorBoundary>
  )
}
