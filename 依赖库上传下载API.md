# 依赖库上传下载 API

配套方案：`MinIO存储与分片上传方案.md`。
适用服务：`manage/server`（8788），生产环境由 Hub 的 `DependencyModule` 承载同一套契约。

---

## 1 通用约定

| 项 | 约定 |
| --- | --- |
| Base | 管理端 `/server/**`，客户端 `/client/**`（网关按前缀路由，不新增路由） |
| 鉴权 | `Authorization: Bearer <token>`；`/server/**` 需管理员，`/client/**` 需任意登录用户 |
| 内容类型 | 分片与制品为 `application/octet-stream`；其余 JSON 为 `application/json; charset=utf-8` |
| 时间 | ISO 8601 UTC，如 `2026-11-19T08:34:32.000Z` |
| 大小 | 字节数，整数。超过 `2^53-1` 不支持（实际上限 20 GiB，无风险） |
| 校验和 | 小写 hex，64 字符。**唯一可信源是服务端实算值**，客户端提供值仅用于比对 |
| 缓存 | 所有 `/server/**`、`/client/**` 响应 `Cache-Control: no-store` |
| 幂等 | 查询、删除、分片重传幂等；创建会话与完成不幂等（重复返回 409） |
| 压缩 | 不启用。分片与制品传输不压缩（exe 本身已压缩） |

### 1.1 错误响应

统一结构：

```json
{
  "message": "版本 1.4.2 已存在，版本不可覆盖",
  "code": "VERSION_EXISTS",
  "extra": { "version": "1.4.2" }
}
```

`message` 面向用户直接展示，`code` 面向程序分支，`extra` 视场景附加。`code` 在本文档 §8 全量列出。

### 1.2 路径参数

`{code}`、`{version}`、`{uploadId}` 均为路径段，客户端必须 `encodeURIComponent`。服务端对 `{code}` 做 `assertCode()` 校验（小写字母/数字/点/下划线/连字符，2~40 位），对 `{version}` 做 semver 校验。

---

## 2 端点总览

### 2.1 分片上传（新增）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| 1 | POST | `/server/deps/{code}/uploads` | 创建上传会话 |
| 2 | GET | `/server/deps/{code}/uploads` | 列出该资产进行中的会话 |
| 3 | GET | `/server/deps/{code}/uploads/{uploadId}` | 查会话 + 已上传分片（续传用） |
| 4 | PUT | `/server/deps/{code}/uploads/{uploadId}/parts/{partNumber}` | 上传一片 |
| 5 | POST | `/server/deps/{code}/uploads/{uploadId}/complete` | 完成并登记版本 |
| 6 | DELETE | `/server/deps/{code}/uploads/{uploadId}` | 放弃会话 |

### 2.2 单请求直传（保留兼容）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| 7 | POST | `/server/deps/{code}/versions` | 裸流一次传完，内部转单分片 |

### 2.3 客户端（不变）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| 8 | GET | `/client/deps/catalog` | 目录 |
| 9 | GET | `/client/deps/{code}` | 资产详情 |
| 10 | GET | `/client/deps/{code}/versions` | 版本列表 |
| 11 | GET/HEAD | `/client/deps/{code}/versions/{version}/download` | 下载，支持 Range |

### 2.4 其它（不变）

`POST /server/deps`、`PUT /server/deps/{code}`、`DELETE /server/deps/{code}`、
`POST /server/deps/{code}/enable|disable|take-down|restore`、
`POST /server/deps/{code}/versions/{version}/enable|disable`、
`DELETE /server/deps/{code}/versions/{version}`、`GET /server/deps`、`GET /server/deps/stats`、
`GET /server/deps/meta`、`GET /server/audit`、`POST /server/auth/login`、`GET /server/me`。

---

## 3 创建上传会话

```
POST /server/deps/{code}/uploads
Content-Type: application/json
Authorization: Bearer <token>
```

