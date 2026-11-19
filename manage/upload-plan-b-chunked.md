# 分片上传方案 B：自研最小分片协议

> 适用范围：管理端（`manage`）依赖库制品上传。目标是用零新增依赖的方式，实现分片、暂停/继续、断点续传、单片失败重试。
> 本文只做方案设计，不含实现代码落库。另一条路线见 [方案 A：tus 协议](./upload-plan-a-tus.md)。

---

## 1. 结论速览

- 不引入任何新依赖，在现有 Express 上新增 5 个接口：建会话、传分片、查进度、完成合并、取消。
- 分片按序号独立落本地临时目录（`<uploadId>/000000.part`），**不合并成大文件**；`complete` 时用异步生成器按序读分片，直接作为现有 `DepStore.addVersion` 的 `stream`，由它完成 sha256、单次 PUT 到 Gitea、两段写与回滚。
- 断点续传靠 `GET` 会话返回已收分片列表；暂停 = 停止发送下一片并中断当前片；刷新页面后重新 `GET` 即可继续。
- 全局写锁只在 `complete` 阶段持有，上传过程完全不占锁。
- 服务端新增约 300 行（会话存储 + 路由），前端新增约 150 行（分片编排 + 页面状态机）；需要本地临时磁盘，每会话占用 ≈ 文件大小。

---

## 2. 设计目标与非目标

**目标**

1. 分片上传，单请求体积可控（默认 8 MiB），降低代理/网关对超大请求体的限制与超时风险。
2. 暂停后继续不重传已上传字节；刷新页面、网络中断后可恢复。
3. 单片失败可重试；失败分片重传幂等。
4. 完整复用现有落库链路：`DepStore.addVersion` 的校验、sha256、两段写、回滚、审计、版本不可变语义一律不改。
5. 上传进度按字节精确计算，UI 能区分“传输中”和“写入制品库中”。

**非目标**

- 多实例共享上传会话（本项目管理端单实例部署）。
- 跨设备/跨浏览器续传（会话只绑定 uploadId 与文件指纹，不做用户级持久化）。
- 秒传/去重（Gitea 侧没有可用的内容寻址接口）。
- 并行上传多个分片（首版串行，避免服务端并发写与会话状态复杂度；协议本身允许乱序提交，后续可放开并发）。

---

## 3. 总体流程

```
前端                                    服务端
 │ POST /server/deps/:code/uploads       │  校验资产/版本/大小 → 建会话目录 + meta.json
 │ ────────────────────────────────────► │
 │ ◄──────── { uploadId, chunkSize, totalChunks, received: [] }
 │
 │ PUT .../uploads/:id/chunks/0          │  校验 index/长度 → 流式写 000000.part.tmp → rename
 │ ────────────────────────────────────► │
 │ ◄──────── { receivedBytes, received: [0] }
 │            …… 重复 1..N-1 ……
 │
 │ （可选）GET .../uploads/:id            │  返回已收分片，用于暂停/刷新后续传
 │ ◄──────── { received: [...], receivedBytes }
 │
 │ POST .../uploads/:id/complete         │  校验分片齐全
 │ ────────────────────────────────────► │  withLock:
 │                                       │    版本查重（409）
 │                                       │    按序读分片 → addVersion
 │                                       │      ├─ 边读边算 sha256 / 字节数
 │                                       │      ├─ Gitea generic registry 单次 PUT
 │                                       │      ├─ 写 manifest（两段写）
 │                                       │      └─ 失败回滚删除制品
 │                                       │    删除会话目录
 │ ◄──────── 201 { ok, asset, version }  │
```

暂停/中断时：会话目录保留，`GET` 返回 `received`，前端从缺失分片继续。
取消时：`DELETE .../uploads/:id` 直接删除会话目录。

---

## 4. 接口设计

