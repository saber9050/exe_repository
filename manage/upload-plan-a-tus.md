# 分片上传方案 A：tus 协议

> 适用范围：管理端（`manage`）依赖库制品上传。目标是把现有「单请求裸流直传 Gitea」改造成可分片、可暂停、可断点续传的上传。
> 本文只做方案设计，不含实现代码落库。另一条路线见 [方案 B：自研最小分片](./upload-plan-b-chunked.md)。

---

## 1. 结论速览

- 服务端引入 `@tus/server` + `@tus/file-store`，在现有 Express 进程内挂载标准 tus 端点；前端引入 `tus-js-client`。
- 分片、重试、断点偏移校验、过期清理、并发锁全部由 tus 协议与库负责，自己只写三段业务钩子：建传校验、完成落库、鉴权。
- 文件先完整落到本地临时目录（`@tus/file-store`），上传完成后在 `onUploadFinish` 里用 `fs.createReadStream` 流式交给现有 `DepStore.addVersion`，由它完成 sha256 计算、单次 PUT 到 Gitea、两段写与回滚。
- 新增依赖 3 个（服务端 2 个、前端 1 个），需要本地临时磁盘空间 ≥ 单文件大小（最大 2 GiB）。
- 相比自研方案，代码量少、协议边界成熟，但依赖数量与“异步落库”的状态管理是主要成本。

---

## 2. 现状与硬约束（方案设计的出发点）