### 3.1 请求体

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | string | 是 | semver，如 `1.4.2` / `2.0.0-rc.1` |
| `fileName` | string | 是 | 原始文件名，含扩展名。仅作展示，存储名会被压平成 `.dat` |
| `size` | number | 是 | 文件总字节数。必须与实际上传总量一致，否则 complete 返回 422 |
| `sha256` | string | 是 | 整体 sha256（小写 hex，64 位）。`DEP_VERIFY_MODE=none` 时可为空串 |
| `changelog` | string | 否 | 变更说明，超过 500 字截断 |
| `partSize` | number | 否 | 期望分片大小。服务端取 `max(自动计算值, 本值)`，下限 5 MiB（S3 规范），上限 64 MiB |

```json
{
  "version": "1.4.2",
  "fileName": "VC_redist.x64.exe",
  "size": 2147483648,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "changelog": "修复 Win7 下缺少 api-ms-win-crt 的问题",
  "partSize": 8388608
}
```

### 3.2 响应 `201`

```json
{
  "uploadId": "up_7f3k9m2q8x1c4v6b0n5z",
  "code": "vc-redist",
  "version": "1.4.2",
  "fileName": "VC_redist.x64.exe",
  "storageName": "VC_redist.x64.dat",
  "objectKey": "vc-redist/1.4.2/VC_redist.x64.dat",
  "size": 2147483648,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "changelog": "修复 Win7 下缺少 api-ms-win-crt 的问题",
  "partSize": 8388608,
  "partCount": 256,
  "state": "created",
  "receivedParts": 0,
  "receivedBytes": 0,
  "createdAt": "2026-11-19T08:34:32.000Z",
  "expiresAt": "2026-11-20T08:34:32.000Z",
  "actor": "平台管理员"
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `uploadId` | 会话标识，`up_` + 22 位 base32。**客户端持久化它才能续传** |
| `objectKey` | 制品最终对象 key，与 manifest 的 `files[0].path` 一致 |
| `partSize` | 服务端最终确定的单片字节数（可能大于请求值） |
| `partCount` | 总片数，`ceil(size / partSize)`，取值 1~10000 |
| `state` | `created` / `uploading` / `completing` / `done` / `aborted` / `expired` |

### 3.3 错误

| 状态 | code | 场景 |
| --- | --- | --- |
| 404 | `ASSET_NOT_FOUND` | 资产未登记 |
| 409 | `VERSION_EXISTS` | 该 `version` 已有版本行 |
| 409 | `UPLOAD_IN_PROGRESS` | 同资产同版本已有未完成会话（响应带 `existingUploadId`，客户端可复用） |
| 413 | `FILE_TOO_LARGE` | `size > DEP_MAX_FILE_BYTES` |
| 422 | `INVALID_VERSION` | 版本号不符合 semver |
| 422 | `INVALID_SIZE` | `size ≤ 0` 或非整数 |
| 422 | `INVALID_CHECKSUM` | `sha256` 非 64 位 hex（且 `DEP_VERIFY_MODE ≠ none`） |
| 502 | `STORAGE_UNAVAILABLE` | MinIO 不可达 |

> `UPLOAD_IN_PROGRESS` 是刻意设计的：同一版本重复点「上传」不应产生两份分片，直接返回已有会话让客户端续传。

---

## 4 查询上传会话（续传入口）

```
GET /server/deps/{code}/uploads/{uploadId}
```

### 4.1 响应 `200`

```json
{
  "uploadId": "up_7f3k9m2q8x1c4v6b0n5z",
  "code": "vc-redist",
  "version": "1.4.2",
  "fileName": "VC_redist.x64.exe",
  "objectKey": "vc-redist/1.4.2/VC_redist.x64.dat",
  "size": 2147483648,
  "sha256": "9f86d0…0a08",
  "partSize": 8388608,
  "partCount": 256,
  "state": "uploading",
  "receivedParts": 137,
  "receivedBytes": 1149239296,
  "percent": 53,
  "parts": [
    { "partNumber": 1, "size": 8388608, "etag": "\"b1c2…\"", "uploadedAt": "2026-11-19T08:35:02.000Z" },
    { "partNumber": 2, "size": 8388608, "etag": "\"c3d4…\"", "uploadedAt": "2026-11-19T08:35:09.000Z" }
  ],
  "missingParts": [138, 139, 140, "…"],
  "expiresAt": "2026-11-20T08:34:32.000Z"
}
```

| 字段 | 说明 |
| --- | --- |
| `parts` | 已上传分片，**来自 S3 `ListParts`，不是会话 JSON**。S3 是唯一事实源 |
| `missingParts` | 差集（按片号升序）。超过 200 个时只返回前 200 个并置 `truncated: true`，客户端自行按 `1..partCount` 减去 `parts` 计算全量 |
| `percent` | `floor(receivedBytes / size * 100)`，仅供参考，客户端应自己算 |

### 4.2 错误

| 状态 | code | 场景 |
| --- | --- | --- |
| 404 | `UPLOAD_NOT_FOUND` | 会话不存在或已被清理 |
| 410 | `UPLOAD_EXPIRED` | 超过 `expiresAt`。服务端此时已 Abort 分片 |
| 409 | `UPLOAD_COMPLETED` | 已完成，响应带 `versionUrl` 指向资产详情 |

> 会话已 `done` 时再查，返回 409 而不是 200 —— 客户端遇到它应直接刷新资产详情，不要再尝试上传。

---

## 5 上传分片

```
PUT /server/deps/{code}/uploads/{uploadId}/parts/{partNumber}
Content-Type: application/octet-stream
Content-Length: 8388608
X-Chunk-Sha256: <该片 sha256，小写 hex，可选但推荐>
Authorization: Bearer <token>