所有接口都挂在 `/server/**` 下，复用现有 `requireAdmin`（[auth.js](./server/lib/auth.js#L51-L60)），不走 `/client` 的跨域策略。

### 4.1 创建会话

```
POST /server/deps/:code/uploads
Content-Type: application/json

{
  "version": "1.4.2",
  "fileName": "OfficeTool.exe",
  "size": 2147483648,
  "chunkSize": 8388608,        // 可选，服务端会夹到 [1 MiB, 32 MiB]
  "changelog": "修复若干问题"   // 可选
}
```

```json
// 201
{
  "uploadId": "9f2c1d7a4b8e4c3f9a1b2c3d4e5f6a7b",
  "chunkSize": 8388608,
  "totalChunks": 256,
  "received": [],
  "expiresAt": "2025-11-26T10:00:00.000Z"
}
```

校验：

| 校验 | 失败返回 |
|---|---|
| `code` 合法且资产存在 | 422 / 404 |
| `version` 符合 semver | 422 |
| `fileName` 非空、长度合理 | 422 |
| `size` 为整数且 `1 ≤ size ≤ DEP_MAX_FILE_BYTES` | 422 / 413 |
| 版本号在该资产下已存在 | 409（预检，complete 时仍会再判） |
| 同名文件存在未完成会话 | 允许，新建会话（旧会话按 TTL 清理） |

### 4.2 上传分片

```
PUT /server/deps/:code/uploads/:uploadId/chunks/:index
Content-Type: application/octet-stream
Content-Length: <分片字节数，最后一片可能小于 chunkSize>
<分片原始字节>
```

```json
// 200
{ "index": 12, "receivedBytes": 109051904, "received": 13 }
```

规则：

- `index` 必须是 `0 ≤ index < totalChunks` 的整数。
- 每片期望长度：`index < totalChunks - 1 ? chunkSize : size - chunkSize * (totalChunks - 1)`。
- `Content-Length` 与期望长度不一致 → 400；没有 `Content-Length`（chunked transfer）时边写边计数，超出期望立即中断并按 400 处理。
- 同一 `index` 重复提交：**幂等覆盖**（先写 `.part.tmp` 再 `rename`），便于客户端在响应丢失后重试。
- 会话 `state !== 'uploading'`（例如正在 complete）→ 409。

### 4.3 查询进度（续传）

```
GET /server/deps/:code/uploads/:uploadId
```

```json
{
  "uploadId": "9f2c...",
  "code": "office-tool",
  "version": "1.4.2",
  "fileName": "OfficeTool.exe",
  "size": 2147483648,
  "chunkSize": 8388608,
  "totalChunks": 256,
  "received": [0, 1, 2, 3, 5],
  "receivedBytes": 41943040,
  "state": "uploading",
  "expiresAt": "2025-11-26T10:00:00.000Z"
}
```

### 4.4 完成合并

```
POST /server/deps/:code/uploads/:uploadId/complete
Content-Type: application/json

{ "expectedSha256": "可选，客户端预计算的 sha256" }
```

```json
// 201，结构与现有上传接口一致
{ "ok": true, "asset": { "...": "..." }, "version": { "...": "..." } }
```

- 分片不齐 → 422，返回 `{ message, missing: [12, 13] }`，会话保留。
- 正在合并 → 409 `{ message: '正在写入制品库，请稍候' }`，前端改为轮询 `GET`。
- 版本冲突 → 409，删除会话（不可恢复）。
- sha256 不一致 / 空文件 / 超限 → 422 / 413，删除会话（不可恢复）。
- Gitea 502 / 网络错误 → 502，**保留会话**，允许再次调用 complete 重试。

### 4.5 取消

```
DELETE /server/deps/:code/uploads/:uploadId   → 204（会话不存在也返回 204，幂等）
```

---

## 5. 服务端实现

### 5.1 目录布局

```
<DEP_UPLOAD_DIR>/
  9f2c1d7a4b8e4c3f9a1b2c3d4e5f6a7b/
    meta.json
    000000.part
    000001.part
    ...
    000255.part
```

- 目录名即 `uploadId`（`crypto.randomBytes(16).toString('hex')`），不包含任何用户输入，天然避免路径穿越。
- `meta.json` 先写临时文件再 `rename`，保证原子性。

`meta.json` 字段：

```json
{
  "id": "9f2c1d7a4b8e4c3f9a1b2c3d4e5f6a7b",
  "code": "office-tool",
  "version": "1.4.2",
  "fileName": "OfficeTool.exe",
  "size": 2147483648,
  "chunkSize": 8388608,
  "totalChunks": 256,
  "changelog": "修复若干问题",
  "actor": "平台管理员",
  "state": "uploading",
  "createdAt": "2025-11-19T10:00:00.000Z",
  "updatedAt": "2025-11-19T10:20:00.000Z",
  "expiresAt": "2025-11-26T10:00:00.000Z"
}
```

`state` 取值：`uploading | finalizing | done | failed`。

### 5.2 新模块 `manage/server/lib/dep/upload-sessions.js`

```js
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { HttpError } from '../http-error.js'

const ID_RE = /^[a-f0-9]{32}$/
const PART_RE = /^(\d{6})\.part$/

export class UploadSessions {
  #locks = new Map()

  constructor({ root, ttlMs, maxFileBytes, defaultChunkBytes = 8 * 1024 * 1024 }) {
    this.root = path.resolve(root)
    this.ttlMs = ttlMs
    this.maxFileBytes = maxFileBytes
    this.defaultChunkBytes = defaultChunkBytes
  }

  dir(id) {
    if (!ID_RE.test(String(id || ''))) throw new HttpError(400, '上传会话不合法')
    return path.join(this.root, id)
  }

  partPath(id, index) {
    return path.join(this.dir(id), `${String(index).padStart(6, '0')}.part`)
  }

  /** 同一会话串行化：避免「最后一片写入」和「complete」并发 */
  async withSession(id, fn) {
    const prev = this.#locks.get(id) || Promise.resolve()
    let release
    const current = new Promise((resolve) => (release = resolve))
    const chained = prev.then(() => current)
    this.#locks.set(id, chained)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.#locks.get(id) === chained) this.#locks.delete(id)
    }
  }
}
```

> `#locks` 的实现只需保证同一 uploadId 串行；上面是简化版，落地时把 `Map` 值换成「上一个 Promise」即可。

创建会话：

```js
async create({ code, version, fileName, size, chunkSize, changelog, actor }) {
  const total = Number(size)
  if (!Number.isInteger(total) || total <= 0) throw new HttpError(422, '文件大小不合法')
  if (total > this.maxFileBytes) throw new HttpError(413, `单文件不能超过 ${this.maxFileBytes} 字节`)

  const chunk = clamp(Number(chunkSize) || this.defaultChunkBytes, 1024 * 1024, 32 * 1024 * 1024)
  const totalChunks = Math.ceil(total / chunk)
  const id = crypto.randomBytes(16).toString('hex')
  const dir = this.dir(id)
  await fsp.mkdir(dir, { recursive: true })

  const now = Date.now()
  const meta = {
    id, code, version, fileName,
    size: total, chunkSize: chunk, totalChunks,
    changelog: changelog || '', actor: actor || '',
    state: 'uploading',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + this.ttlMs).toISOString(),
  }
  await this.#writeMeta(dir, meta)
  return meta
}
```

写入分片（核心）：

```js
async putChunk({ code, uploadId, index, stream, length }) {
  return this.withSession(uploadId, async () => {
    const meta = await this.#readMeta(this.dir(uploadId))
    if (meta.code !== code) throw new HttpError(404, '上传会话不存在')
    if (meta.state !== 'uploading') throw new HttpError(409, '上传会话正在写入制品库')
    if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
      throw new HttpError(400, '分片序号不合法')
    }

    const expected =
      index < meta.totalChunks - 1
        ? meta.chunkSize
        : meta.size - meta.chunkSize * (meta.totalChunks - 1)

    if (length && length !== expected) throw new HttpError(400, `分片长度应为 ${expected} 字节`)

    const target = this.partPath(uploadId, index)
    const tmp = `${target}.tmp`
    let written = 0
    const counter = new Transform({
      transform(buf, _enc, cb) {
        written += buf.length
        if (written > expected) return cb(new HttpError(400, '分片超出预期长度'))
        cb(null, buf)
      },
    })

    try {
      await pipeline(stream, counter, fs.createWriteStream(tmp))
      if (written !== expected) throw new HttpError(400, `分片长度应为 ${expected} 字节`)
      await fsp.rename(tmp, target) // 原子替换，重复提交幂等
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }

    const now = new Date()
    meta.updatedAt = now.toISOString()
    meta.expiresAt = new Date(now.getTime() + this.ttlMs).toISOString() // 滑动续期
    await this.#writeMeta(this.dir(uploadId), meta)
    const received = await this.listParts(meta)
    return {
      index,
      received: received.length,
      receivedBytes: received.length * meta.chunkSize, // 仅用于粗略进度，精确值见 describe
    }
  })
}
```

查询与完整性校验：

```js
async listParts(meta) {
  const names = await fsp.readdir(this.dir(meta.id))
  return names
    .map((n) => PART_RE.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

async describe({ code, uploadId }) {
  const meta = await this.#readMeta(this.dir(uploadId))
  if (meta.code !== code) throw new HttpError(404, '上传会话不存在')
  const indexes = await this.listParts(meta)
  let bytes = 0
  for (const i of indexes) {
    const st = await fsp.stat(this.partPath(uploadId, i))
    bytes += st.size
  }
  return { ...meta, received: indexes, receivedBytes: bytes }
}

async assertComplete({ code, uploadId }) {
  const info = await this.describe({ code, uploadId })
  if (info.state !== 'uploading' && info.state !== 'failed') {
    throw new HttpError(409, '上传会话正在写入制品库')
  }
  const missing = []
  for (let i = 0; i < info.totalChunks; i += 1) {
    if (!info.received.includes(i)) missing.push(i)
  }
  if (missing.length) {
    throw new HttpError(422, '分片不完整', { missing })
  }
  if (info.receivedBytes !== info.size) {
    throw new HttpError(422, '分片总大小与文件大小不一致')
  }
  return info
}
```

按序读分片（不合并成大文件）：

```js
openStream(meta) {
  const self = this
  async function* generate() {
    for (let i = 0; i < meta.totalChunks; i += 1) {
      const rs = fs.createReadStream(self.partPath(meta.id, i))
      for await (const buf of rs) yield buf
    }
  }
  return Readable.from(generate())
}
```

状态与清理：

```js
async markState(uploadId, state) {
  const dir = this.dir(uploadId)
  const meta = await this.#readMeta(dir)
  meta.state = state
  meta.updatedAt = new Date().toISOString()
  await this.#writeMeta(dir, meta)
  return meta
}

async remove(uploadId) {
  await fsp.rm(this.dir(uploadId), { recursive: true, force: true })
}

async sweep() {
  await fsp.mkdir(this.root, { recursive: true })
  const entries = await fsp.readdir(this.root, { withFileTypes: true })
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue
    const dir = path.join(this.root, entry.name)
    try {
      const meta = await this.#readMeta(dir)
      if (Date.parse(meta.expiresAt) <= now) await fsp.rm(dir, { recursive: true, force: true })
    } catch {
      // meta 损坏：按目录 mtime 兜底
      const st = await fsp.stat(dir)
      if (now - st.mtimeMs > this.ttlMs) await fsp.rm(dir, { recursive: true, force: true })
    }
  }
}
```

`#readMeta` / `#writeMeta` 负责 JSON 解析与「临时文件 + rename」原子写，并在 `meta.code` 与路径不一致时抛 404。

### 5.3 路由 `manage/server/routes/dep-uploads.js`

由 `mountDepRoutes` 统一注册，仍复用 `requireAdmin`。

```js
export function mountDepUploadRoutes(app, { config, store, sessions, requireAdmin, wrap }) {
  app.post(
    '/server/deps/:code/uploads',
    requireAdmin,
    wrap(async (req, res) => {
      const code = assertCode(decodeURIComponent(req.params.code))
      const version = assertVersion(req.body?.version)
      const fileName = String(req.body?.fileName || '').trim()
      if (!fileName) throw new HttpError(422, '文件名必填')

      const manifest = await store.getManifest(code) // 不存在内部抛 404
      if (manifest.versions?.some((v) => v.version === version)) {
        throw new HttpError(409, `版本 ${version} 已存在`)
      }

      const meta = await sessions.create({
        code, version, fileName,
        size: Number(req.body?.size),
        chunkSize: Number(req.body?.chunkSize) || undefined,
        changelog: String(req.body?.changelog || ''),
        actor: req.admin?.n || '',
      })
      res.status(201).json({
        uploadId: meta.id,
        chunkSize: meta.chunkSize,
        totalChunks: meta.totalChunks,
        received: [],
        expiresAt: meta.expiresAt,
      })
    }),
  )

  app.put(
    '/server/deps/:code/uploads/:uploadId/chunks/:index',
    requireAdmin,
    wrap(async (req, res) => {
      const code = assertCode(decodeURIComponent(req.params.code))
      const uploadId = String(req.params.uploadId || '')
      try {
        const result = await sessions.putChunk({
          code,
          uploadId,
          index: Number(req.params.index),
          stream: req, // 直接流式写盘，不经过 express.raw
          length: Number(req.headers['content-length']) || 0,
        })
        res.json(result)
      } catch (err) {
        // 与现有上传路由一致：提前失败时强制断连，避免浏览器进度条卡死
        res.setHeader('Connection', 'close')
        res.on('finish', () => req.destroy())
        throw err
      }
    }),
  )

  app.get(
    '/server/deps/:code/uploads/:uploadId',
    requireAdmin,
    wrap(async (req, res) => {
      const code = assertCode(decodeURIComponent(req.params.code))
      res.json(await sessions.describe({ code, uploadId: req.params.uploadId }))
    }),
  )

  app.post(
    '/server/deps/:code/uploads/:uploadId/complete',
    requireAdmin,
    wrap(async (req, res) => {
      const code = assertCode(decodeURIComponent(req.params.code))
      const uploadId = req.params.uploadId
      const meta = await sessions.assertComplete({ code, uploadId })

      await sessions.markState(uploadId, 'finalizing')
      try {
        const result = await store.addVersion(code, {
          version: meta.version,
          fileName: meta.fileName,
          stream: sessions.openStream(meta),
          declaredSize: meta.size,
          expectedSha256: String(req.body?.expectedSha256 || ''),
          changelog: meta.changelog,
          actor: meta.actor,
        })
        await sessions.remove(uploadId) // 成功即清理
        res.status(201).json({ ok: true, ...result })
      } catch (err) {
        // 409/422/413 属于不可恢复错误，清会话；502/507 保留会话允许重试
        const status = err instanceof HttpError ? err.status : 502
        if (status === 409 || status === 413 || status === 422) {
          await sessions.remove(uploadId).catch(() => {})
        } else {
          await sessions.markState(uploadId, 'failed').catch(() => {})
        }
        throw err
      }
    }),
  )

  app.delete(
    '/server/deps/:code/uploads/:uploadId',
    requireAdmin,
    wrap(async (req, res) => {
      const code = assertCode(decodeURIComponent(req.params.code))
      const meta = await sessions.describe({ code, uploadId: req.params.uploadId }).catch(() => null)
      if (meta) await sessions.remove(req.params.uploadId)
      res.status(204).end()
    }),
  )
}
```

### 5.4 与现有代码的衔接

- **不需要改 `store.js` / `storage.js`**：`addVersion` 的入参 `stream` 可以接受任意 `Readable`，`Readable.from(asyncGenerator)` 完全兼容；`declaredSize` 用会话里的 `size`，现有 413 判断、sha256 计算、两段写、回滚、审计全部复用。
- **保留旧接口** `POST /server/deps/:code/versions`（[routes/deps.js](./server/routes/deps.js#L146-L183)）不动，供脚本/CLI/小文件使用。
- `app.js` 只需在 `mountDepRoutes` 之后再挂载新路由，或在 `mountDepRoutes` 内部注册；`init()` 里调用一次 `sessions.sweep()`，并启动每小时清理定时器（`.unref()`）。
- 现有的 `Connection: close` + `req.destroy()` 失败处理模式在分片路由里继续沿用（见 5.3）。

### 5.5 并发与状态保护

- `withSession()` 保证同一 uploadId 的「写分片」与「complete」串行。
- `markState('finalizing')` 之后，新的分片请求返回 409，避免合并过程中分片被替换。
- 两个 complete 并发：第二个在 `assertComplete` 里看到 `state === 'finalizing'` → 409，前端改为轮询 `GET` 获取最终结果。
- 服务重启后，`state === 'finalizing'` 的会话无法自动恢复（`addVersion` 已中断）：启动清理时标记为 `failed` 或直接删除，由前端重新 complete。

---

## 6. 前端实现

### 6.1 API 封装（每片一个 XHR）

沿用现有 [api/deps.js](./web/src/api/deps.js#L83-L120) 的 XHR 模式，是因为 fetch + ReadableStream 在代理环境会报 `ERR_ALPN_NEGOTIATION_FAILED`；分片场景下每片仍是普通 XHR，天然可用。

```js
export function createDepUpload({ code, version, file, changelog, chunkSize }) {
  return requestJson(`/server/deps/${encodeURIComponent(code)}/uploads`, {
    method: 'POST',
    body: JSON.stringify({
      version,
      fileName: file.name,
      size: file.size,
      chunkSize,
      changelog: changelog || '',
    }),
  })
}

export function putDepChunk({ code, uploadId, index, blob, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/server/deps/${encodeURIComponent(code)}/uploads/${uploadId}/chunks/${index}`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText || '{}')) } catch { resolve({}) }
      } else {
        reject(new Error(parseMessage(xhr.responseText) || `分片上传失败（${xhr.status}）`))
      }
    }
    xhr.onerror = () => reject(new Error('网络异常，分片上传中断'))
    xhr.onabort = () => reject(Object.assign(new Error('已暂停'), { name: 'AbortError' }))
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(blob)
  })
}