| 约束 | 位置 | 对方案的影响 |
|---|---|---|
| 制品最终只能通过 Gitea generic registry 的**单次 PUT** 落库 | [`storage.js`](./server/lib/dep/storage.js#L107-L135) | 分片必须在服务端完成拼接，Gitea 侧无分片/追加接口 |
| 服务端目前不落任何制品临时状态 | [`README.md`](./README.md#L106-L115) | tus 的 FileStore 会打破这条约定，需要补充磁盘与清理策略 |
| `addVersion` 内部用 `withLock()` 全局串行 | [`store.js`](./server/lib/dep/store.js#L204-L313) | finalize 阶段仍会短暂阻塞其他写操作，需要向用户暴露“落库中”状态 |
| 上传不设总时长（`server.requestTimeout = 0`） | [`index.js`](./server/index.js#L42) | 长连接可行，但反向代理的空闲超时仍需关注 |
| 前端曾因 fetch + ReadableStream 在代理下报 `ERR_ALPN_NEGOTIATION_FAILED` 而回退 XHR | [`api/deps.js`](./web/src/api/deps.js#L60-L82) | `tus-js-client` 默认走 XHR，正好规避该问题 |
| 单文件上限 `DEP_MAX_FILE_BYTES` 默认 2 GiB | [`config.js`](./server/lib/config.js#L76) | 需要同时限制 tus `maxSize` 与本地磁盘占用 |

---

## 3. 总体架构

```
浏览器（AdminDepDetail）
  │  tus-js-client（XHR）
  │  POST   /server/uploads/tus/           创建上传（Upload-Metadata 带 code/version/filename）
  │  PATCH  /server/uploads/tus/<id>       按 chunkSize 发送分片（application/offset+octet-stream）
  │  HEAD   /server/uploads/tus/<id>       续传前询问已收偏移（Upload-Offset）
  │  DELETE /server/uploads/tus/<id>       取消并清理
  ▼
Express（manage/server）
  ├─ onIncomingRequest  校验 Bearer token（复用 verifyToken）
  ├─ onUploadCreate     校验 code/version/文件名/大小，版本重复直接 409
  ├─ @tus/file-store    文件写到 DEP_UPLOAD_DIR/<id>
  └─ onUploadFinish     触发 finalize（推荐异步）
        │
        └─ DepStore.addVersion({ stream: fs.createReadStream(<id>) })
              ├─ 计算 sha256 / 字节数
              ├─ Gitea generic registry 单次 PUT
              ├─ 写 manifest（第二段写）
              └─ 失败回滚删除制品
        │
        └─ finalize 成功后删除 tus 临时文件
浏览器轮询 GET /server/deps/uploads/<id> 获取 finalize 状态
```

关键点：**tus 只负责“把完整文件安全地收进来”，落库仍完全复用现有 `DepStore.addVersion`**，所以校验、回滚、审计、版本不可变语义都不用重写。

---

## 4. 服务端设计

### 4.1 依赖与挂载

```bash
# manage/server
npm install @tus/server @tus/file-store
```

```js
// manage/server/lib/dep/tus-upload.js（新增）
import path from 'node:path'
import { Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import { config } from '../config.js'
import { verifyToken } from '../auth.js'
import { assertCode, assertVersion } from './manifest.js'
import { HttpError } from '../http-error.js'

/** tus 的 Upload-Metadata 值是 Base64 或 URL 编码字符串，这里统一按 URL 编码解码 */
const safeDecode = (v) => {
  try {
    return decodeURIComponent(String(v || ''))
  } catch {
    return String(v || '')
  }
}

export function createTusServer({ store, sessionsLog }) {
  const tusServer = new Server({
    path: '/server/uploads/tus',
    datastore: new FileStore({
      directory: path.resolve(config.depUploadDir),
      // 注意：FileStore 的过期时间按“创建时间”计算，不是最后修改时间
      expirationPeriodInMilliseconds: config.depUploadTtlMs,
    }),
    maxSize: config.depMaxFileBytes,
    onIncomingRequest: async (req) => {
      // 不同版本钩子拿到的 Request 包装不同，优先用 runtime.node.req 取原始 Node 请求
      const raw = req.runtime?.node?.req ?? req
      const header = raw.headers?.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      const payload = verifyToken(token)
      if (!payload) {
        throw { status_code: 401, body: JSON.stringify({ message: '登录已过期，请重新登录' }) }
      }
      // 记到弱引用表里，供 onUploadCreate / onUploadFinish 取 actor
      req.admin = payload
    },
    onUploadCreate: async (req, upload) => {
      const meta = upload.metadata || {}
      const code = assertCode(safeDecode(meta.code))
      const version = assertVersion(safeDecode(meta.version))
      const fileName = safeDecode(meta.filename)
      if (!fileName) throw { status_code: 422, body: JSON.stringify({ message: '文件名必填' }) }

      // 版本重复预检：只做提示，finalize 时 addVersion 仍会再判一次
      const manifest = await store.getManifest(code) // 不存在时内部会抛 404
      if (manifest.versions?.some((v) => v.version === version)) {
        throw { status_code: 409, body: JSON.stringify({ message: `版本 ${version} 已存在` }) }
      }

      // 服务端写入不可伪造的 actor，客户端 metadata 不能作为身份依据
      return { metadata: { ...meta, code, version, filename: fileName, actor: req.admin?.n || '' } }
    },
    onUploadFinish: async (req, res, upload) => {
      // 见 4.3：推荐异步 finalize，这里只登记任务并立即返回
      sessionsLog.start(upload.id, {
        code: safeDecode(upload.metadata.code),
        version: safeDecode(upload.metadata.version),
        fileName: safeDecode(upload.metadata.filename),
        changelog: safeDecode(upload.metadata.changelog || ''),
        actor: safeDecode(upload.metadata.actor || ''),
        size: upload.size,
        tus: tusServer,
      })
      // tus 规范只允许 204；不要在这里返回 body
    },
    onResponseError: async (req, err) => {
      console.error('[tus] 请求失败', err?.message || err)
    },
  })
  return tusServer
}
```

挂载位置（`app.js`，放在静态托管与 404 之前）：

```js
import express from 'express'
// ...
const tusApp = express()
tusApp.all('*', tusServer.handle.bind(tusServer))
app.use('/server/uploads/tus', tusApp)
```

要点：

- 必须挂载在 `app.use((req, res) => 404)` 之前，否则分片请求会被兜底 404 吞掉。
- Vite 开发代理已覆盖 `/server`（[vite.config.js](./web/vite.config.js#L14-L17)），开发期无需额外配置。
- `express.json({ limit: '2mb' })` 只解析 `application/json`，不会吞掉 tus 的 `application/offset+octet-stream` 请求体；但挂载顺序仍建议放在 json 解析之后、静态资源之前，保持语义清晰。

### 4.2 鉴权细节

- `onIncomingRequest` 对每个 tus 请求（POST/HEAD/PATCH/DELETE/OPTIONS）都校验 Bearer token，和现有 `requireAdmin` 使用同一套 HMAC token。
- tus 的 OPTIONS 是跨域预检，同源部署下不会触发；即使触发也要求带 token，前端需确保 `headers` 选项在每个请求上都带上 `Authorization`。
- **不能信任客户端 metadata 里的身份字段**。`onUploadCreate` 里由服务端覆盖 `actor`，finalize 审计用这个值。

### 4.3 落库：同步还是异步

**方式一：同步 finalize（简单）**

```js
onUploadFinish: async (req, res, upload) => {
  const filePath = path.join(config.depUploadDir, upload.id)
  const stream = fs.createReadStream(filePath)
  await store.addVersion(code, { version, fileName, stream, declaredSize: upload.size, changelog, actor })
  await tusServer.datastore.remove(upload.id)
}
```

- 优点：没有额外状态机，tus 最终 PATCH 的响应就是“已落库”。
- 缺点：2 GiB 文件最后一步要读盘 + 上传 Gitea，可能持续数分钟，PATCH 请求一直等响应；反向代理/浏览器容易先超时，客户端会误以为失败并触发重试（此时 Gitea 侧可能已经成功）。

**方式二：异步 finalize（推荐）**

- `onUploadFinish` 只把任务写入内存表 `Map<uploadId, { state, error }>`，立即返回 204。
- 后台执行 `addVersion`，成功后删除 tus 临时文件并置 `state = 'done'`；失败置 `state = 'failed'`，保留临时文件以便重试（或按策略删除）。
- 新增查询接口：

```
GET /server/deps/uploads/:uploadId
→ 200 {
    state: 'finalizing' | 'done' | 'failed',
    version, sha256?, size, error?
  }
```

- 前端在 tus `onSuccess` 后轮询该接口（2 秒一次，最多 10 分钟），拿到 `done` 才算上传完成。
- 进程重启时，`init()` 里扫描 `DEP_UPLOAD_DIR`：`upload.offset === upload.size` 且 `metadata` 完整的任务重新入队 finalize，其余按 TTL 清理。

> 建议选方式二。它把“传输完成”和“落库完成”解耦，进度条语义清晰，也避免长响应被代理掐断。

### 4.4 过期清理

- `expirationPeriodInMilliseconds` 设为 `DEP_UPLOAD_TTL_MS`（默认 24 小时）。
- **注意 FileStore 是按创建时间算过期，不是最后修改时间**（见 `@tus/file-store` README）。如果用户上传 2 GiB 断续续超过 TTL，续传时可能已被判定过期。保守做法：TTL 设 7 天，或在低峰期才执行清理。
- 启动时调用一次 `tusServer.cleanUpExpiredUploads()`，之后每小时执行一次并 `.unref()`：

```js
setInterval(() => tusServer.cleanUpExpiredUploads().catch(() => {}), 3600_000).unref()
```

### 4.5 配置项

```js
// manage/server/lib/config.js 追加
depUploadDir: process.env.DEP_UPLOAD_DIR || '.uploads',
depUploadTtlMs: num(process.env.DEP_UPLOAD_TTL_MS, 7 * 24 * 3600 * 1000),
depUploadChunkBytes: num(process.env.DEP_UPLOAD_CHUNK_BYTES, 8 * 1024 * 1024),
```

```dotenv
# manage/server/.env.example 追加
# tus 临时目录（相对 server 进程 cwd，需可写）
DEP_UPLOAD_DIR=.uploads
# 未完成上传的保留时间（毫秒）
DEP_UPLOAD_TTL_MS=604800000
# 前端分片大小（字节），同时作为服务端建议上限
DEP_UPLOAD_CHUNK_BYTES=8388608
```

> `path.resolve(config.depUploadDir)` 以进程 cwd 为基准；现有启动方式都在 `manage/server` 目录下，若要支持任意 cwd，改成基于 `import.meta.url` 计算绝对路径。

### 4.6 错误映射

| 场景 | 返回 | 前端表现 |
|---|---|---|
| token 过期 | 401 | 跳登录 |
| 资产不存在 | 404 | toast |
| 版本已存在 | 409 | 阻止上传，提示改版本号 |
| 文件超过 `DEP_MAX_FILE_BYTES` | 413 | toast 提示上限 |
| `Upload-Offset` 不匹配（服务端已有偏移） | 409 | tus 客户端会自动 HEAD 重新对齐 |
| finalize 时 sha256 不一致 | 422（状态接口 `failed`） | 提示文件损坏，建议重传 |
| finalize 时 Gitea 502 | 状态接口 `failed` | 保留会话，可重试 complete |

`onResponseError` 只做日志，不改变 tus 的协议错误结构。

### 4.7 多实例与并发

- 默认 `MemoryLocker` 只在单进程内有效；本项目 `manage` 是单实例部署，可接受。
- 如果未来水平扩容，需要换成共享 locker（Redis），否则同一 uploadId 的并发 PATCH 会互相覆盖。

---

## 5. 前端设计

### 5.1 依赖

```bash
# manage/web
npm install tus-js-client
```

### 5.2 API 封装

```js
// manage/web/src/api/deps.js 新增
import * as tus from 'tus-js-client'
import { getToken } from './client' // 现有取 token 的方法

export function uploadDepVersionTus({ code, version, file, changelog, onProgress, onState }) {
  const upload = new tus.Upload(file, {
    endpoint: '/server/uploads/tus/',
    chunkSize: 8 * 1024 * 1024,          // 越小断点粒度越细，请求数越多
    retryDelays: [0, 1000, 3000, 5000, 10000],
    headers: { Authorization: `Bearer ${getToken()}` },
    metadata: {
      code,
      version,
      filename: file.name,
      changelog: changelog || '',
    },
    // 让“同一文件 + 同一资产 + 同一版本”能找回上次上传
    fingerprint: () => `${code}:${version}:${file.name}:${file.size}:${file.lastModified}`,
    onProgress: (sent, total) => onProgress?.(Math.round((sent / total) * 100), sent, total),
    onSuccess: async () => {
      // tus 传输完成 ≠ 已落库，进入 finalize 轮询
      onState?.({ phase: 'finalizing', uploadId: upload.url.split('/').pop() })
    },
    onError: (err) => onState?.({ phase: 'error', error: err }),
  })
  return upload
}
```

### 5.3 暂停、续传、刷新恢复

- 暂停：`upload.abort(false)` —— `false` 表示**不发送 DELETE**，服务端保留已收分片。
- 继续：再次 `upload.start()`，tus 客户端会先 HEAD 拿 `Upload-Offset`，从断点续传。
- 页面刷新/重开：`await upload.findPreviousUploads()`，有记录则 `upload.resumeFromPreviousUpload(previous[0])` 再 `start()`。
- 取消：`upload.abort(true)`，会发送 DELETE 并删除服务端临时文件，同时清理 localStorage 里的 URL 记录。

### 5.4 页面状态机改造

现有 [AdminDepDetail.jsx](./web/src/pages/admin/AdminDepDetail.jsx#L93-L181) 的三态改为四态：

```
idle → uploading ⇄ paused → finalizing → idle
                 ↘ error
```

- `paused` 不再是“断开重传”，而是真正的断点暂停。
- 进度 100% 后进入 `finalizing`，文案改为“正在写入制品库…”，禁止再次点击上传。
- 速度统计继续用 `(loaded - lastLoaded) / 时间窗`。
- 成功后清空文件/版本/changelog 并 `load()` 刷新（沿用现有逻辑）。

### 5.5 保留旧实现

- 保留 `uploadDepVersion`（单请求 XHR）与 `POST /server/deps/:code/versions`，供脚本/CLI/小文件使用。
- 管理页面统一走 tus；如果希望小文件少几次请求，可按 `file.size < 16 MiB` 回落旧接口，但这会多一条代码路径，建议先统一。

---

## 6. 存储与生命周期

```
DEP_UPLOAD_DIR/
  <uploadId>          # 文件本体（tus 生成）
  <uploadId>.json     # FileStore 的元数据（metadata、offset、size、creation_date）
```

- 一个上传会话的磁盘占用 ≈ 文件大小（不分片副本），finalize 成功后删除。
- 同时多人在传时，磁盘峰值 = 并发会话大小之和；建议在 UI 或服务端限制同时上传数（本项目管理员人数少，可先不加）。
- 崩溃残留由启动扫描 + 定时 `cleanUpExpiredUploads()` 处理。

---

## 7. 安全要点

1. 所有 tus 请求都校验 token，且校验发生在读写磁盘之前。
2. `code` / `version` / `filename` 全部重新用 `assertCode` / `assertVersion` 校验，不信任 metadata。
3. `actor` 由服务端在 `onUploadCreate` 写入，客户端无法伪造。
4. 路径穿越：tus 生成 hex id，`getFileIdFromRequest` 默认拒绝解码后的路径分隔符与 NUL，保持默认即可。
5. finalize 仍复用 `addVersion` 的 `maxFileBytes` 校验，双保险。
6. tus 端点挂在 `/server/**` 下，不走 `/client` 的 CORS 放开策略。

---

## 8. 实施步骤

1. 安装依赖：服务端 `@tus/server`、`@tus/file-store`；前端 `tus-js-client`。
2. `config.js` 增加 3 个配置，同步 `.env.example`。
3. 新增 `server/lib/dep/tus-upload.js`：创建 tus Server、三段钩子、finalize 任务表。
4. `app.js` 挂载 tus 子应用（静态资源与 404 之前），`init()` 里做一次过期清理与未完成任务恢复。
5. 新增 `GET /server/deps/uploads/:uploadId` 查询 finalize 状态。
6. 前端 `api/deps.js` 增加 tus 封装与 finalize 轮询。
7. `AdminDepDetail.jsx` 改为四态状态机，暂停/继续/刷新恢复走 tus API。
8. 更新 `README.md` 里“不落本地磁盘”的约定，补充临时目录与清理说明。

---

## 9. 测试清单

| 用例 | 预期 |
|---|---|
| 暂停后继续 | 从断点续传，不重传已收字节 |
| 刷新页面后继续 | `findPreviousUploads` 找到记录并续传 |
| 上传中断网 30 秒 | 自动重试，最终成功 |
| 2 GiB 文件 | 完整落库，sha256 一致 |
| 版本号重复 | 建传阶段 409 |
| finalize 阶段 Gitea 502 | 状态查询返回 failed，临时文件保留可重试 |
| token 过期后续传 | 401，前端跳登录 |
| 过期会话 | 定时清理后 HEAD 返回 404/410 |
| 代理环境（Nginx） | 分片请求不被缓冲/超时打断（必要时关闭 `proxy_request_buffering`） |

---

## 10. 风险与取舍

**优点**

- 协议成熟：断点偏移校验、重试、过期、并发锁开箱即用。
- 前端代码极少，`tus-js-client` 默认 XHR，规避现有 fetch 流式在代理下的坑。
- 不改变 `DepStore` / `storage.js`，落库语义与现在完全一致。

**缺点 / 风险**

- 新增 3 个依赖（含传递依赖），与项目“只有 express”的极简风格冲突，需要 `npm ls` 评估体积与许可证。
- `@tus/file-store` 不支持 Checksum 扩展（官方扩展表），客户端不能带 `Upload-Checksum`；完整性仍靠 finalize 时服务端算 sha256。
- 异步 finalize 引入额外状态机与轮询接口；同步 finalize 则可能被代理超时误判。
- FileStore 过期按创建时间，长上传需要把 TTL 设得较大。
- finalize 期间仍持有 `addVersion` 的全局写锁（与现状相同），大文件会让其他写操作排队。
- 需要本地可写磁盘 ≥ 单文件大小；若生产环境不允许落盘，应改走方案 C（分片暂存 Gitea 临时包）或对象存储 multipart。

**与方案 B 的对比**

| 维度 | 方案 A（tus） | 方案 B（自研） |
|---|---|---|
| 新增依赖 | 3 个 | 0 个 |
| 自身代码量 | 约 150 行（钩子 + 状态接口 + 前端封装） | 约 400 行（会话存储 + 路由 + 前端编排） |
| 协议边界处理 | 库负责 | 自己负责 |
| 断点粒度 | 每次 PATCH | 每个分片文件 |
| 可控性 | 受库的钩子能力约束 | 完全可控 |
| 本地磁盘 | 需要 | 需要 |

若团队接受新增依赖、希望少写协议细节，选 A；若坚持零依赖、希望接口语义完全贴合现有仓储，选 B。