<8 MiB 二进制>
```

### 5.1 约束

| 项 | 规则 |
| --- | --- |
| `partNumber` | 1 ~ `partCount`，闭区间。越界 400 |
| `Content-Length` | **必须存在**，缺失 411 |
| 片大小 | 除最后一片外必须等于 `partSize`；最后一片 `= size - (partCount-1)*partSize` |
| 并发 | 允许乱序、允许并发（建议 ≤ 4） |
| 重传 | 同 `partNumber` 再次 PUT 覆盖前一次（S3 语义），不算错误 |
| 超时 | 单片默认 5 分钟，超过连接被断 |

### 5.2 响应 `200`

```json
{
  "partNumber": 137,
  "etag": "\"d41d8cd98f00b204e9800998ecf8427e\"",
  "size": 8388608,
  "totalParts": 256
}
```

| 字段 | 说明 |
| --- | --- |
| `etag` | S3 分片 ETag。**仅服务端 Complete 时用，客户端不回传，更不要当文件校验和** |
| `totalParts` | 总片数，供客户端核对切片逻辑 |

> 这里**故意不返回** `receivedParts` / `percent`：每片都去 `ListParts` 会让 256 片多出 256 次对象存储请求。进度以客户端自己的累计为准（它本来就知道自己传完了多少）；需要准确值就调 `GET /uploads/{id}`。

### 5.3 片大小的硬约束

除最后一片外，每片**不得小于 5 MiB**（S3 规范）。服务端返回的 `partSize` 已保证 ≥ 5 MiB，客户端不要自行改小；改了的表现是分片都传成功、`complete` 却报 `EntityTooSmall`。

### 5.4 错误

| 状态 | code | 场景 | 客户端动作 |
| --- | --- | --- | --- |
| 400 | `INVALID_PART_NUMBER` | 片号越界 | 修正后重试 |
| 404 | `UPLOAD_NOT_FOUND` | 会话没了 | 重新创建会话 |
| 409 | `UPLOAD_COMPLETED` | 已完成 | 停止上传 |
| 410 | `UPLOAD_EXPIRED` | 会话过期 | 重新创建会话 |
| 411 | `LENGTH_REQUIRED` | 无 `Content-Length` | 补齐头后重试 |
| 413 | `PART_TOO_LARGE` | 片体积 > `partSize` | 按 `partSize` 重切 |
| 422 | `CHUNK_CHECKSUM_MISMATCH` | `X-Chunk-Sha256` 不符 | **重传该片**（服务端已丢弃本次写入） |
| 422 | `PART_SIZE_MISMATCH` | 非末片但大小不符 | 检查切片逻辑 |
| 502 | `STORAGE_UNAVAILABLE` | MinIO 不可达 | 指数退避重试 |

### 5.5 重试策略（客户端实现建议）

| 状态 | 重试 |
| --- | --- |
| 5xx / 网络中断 | 重试 3 次，退避 500 / 1000 / 2000 ms + 抖动 |
| 422 校验 | 重试 1 次（重新切片后再算 sha256） |
| 4xx 其它 | 不重试，直接报错 |
| 409 / 410 | 停止整个上传，提示用户重新开始 |

---

## 6 完成上传

```
POST /server/deps/{code}/uploads/{uploadId}/complete
Content-Type: application/json
Authorization: Bearer <token>