export function getDepUpload({ code, uploadId }) {
  return requestJson(`/server/deps/${encodeURIComponent(code)}/uploads/${uploadId}`)
}

export function completeDepUpload({ code, uploadId, expectedSha256 }) {
  return requestJson(`/server/deps/${encodeURIComponent(code)}/uploads/${uploadId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ expectedSha256: expectedSha256 || '' }),
  })
}

export function cancelDepUpload({ code, uploadId }) {
  return requestJson(`/server/deps/${encodeURIComponent(code)}/uploads/${uploadId}`, {
    method: 'DELETE',
  })
}
```

### 6.2 编排函数 `uploadDepVersionChunked`

```js
const DEFAULT_CHUNK = 8 * 1024 * 1024
const STORAGE_KEY = (code, version, file) =>
  `dep-upload:${code}:${version}:${file.name}:${file.size}:${file.lastModified}`

export async function uploadDepVersionChunked({
  code, version, file, changelog, onProgress, onPhase, signal,
}) {
  onPhase?.('preparing')

  // 1. 尝试恢复上次会话
  let uploadId = localStorage.getItem(STORAGE_KEY(code, version, file))
  let info = null
  if (uploadId) {
    info = await getDepUpload({ code, uploadId }).catch(() => null)
    // 文件/大小/版本对不上，丢弃旧会话
    if (!info || info.size !== file.size || info.version !== version) {
      if (info) await cancelDepUpload({ code, uploadId }).catch(() => {})
      uploadId = null
    }
  }

  // 2. 没有会话就新建
  if (!uploadId) {
    const created = await createDepUpload({ code, version, file, changelog, chunkSize: DEFAULT_CHUNK })
    uploadId = created.uploadId
    localStorage.setItem(STORAGE_KEY(code, version, file), uploadId)
    info = { ...created, received: [] }
  }

  const { chunkSize, totalChunks, size } = info
  const received = new Set(info.received || [])
  let doneBytes = 0
  for (const i of received) {
    doneBytes += i < totalChunks - 1 ? chunkSize : size - chunkSize * (totalChunks - 1)
  }

  // 3. 顺序补齐缺失分片，单片失败重试 3 次
  for (let index = 0; index < totalChunks; index += 1) {
    if (received.has(index)) continue
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, size)
    const blob = file.slice(start, end)

    let attempt = 0
    for (;;) {
      try {
        await putDepChunk({
          code, uploadId, index, blob, signal,
          onProgress: (loaded) => {
            const pct = Math.min(100, Math.round(((doneBytes + loaded) / size) * 100))
            onProgress?.(pct, doneBytes + loaded, size)
          },
        })
        break
      } catch (err) {
        if (err.name === 'AbortError') throw err
        if (attempt >= 2 || isPermanent(err)) throw err
        attempt += 1
        await sleep(1000 * 2 ** attempt)
      }
    }
    doneBytes += blob.size
  }

  // 4. 合并落库（可能持续较久，UI 显示“写入制品库中”）
  onPhase?.('finalizing')
  const result = await completeDepUpload({ code, uploadId })
  localStorage.removeItem(STORAGE_KEY(code, version, file))
  onPhase?.('idle')
  return { uploadId, ...result }
}
```

要点：

- `file.slice()` 不会把整文件读进内存，浏览器按需读取。
- 暂停 = `AbortController.abort()` 中断当前片；捕获 `AbortError` 后**保留** `uploadId` 和 localStorage 记录。
- 继续 = 重新执行同一函数：先 `GET` 会话拿 `received`，自动跳过已收分片。
- 取消 = 调 `cancelDepUpload` 并清 localStorage。
- 若要做客户端 sha256 预校验，用**分片流式**计算，不要用现有 [hash.js](./web/src/utils/hash.js#L6-L32)（它会把整个文件读进内存，2 GiB 会 OOM）。

### 6.3 页面状态机改造

现有 [AdminDepDetail.jsx](./web/src/pages/admin/AdminDepDetail.jsx#L93-L181) 调整：

```
idle → preparing → uploading ⇄ paused → finalizing → idle
                        ↘ error
```

- `preparing`：建会话/恢复会话。
- `paused`：当前分片被中断，`uploadId` 保留，按钮文案「继续上传（已传 x%）」。
- `finalizing`：进度 100% 后等待 `complete` 返回，文案「正在写入制品库…」，禁止重复提交。
- 速度：用 1 秒窗口的字节差计算，避免按分片跳变。
- 错误：区分「不可恢复（409/413/422）」与「可重试（网络/502）」，后者保留会话与按钮。

### 6.4 兼容策略

- 保留 `uploadDepVersion` 与 `POST /server/deps/:code/versions`。
- 推荐管理页面统一走分片（代码路径单一）；如果希望小文件少几次请求，可按 `file.size < 16 MiB` 回落旧接口。
- 旧接口的注释里「浏览器不支持断点续传」需要同步更新为新语义。

---

## 7. 配置项

```js
// manage/server/lib/config.js 追加
depUploadDir: process.env.DEP_UPLOAD_DIR || '.uploads',
depUploadTtlMs: num(process.env.DEP_UPLOAD_TTL_MS, 24 * 3600 * 1000),
depUploadChunkBytes: num(process.env.DEP_UPLOAD_CHUNK_BYTES, 8 * 1024 * 1024),
```

```dotenv
# manage/server/.env.example 追加
# 分片临时目录（相对 server 进程 cwd，需可写；代码里用 path.resolve 归一化）
DEP_UPLOAD_DIR=.uploads
# 会话保留时长（滑动续期：每次成功写入分片后顺延）
DEP_UPLOAD_TTL_MS=86400000
# 默认分片大小（字节），服务端夹在 1 MiB ~ 32 MiB
DEP_UPLOAD_CHUNK_BYTES=8388608
```

- `DEP_UPLOAD_DIR` 必须排除在版本库之外（加入 `.gitignore`）。
- 部署时确认该目录所在分区剩余空间 ≥ 最大单文件大小；否则 `ENOSPC` 时返回 507。

---

## 8. 安全与边界

| 项 | 处理 |
|---|---|
| uploadId | 服务端 `randomBytes(16).hex`，入参用 `/^[a-f0-9]{32}$/` 校验，不参与任何用户可控路径拼接 |
| 分片序号 | 必须为 `0..totalChunks-1` 的整数，拒绝 `NaN`、小数、负数、超界 |
| 路径穿越 | 只用 uploadId 与补零序号拼路径，从不使用原始文件名 |
| 身份 | 所有接口 `requireAdmin`；`meta.actor` 由服务端写入，客户端不可伪造 |
| 累计大小 | 建会话时用 `size` 判 413；每片写入时校验期望长度；complete 时再核对总字节数 |
| 磁盘耗尽 | 写入失败映射为 507；sweep 定期清理 |
| 会话过期 | 滑动 TTL：每次成功写分片刷新 `expiresAt`；`sweep()` 启动时一次 + 每小时一次 |
| 并发 | `withSession` 串行；`state` 状态机阻断合并期间写入 |
| 崩溃残留 | 启动 sweep；`meta.json` 损坏时按目录 mtime 兜底删除 |

---

## 9. 错误码表

| 接口 | 场景 | 状态码 | 前端行为 |
|---|---|---|---|
| create | 资产不存在 | 404 | toast |
| create | 版本已存在 | 409 | 阻止上传 |
| create | 大小超限 | 413 | toast |
| chunk | 会话不存在/不属于该 code | 404 | 重新建会话 |
| chunk | 序号/长度不合法 | 400 | 视为不可恢复 |
| chunk | 正在合并 | 409 | 轮询 GET |
| chunk | 客户端中断 | 连接关闭 | 记为暂停，可续传 |
| complete | 分片不齐 | 422 + `missing` | 补传缺失分片 |
| complete | sha256 不一致 | 422 | 提示文件损坏，重传 |
| complete | 版本冲突 | 409 | 清会话，提示改版本 |
| complete | Gitea 502 | 502 | 保留会话，可重试 |
| 任意 | 未登录/过期 | 401 | 跳登录 |

---

## 10. 测试清单

**接口级（curl）**

```bash
# 1) 建会话
curl -X POST http://127.0.0.1:8788/server/deps/demo/uploads \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"version":"1.0.0","fileName":"demo.zip","size":10485760,"chunkSize":4194304}'

# 2) 传分片（3 片）
curl -X PUT "http://127.0.0.1:8788/server/deps/demo/uploads/$ID/chunks/0" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @part0

# 3) 查进度（模拟续传）
curl "http://127.0.0.1:8788/server/deps/demo/uploads/$ID" -H "Authorization: Bearer $TOKEN"

# 4) 完成
curl -X POST "http://127.0.0.1:8788/server/deps/demo/uploads/$ID/complete" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

| 用例 | 预期 |
|---|---|
| 上传到一半暂停，再继续 | 从缺失分片开始，不重传 |
| 刷新页面后继续 | 通过 localStorage 找到 uploadId 并续传 |
| 同一分片重复提交 | 覆盖成功，总字节数不变 |
| 缺片直接 complete | 422，返回 `missing` 列表 |
| 分片长度不符 | 400，临时文件被清理 |
| 版本冲突 | 409，会话被删除 |
| sha256 不一致 | 422，会话被删除，Gitea 无残留制品 |
| Gitea 不可达 | 502，会话保留，恢复后可重试 complete |
| TTL 到期 | sweep 删除目录，GET 返回 404 |
| 2 GiB / 8 MiB | 256 片全部成功，sha256 一致 |
| 磁盘写满 | 507，临时文件清理，会话可重试 |
| 旧接口回归 | `POST /versions` 行为不变 |

---

## 11. 实施步骤

1. `config.js` 增加 3 个配置，同步 `.env.example` 与 `.gitignore`。
2. 新增 `server/lib/dep/upload-sessions.js`（会话存储：create/putChunk/describe/assertComplete/openStream/remove/sweep）。
3. 新增 `server/routes/dep-uploads.js`，在 `mountDepRoutes` 中注册 5 个接口。
4. `app.js` 的 `init()` 调用 `sessions.sweep()`，启动每小时清理定时器（`.unref()`）。
5. 前端 `api/deps.js` 增加 5 个接口封装与 `uploadDepVersionChunked` 编排函数。
6. `AdminDepDetail.jsx` 改为 `preparing/uploading/paused/finalizing` 状态机，更新暂停/继续文案与 localStorage 逻辑。
7. 更新 `README.md`：上传链路章节、临时目录与清理策略、旧接口保留说明。
8. 按第 10 节测试清单逐项验证，重点覆盖 2 GiB 与中断续传。

---

## 12. 风险与取舍

**优点**

- 零新增依赖，接口语义完全贴合现有仓储与错误体系。
- 分片文件即断点状态，不依赖数据库；重启后仍可续传（只要目录还在）。
- complete 复用 `addVersion`，落库行为与现状完全一致，回滚/审计无需重做。
- 上传阶段不持全局写锁，只有 finalize 持锁。

**风险**

- 自研协议边界需要自己兜：幂等、乱序、过期、崩溃残留、状态机竞态，测试成本高于 tus。
- 需要本地可写磁盘，且峰值 ≈ 并发会话文件大小之和；磁盘满时要有明确降级（507 + 清理）。
- 2 GiB / 8 MiB = 256 个请求，HTTP 开销比单请求大；可把分片调到 16–32 MiB 折中。
- complete 阶段要顺序读盘再 PUT 到 Gitea，期间进度条停在 100%，必须用 `finalizing` 状态避免用户误判卡死；同时该阶段仍持有全局写锁，会阻塞其他资产写操作（与现状相同）。
- 反向代理需要允许 `PUT` 与 `application/octet-stream`，并关闭请求体缓冲（如 Nginx `proxy_request_buffering off`），否则分片上传会退化成“整段缓冲”。
- 若生产环境不允许落盘，应改走方案 C（分片暂存为 Gitea 临时包再拼接）或对象存储 multipart 上传。

**与方案 A 的对比**

| 维度 | 方案 A（tus） | 方案 B（自研） |
|---|---|---|
| 新增依赖 | 3 个 | 0 个 |
| 自身代码量 | 约 150 行 | 约 400 行 |
| 断点粒度 | 每次 PATCH | 每个分片文件 |
| 协议边界 | 库负责 | 自己负责 |
| 与现有仓储契合度 | 通过 finalize 钩子衔接 | 直接复用 `addVersion` |
| 调试与可控性 | 受库约束 | 完全可控 |
| 本地磁盘 | 需要 | 需要 |

若团队接受新增依赖、希望把协议细节交给成熟库，选 A；若坚持零依赖、追求与现有代码风格和错误体系一致，选 B。
