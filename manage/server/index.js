/**
 * 依赖库管理端 · 启动入口
 *
 * 只负责「起一个监听 + 打印提示」，业务与路由在 server/app.js。
 */
import fs from 'node:fs'
import { createManageApp } from './app.js'
import { config, assertConfig, ROOT } from './lib/config.js'

assertConfig()

// 默认密钥是写在代码里的公开串，拿到它就能不经密码伪造管理员 token。
// 不阻断启动（本机调试要用），但每次都提醒一次，免得带到线上。
if (config.sessionSecret === 'dev-only-change-me') {
  console.warn(
    '[manage] SESSION_SECRET 仍是默认值，任何人都能伪造管理员 token。' +
      '正式使用前请在 server/.env 里换成随机串：' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  )
}

const manage = createManageApp()
const { app } = manage

/* ============================== 启动 ============================== */

const indexHtml = `${config.distDir}/index.html`

const server = app.listen(config.port, '127.0.0.1', async () => {
  const local = `http://127.0.0.1:${config.port}`
  console.log(`[manage] 已启动 ${local}`)
  console.log(`[manage] 制品库 ${manage.gitea.htmlUrl()}（${config.owner}/${config.repo}@${config.branch}）`)
  if (!fs.existsSync(indexHtml)) {
    console.log('[manage] 未发现 web/dist，开发期请用 npm run dev（Vite 会把 /client 与 /server 代理到这里）')
  }

  await manage.init()
})

// 依赖库要传几百 MB 的 exe，不能被 Node 默认的 300s 总时长掐断。
// 头部超时保持较短，避免慢速攻击挂住连接。
server.requestTimeout = 0
server.headersTimeout = 65_000
server.keepAliveTimeout = 72_000

/* 端口占用 / 权限等启动期错误的友好提示 */
server.on('error', (err) => {
  const port = config.port
  if (err.code === 'EADDRINUSE') {
    console.error('')
    console.error(`[manage] 端口 ${port} 已被占用，另一个实例可能还在运行。`)
    console.error(`[manage] 直接访问  http://127.0.0.1:${port}  若页面正常，说明服务已就绪，无需再次启动。`)
    console.error('')
    console.error('        需要重启时，先停掉占用的进程（Git Bash / PowerShell 任选其一）：')
    console.error(`          netstat -ano | findstr :${port}`)
    console.error(`          taskkill /PID <PID> /F`)
    console.error('')
    process.exit(1)
  }
  if (err.code === 'EACCES') {
    console.error(`[manage] 无权绑定端口 ${port}，请换端口（server/.env 中 PORT=xxxx）或提升权限后重试。`)
    process.exit(1)
  }
  console.error('[manage] 启动失败：', err)
  process.exit(1)
})

function shutdown() {
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export { app, manage, ROOT }