{}
```

请求体为空对象即可。**不需要客户端回传 parts 列表**——服务端用 `ListParts` 自行汇总，避免客户端伪造 ETag。

### 6.1 服务端动作顺序

1. `ListParts` 分页取全量分片
2. 片号集合与 `1..partCount` 比对，缺片 → `409 MISSING_PARTS`（响应带 `missingParts`，客户端补传后可重试 complete，会话不销毁）
3. 累计大小与 `size` 比对，不符 → `422 SIZE_MISMATCH`（会话保留）
4. `CompleteMultipartUpload`
5. `StatObject` 核对最终对象大小
6. `DEP_VERIFY_MODE=full` 时 `GetObject` 流式复算整体 sha256，不符 → 删对象 + `422 CHECKSUM_MISMATCH`
7. 进写锁：强制刷新索引 → 复查同版本是否已被占用 → 写 manifest → 归档旧版 manifest
8. 删除会话 JSON
9. 写审计（`dep-upload`，含 sha256、size、耗时、片数）

第 7 步失败会删掉刚 Complete 的对象，不留孤儿。

### 6.2 响应 `201`

```json
{
  "ok": true,
  "asset": {
    "code": "vc-redist",
    "displayName": "VC++ 运行库",
    "status": "unreleased",
    "currentVersion": null,
    "versionCount": 3,
    "size": 3221225472,
    "updatedAt": "2026-11-19T08:41:10.000Z"
  },
  "version": {
    "version": "1.4.2",
    "state": "unreleased",
    "publishedAt": "2026-11-19T08:41:10.000Z",
    "publisher": "平台管理员",
    "changelog": "修复 Win7 下缺少 api-ms-win-crt 的问题",
    "size": 2147483648,
    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "fileName": "VC_redist.x64.exe",
    "files": [
      {
        "name": "VC_redist.x64.exe",
        "storageName": "VC_redist.x64.dat",
        "path": "vc-redist/1.4.2/VC_redist.x64.dat",
        "size": 2147483648,
        "sha256": "9f86d0…0a08",
        "contentType": "application/octet-stream"
      }
    ]
  },
  "upload": { "partCount": 256, "partSize": 8388608, "durationMs": 396618 }
}
```

新版本状态为 `unreleased`，需要再调 `POST /server/deps/{code}/versions/{version}/enable` 才对外可下载。

### 6.3 错误

| 状态 | code | 场景 |
| --- | --- | --- |
| 404 | `UPLOAD_NOT_FOUND` | 会话不存在 |
| 409 | `MISSING_PARTS` | 缺片，带 `missingParts` |
| 409 | `VERSION_EXISTS` | 期间被别的会话抢先登记同版本 |
| 410 | `UPLOAD_EXPIRED` | 会话过期 |
| 422 | `SIZE_MISMATCH` | 实际总字节 ≠ 声明 `size`，带 `actual` / `declared` |
| 422 | `CHECKSUM_MISMATCH` | `full` 模式复算不符，带 `expected` / `actual` |
| 502 | `STORAGE_UNAVAILABLE` | MinIO 不可达 |
| 502 | `MANIFEST_WRITE_FAILED` | 对象已 Complete 但 manifest 落库失败，已回滚删对象 |

> `complete` 是幂等的：会话标记为 `done` 并保留结果，重复调用返回**同样的 201 与同一份结果**，不会重复登记，也不会报错。这样客户端「complete 超时后重试」是安全的。注意与 `GET /uploads/{id}` 区分——查会话时遇到 `done` 返回 409 `UPLOAD_COMPLETED`。

---

## 7 取消上传

```
DELETE /server/deps/{code}/uploads/{uploadId}
Authorization: Bearer <token>
```

### 7.1 响应 `200`

```json
{ "ok": true, "uploadId": "up_7f3k9m2q8x1c4v6b0n5z", "aborted": true }
```

已 `done` 的会话不可取消：返回 `409 UPLOAD_COMPLETED`。
会话已不存在：返回 `200 { "aborted": false }`（幂等，不算错误）。

### 7.2 列出进行中的会话

```
GET /server/deps/{code}/uploads?state=active
```

```json
{
  "items": [
    {
      "uploadId": "up_7f3k9m2q8x1c4v6b0n5z",
      "version": "1.4.2",
      "fileName": "VC_redist.x64.exe",
      "size": 2147483648,
      "receivedBytes": 1149239296,
      "percent": 53,
      "state": "uploading",
      "createdAt": "2026-11-19T08:34:32.000Z",
      "expiresAt": "2026-11-20T08:34:32.000Z"
    }
  ],
  "total": 1
}
```

`state` 过滤：`active`（默认，含 `created` / `uploading` / `completing`）、`all`。
访问时惰性清理过期会话（Abort 分片 + 标记 `expired`），不返回给客户端。

---

## 8 单请求直传（兼容保留）

```
POST /server/deps/{code}/versions?version=1.4.2&file_name=VC_redist.x64.exe&changelog=...
Content-Type: application/octet-stream
X-Expected-Sha256: <可选>
Content-Length: <必填>

