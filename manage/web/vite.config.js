import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期：Vite 只负责前端热更新，/client 与 /server 全部代理到本地服务端（默认 8788），
// 这样浏览器里看到的始终是同源请求，不需要给 Gitea 配 CORS，也不会把令牌带进浏览器。
const BACKEND = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:8788'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5184,
    strictPort: false,
    proxy: {
      '/client': { target: BACKEND, changeOrigin: false },
      '/server': { target: BACKEND, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