<完整文件二进制>
```

响应 `201`，结构与 §6.2 相同。

行为差异：

- 内部把整个请求体当作「1 片」，走 `CreateMultipartUpload → UploadPart(1) → Complete`，仍是流式，不落盘。
- 由于是一次请求，**无断点续传**，中断即重来。
- 建议仅用于 ≤ 32 MiB 的文件。`web` 端按 `meta.chunkedThresholdBytes` 自动选择。

`GET /server/deps/meta` 新增字段：

```json
{
  "maxFileBytes": 21474836480,
  "storageDriver": "minio",
  "chunkedThresholdBytes": 33554432,
  "partSize": 8388608,
  "maxParts": 10000,
  "uploadTtlHours": 24
}
```

---

## 9 下载

```
GET /client/deps/{code}/versions/{version}/download
Range: bytes=0-          （可选）
Authorization: Bearer <token>
```

### 9.1 响应 `200` / `206`

| 头 | 值 |
| --- | --- |
| `Content-Type` | `application/octet-stream` |
| `Content-Length` | 本次响应体字节数（206 时是片段长度） |
| `Content-Range` | 仅 206：`bytes 0-8388607/2147483648` |
| `Accept-Ranges` | `bytes` |
| `Content-Disposition` | `attachment; filename="VC_redist.x64.dat"; filename*=UTF-8''VC_redist.x64.exe` |
| `X-Checksum-Sha256` | manifest 记录的整体 sha256 |
| `Cache-Control` | `no-store` |

### 9.2 HEAD 探测

```
HEAD /client/deps/{code}/versions/{version}/download
```

`200` + `Content-Length` + `Accept-Ranges: bytes`，不返回 body。
用于前端点「下载」前先判可用性，失效时原地提示而不是让浏览器跳到 JSON 错误页。

### 9.3 错误

| 状态 | code | 场景 |
| --- | --- | --- |
| 403 | `ASSET_DISABLED` | 资产未启用或已下架 |
| 403 | `VERSION_DISABLED` | 该版本未生效 |
| 404 | `ASSET_NOT_FOUND` | 资产不存在 |
| 404 | `VERSION_NOT_FOUND` | 版本不存在 |
| 404 | `ARTIFACT_NOT_FOUND` | manifest 有记录但对象缺失（迁移漏搬的典型症状） |
| 502 | `STORAGE_UNAVAILABLE` | MinIO 不可达 |

> 断点续传注意：`Range` 落在对象边界外（如 `bytes=99999999999-`）时，MinIO 返回 `416`，Hub 原样透传 `416` + `Content-Range: bytes */2147483648`。客户端应从头重下。

---

## 10 错误码全表

| code | HTTP | 含义 | 客户端建议 |
| --- | --- | --- | --- |
| `ASSET_NOT_FOUND` | 404 | 资产未登记 | 先调 `POST /server/deps` |
| `ASSET_DISABLED` | 403 | 资产未启用/已下架 | 提示用户联系管理员 |
| `VERSION_EXISTS` | 409 | 版本已存在，不可覆盖 | 换版本号 |
| `VERSION_NOT_FOUND` | 404 | 版本不存在 | 刷新详情 |
| `VERSION_DISABLED` | 403 | 版本未生效 | 提示管理员启用 |
| `UPLOAD_NOT_FOUND` | 404 | 会话不存在 | 重新创建 |
| `UPLOAD_EXPIRED` | 410 | 会话过期（默认 24h） | 重新创建，从第 1 片开始 |
| `UPLOAD_COMPLETED` | 409 | 会话已完成 | 停止上传，刷新详情 |
| `UPLOAD_IN_PROGRESS` | 409 | 同版本有未完成会话 | 复用 `existingUploadId` 续传 |
| `INVALID_PART_NUMBER` | 400 | 片号越界 | 修正切片 |
| `LENGTH_REQUIRED` | 411 | 缺 `Content-Length` | 补齐后重试 |
| `PART_TOO_LARGE` | 413 | 单片刻超过 `partSize` | 按 `partSize` 重切 |
| `PART_SIZE_MISMATCH` | 422 | 非末片大小不符 | 检查切片 |
| `MISSING_PARTS` | 409 | complete 时缺片 | 按 `missingParts` 补传后重试 |
| `SIZE_MISMATCH` | 422 | 总字节与声明不符 | 修正 `size` 或重新上传 |
| `CHUNK_CHECKSUM_MISMATCH` | 422 | 分片 sha256 不符 | 重传该片 |
| `CHECKSUM_MISMATCH` | 422 | 全量 sha256 不符 | 重新上传 |
| `INVALID_VERSION` | 422 | 版本号不合法 | 按 semver 改写 |
| `INVALID_SIZE` | 422 | `size` 非法 | 修正 |
| `INVALID_CHECKSUM` | 422 | `sha256` 非 64 位 hex | 修正 |
| `FILE_TOO_LARGE` | 413 | 超过 `maxFileBytes` | 联系管理员上调 |
| `MANIFEST_WRITE_FAILED` | 502 | 对象已存但登记失败，已回滚 | 重试 entire upload |
| `STORAGE_UNAVAILABLE` | 502 | 存储不可达 | 指数退避重试 |
| `UNAUTHORIZED` | 401 | 令牌缺失/过期 | 重新登录 |

---

## 11 客户端实现

### 11.1 完整分片上传器（浏览器）

```js
// web/src/api/upload.js
const RETRY = [500, 1000, 2000]

async function chunkSha256(blob) {
  const buf = await blob.arrayBuffer()
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex
}

function authHeaders(extra = {}) {
  const token = getToken()
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
}

async function callJson(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.message || `请求失败（${res.status}）`, body)
  return body
}

/** 创建或复用会话；返回 session */
export async function ensureSession({ code, version, fileName, size, sha256, changelog }) {
  try {
    return await callJson(`/server/deps/${encodeURIComponent(code)}/uploads`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ version, fileName, size, sha256, changelog }),
    })
  } catch (err) {
    // ApiError 的第三个参数是原始响应体，code 在 body.code 里
    if (err.status === 409 && err.body?.code === 'UPLOAD_IN_PROGRESS' && err.body?.existingUploadId) {
      return getSession({ code, uploadId: err.body.existingUploadId })
    }
    throw err
  }
}

export function getSession({ code, uploadId }) {
  return callJson(
    `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}`,
    { headers: authHeaders() },
  )
}

/** 单分片上传，含重试 */
async function putPart({ code, uploadId, partNumber, blob, signal, onBytes }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(
        `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}` +
          `/parts/${partNumber}`,
        {
          method: 'PUT',
          headers: authHeaders({
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Sha256': await chunkSha256(blob),
          }),
          body: blob,
          signal,
        },
      )
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        onBytes?.(blob.size)
        return body
      }
      // 4xx（除 5xx）不重试
      if (res.status < 500) {
        throw new ApiError(res.status, body.message || `分片失败（${res.status}）`, body)
      }
      throw new ApiError(res.status, body.message || '存储暂时不可用', body)
    } catch (err) {
      if (err.name === 'AbortError') throw err
      const retriable = err.status === undefined || err.status >= 500
      if (!retriable || attempt >= RETRY.length) throw err
      await new Promise((r) => setTimeout(r, RETRY[attempt]))
    }
  }
}

/**
 * 分片上传主流程。
 * @param {object} p
 * @param {string} p.code          资产标识
 * @param {string} p.version       版本号
 * @param {File}   p.file          浏览器 File
 * @param {string} p.sha256        整体 sha256（由 hash.worker 算出）
 * @param {string} [p.changelog]
 * @param {number} [p.concurrency] 并发数，默认 3
 * @param {(pct:number, loaded:number, total:number)=>void} [p.onProgress]
 * @param {(s:{uploadId:string,state:string})=>void} [p.onState]
 * @param {AbortSignal} [p.signal]
 */
export async function uploadDepVersionChunked({
  code, version, file, sha256, changelog, concurrency = 3, onProgress, onState, signal,
}) {
  const session = await ensureSession({
    code, version, fileName: file.name, size: file.size, sha256, changelog,
  })
  const { uploadId, partSize, partCount } = session
  onState?.({ uploadId, state: session.state })
  localStorage.setItem(`upload:${code}:${version}`, uploadId)

  // 已传分片（续传）
  const done = new Set((session.parts || []).map((p) => p.partNumber))
  let uploaded = (session.parts || []).reduce((n, p) => n + p.size, 0)
  onProgress?.(Math.floor((uploaded / file.size) * 100), uploaded, file.size)

  // 待传片号
  const pending = []
  for (let n = 1; n <= partCount; n += 1) if (!done.has(n)) pending.push(n)

  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const partNumber = pending[cursor++]
      const start = (partNumber - 1) * partSize
      const blob = file.slice(start, Math.min(start + partSize, file.size))
      await putPart({
        code, uploadId, partNumber, blob, signal,
        onBytes: (n) => {
          uploaded += n
          onProgress?.(Math.min(99, Math.floor((uploaded / file.size) * 100)), uploaded, file.size)
        },
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))

  const result = await callJson(
    `/server/deps/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' },
  )
  localStorage.removeItem(`upload:${code}:${version}`)
  onProgress?.(100, file.size, file.size)
  onState?.({ uploadId, state: 'done' })
  return result
}
```

> 并发数不要超过 4：浏览器对同源并发连接限制是 6，留两条给其它请求；跑满只会让每个分片互相挤，总耗时不变。

### 11.2 curl 手工联调

```bash
BASE=http://127.0.0.1:8788
TOKEN=<登录拿到的 token>
CODE=vc-redist
VER=1.4.2
FILE=./VC_redist.x64.exe
SIZE=$(stat -c%s "$FILE")
SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
PART=$((8*1024*1024))

# 1. 创建会话
curl -sS -X POST "$BASE/server/deps/$CODE/uploads" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"version\":\"$VER\",\"fileName\":\"$(basename "$FILE")\",\"size\":$SIZE,\"sha256\":\"$SHA\"}"

# 假设返回 uploadId=up_xxx, partCount=256，下面按片循环
# 2. 上传第 1 片
head -c $PART "$FILE" > /tmp/part1.bin
curl -sS -X PUT "$BASE/server/deps/$CODE/uploads/up_xxx/parts/1" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H "X-Chunk-Sha256: $(sha256sum /tmp/part1.bin | cut -d' ' -f1)" \
  --data-binary @/tmp/part1.bin

# 3. 查已传分片
curl -sS "$BASE/server/deps/$CODE/uploads/up_xxx" -H "Authorization: Bearer $TOKEN"

# 4. 完成
curl -sS -X POST "$BASE/server/deps/$CODE/uploads/up_xxx/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# 5. 生效
curl -sS -X POST "$BASE/server/deps/$CODE/versions/$VER/enable" \
  -H "Authorization: Bearer $TOKEN"
```

### 11.3 批量切片脚本（shell，用于纯命令行走完整流程）

```bash
split -b $PART -d -a 4 "$FILE" /tmp/chunk_
n=0
for f in /tmp/chunk_*; do
  n=$((n+1))
  curl -sS -X PUT "$BASE/server/deps/$CODE/uploads/up_xxx/parts/$n" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/octet-stream' \
    -H "X-Chunk-Sha256: $(sha256sum "$f" | cut -d' ' -f1)" \
    --data-binary @"$f" > /dev/null
  echo "part $n done"
done
```

---

## 12 服务端实现注意

这几条踩过坑，实现时不要省：

| # | 注意点 | 后果 |
| --- | --- | --- |
| 1 | 分片路由不能挂 `express.json()` / `express.raw()` | 8 MiB 被整体读进内存，并发 3 片就 24 MiB，且中断不传播 |
| 2 | 必须校验 `Content-Length` | S3 `UploadPart` 收 chunked 会挂住，表现为请求永不返回 |
| 3 | `req` 直接作为 `Body` 传给 SDK，同时 `pipeline` 监听中断 | 客户端取消时若只 pipe，S3 侧连接不释放，会话卡在 `uploading` |
| 4 | 分片阶段**不持** `store.withLock()` | 一次上传锁死全局 30 分钟，其它写操作全排队 |
| 5 | `complete` 里必须 `ensureIndex({ force: true })` 后复查版本 | 预检与完成之间有窗口，会被并发上传穿透「版本不可变」 |
| 6 | manifest 落库失败要删刚 Complete 的对象 | 留下无记录的孤儿对象，且无法通过正常接口清理 |
| 7 | `ListParts` 要循环分页 | 超过 1000 片时只拿第一页，误判缺片 |
| 8 | 响应里不要回 S3 `uploadId` | 泄露存储层标识，也容易被拼出直连请求 |
| 9 | 分片 ETag 不能当校验和返回给下载响应 | 分片对象 ETag 是 `md5-of-md5s-N`，与文件 MD5/sha256 都不同 |
| 10 | `x-amz-checksum-*` 相关 SDK 默认行为要关 | 新版 AWS SDK 默认加 CRC32 头，部分 MinIO 版本直接 400 |

---

## 13 版本记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-19 | 依赖库存储改为 MinIO 对象存储；新增分片上传 6 个端点；`maxFileBytes` 2 GiB → 20 GiB |
