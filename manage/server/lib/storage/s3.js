/**
 * S3 / MinIO 客户端封装。
 *
 * 只用官方 @aws-sdk/client-s3，不引 minio 包：S3 是通用方言，将来换 OSS / Ceph
 * 只改 endpoint 与凭据，业务代码不动；而 minio 包的 API 在 v7/v8 之间有过破坏性变更。
 *
 * 三条硬约定：
 *   1. forcePathStyle —— MinIO 不做虚拟主机寻址，否则会拼出 bucket.127.0.0.1
 *   2. 关掉自动校验和 —— 新版 SDK 默认给 PUT 加 x-amz-checksum-crc32，
 *      部分 MinIO 版本直接 400 XAmzContentChecksumMismatch
 *   3. 这一层只做「对象读写」，任何业务判定（可见性 / 版本状态）都在上层
 */
import { Readable } from 'node:stream'
import crypto from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketPolicyCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3'

const unquote = (etag) => String(etag || '').replace(/^"+|"+$/g, '')

/**
 * 404 有两种完全不同的含义，不能合并：
 *   NoSuchBucket —— 桶没建，运维错误，接口该回 502（存储不可用）
 *   NoSuchKey    —— 对象不存在，业务语义，接口该回 404
 * 早期把两者都翻成「对象不存在」，排查时会被带偏到完全错误的方向。
 */
function isNoSuchBucket(err) {
  const status = err?.$metadata?.httpStatusCode
  const code = err?.Code || err?.name
  if (code === 'NoSuchBucket') return true
  // HeadBucket 对不存在的桶只回 404、没有响应体，只能从 message 里认
  return status === 404 && /NoSuchBucket/i.test(String(err?.message || ''))
}

function isNoSuchKey(err) {
  const status = err?.$metadata?.httpStatusCode
  const code = err?.Code || err?.name
  return (
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'NoSuchVersion' ||
    status === 404
  )
}

const notFoundError = () => {
  const e = new Error('对象不存在')
  e.name = 'ObjectNotFound'
  return e
}

const bucketMissingError = () => {
  const e = new Error('桶不存在')
  e.name = 'BucketNotFound'
  return e
}

const storageError = (err) => {
  const e = new Error(`对象存储请求失败：${err.message || err.name}`)
  e.name = 'StorageError'
  e.cause = err
  e.status = err?.$metadata?.httpStatusCode || 0
  return e
}

/**
 * 老版本 MinIO（2022-01 这类）对 PutBucketLifecycle* 强制要求 Content-MD5，
 * 而 AWS SDK v3 早已不再自动计算（当年因为 FIPS 环境下的兼容问题去掉了）。
 * 不补这个头就会 400 `MissingContentMD5`。
 *
 * 命令级 middleware：只影响这一条请求，不污染其它调用。
 */
function withContentMd5(command) {
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request
      if (request?.body && !request.headers?.['Content-MD5']) {
        const buf =
          typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : Buffer.from(request.body)
        request.headers = request.headers || {}
        request.headers['Content-MD5'] = crypto.createHash('md5').update(buf).digest('base64')
      }
      return next(args)
    },
    { step: 'build', name: 'contentMd5' },
  )
  return command
}

export function createObjectStore(cfg) {
  const { endpoint, port, useSsl, accessKey, secretKey, bucket, region, prefix } = cfg
  const client = new S3Client({
    region: region || 'us-east-1',
    endpoint: `${useSsl ? 'https' : 'http'}://${endpoint}:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    // 见文件头第 2 条
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  })

  const joinKey = (key) => (prefix ? `${prefix}/${String(key).replace(/^\/+/, '')}` : String(key).replace(/^\/+/, ''))
  /** listKeys 用：把桶内真实 key 还原成逻辑 key */
  const stripKey = (key) =>
    prefix && String(key).startsWith(`${prefix}/`) ? String(key).slice(prefix.length + 1) : String(key)

  /** 包装一层：区分「桶没了（502）」与「对象没了（404）」 */
  async function run(fn) {
    try {
      return await fn()
    } catch (err) {
      if (isNoSuchBucket(err)) throw storageError(err)
      if (isNoSuchKey(err)) throw notFoundError()
      throw storageError(err)
    }
  }

  return {
    bucket,
    joinKey,

    /** 探测桶是否存在。不存在返回 false，不做 run() 的 404 翻译。 */
    async headBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }))
        return true
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode
        if (status === 404 || err?.name === 'NotFound') return false
        throw storageError(err)
      }
    },

    /**
     * 保证桶可用：不存在就建（默认私有），并配好「中断分片自动清理」的生命周期规则。
     *
     * 幂等，可重复调用。并发启动时 CreateBucket 可能撞 409，视为成功。
     *
     * @param {{ autoCreate?: boolean, abortIncompleteDays?: number }} options
     * @returns {{ exists: boolean, created: boolean, lifecycle: 'ok'|'skipped'|'unsupported', publicRead: boolean }}
     */
    async ensureBucket({ autoCreate = true, abortIncompleteDays = 1 } = {}) {
      let exists = await this.headBucket()

      if (!exists && !autoCreate) {
        throw bucketMissingError()
      }

      let created = false
      if (!exists) {
        try {
          // 不传 ACL / Policy —— S3 与 MinIO 新建桶默认就是私有
          await client.send(new CreateBucketCommand({ Bucket: bucket }))
          created = true
        } catch (err) {
          const code = err?.Code || err?.name
          // BucketAlreadyOwnedByYou：另一个实例刚建好，按成功处理
          if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
            throw storageError(err)
          }
        }
      }

      let lifecycle = 'ok'
      let lifecycleError = ''
      if (abortIncompleteDays > 0) {
        try {
          await client.send(
            withContentMd5(
              new PutBucketLifecycleConfigurationCommand({
                Bucket: bucket,
                LifecycleConfiguration: {
                  Rules: [
                    {
                      ID: 'abort-incomplete-multipart',
                      Status: 'Enabled',
                      Filter: { Prefix: 'deps/' },
                      AbortIncompleteMultipartUpload: {
                        DaysAfterInitiation: abortIncompleteDays,
                      },
                    },
                  ],
                },
              }),
            ),
          )
        } catch (err) {
          /**
           * 两种失败要分开：
           *   403 —— 凭据没有 PutBucketLifecycleConfiguration 权限
           *   其它 —— 老版本 MinIO 的 lifecycle schema 不认 AbortIncompleteMultipartUpload
           *           （实测 RELEASE.2022-01-04 直接 400 InvalidRequest，
           *            但同一份规则里的 Expiration 是能通过的）
           * 都不影响主流程：中断分片还有 Hub 侧的会话 TTL 兜底。
           */
          lifecycle = err?.$metadata?.httpStatusCode === 403 ? 'forbidden' : 'unsupported'
          lifecycleError = err?.message || err?.name || ''
        }
      }

      return {
        exists,
        created,
        lifecycle,
        lifecycleError,
        publicRead: await this.bucketAllowsAnonymousRead(),
      }
    },

    /**
     * 桶策略是否允许匿名读。
     * 注意：这只查 bucket policy，查不到 ACL / 前提是没人在桶上挂匿名读。
     * 查不到策略（NoSuchBucketPolicy）说明是私有，返回 false。
     */
    async bucketAllowsAnonymousRead() {
      try {
        const res = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }))
        const policy = JSON.parse(res.Policy || '{}')
        return (policy.Statement || []).some((s) => {
          if (s.Effect !== 'Allow') return false
          const principal = s.Principal
          const anyone =
            principal === '*' ||
            (principal && principal.AWS === '*') ||
            (Array.isArray(principal?.AWS) && principal.AWS.includes('*'))
          if (!anyone) return false
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action]
          return actions.some((a) => String(a) === 's3:*' || String(a) === '*' || /s3:GetObject/i.test(String(a)))
        })
      } catch {
        return false
      }
    },

    /**
     * 单请求写对象。
     * @param {{ key: string, body: import('node:stream').Readable|Buffer, size?: number, contentType?: string }} p
     */
    async putObject({ key, body, size, contentType = 'application/octet-stream' }) {
      const out = await run(() =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: joinKey(key),
            Body: body,
            ...(size ? { ContentLength: size } : {}),
            ContentType: contentType,
          }),
        ),
      )
      return { etag: unquote(out.ETag) }
    },

    /**
     * 读对象。Range 直接透传给 S3，MinIO 返回 206。
     * @returns {{ status: number, headers: Record<string,string>, body: import('node:stream').Readable }}
     */
    async getObject({ key, range }) {
      const out = await run(() =>
        client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: joinKey(key),
            ...(range ? { Range: range } : {}),
          }),
        ),
      )
      const headers = {}
      if (out.ContentLength !== undefined) headers['content-length'] = String(out.ContentLength)
      if (out.ContentRange) headers['content-range'] = out.ContentRange
      if (out.AcceptRanges) headers['accept-ranges'] = out.AcceptRanges
      headers['content-type'] = out.ContentType || 'application/octet-stream'
      if (out.LastModified) headers['last-modified'] = new Date(out.LastModified).toUTCString()
      // Range 命中时 S3 不回 206 字段，靠自己判：有 ContentRange 就是片段
      const status = headers['content-range'] ? 206 : 200
      return {
        status,
        headers,
        body: out.Body instanceof Readable ? out.Body : Readable.fromWeb(out.Body),
      }
    },

    /** @returns {{ size: number, etag: string, contentType: string, lastModified: string } | null} */
    async statObject(key) {
      try {
        const out = await run(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: joinKey(key) })))
        return {
          size: Number(out.ContentLength) || 0,
          etag: unquote(out.ETag),
          contentType: out.ContentType || 'application/octet-stream',
          lastModified: out.LastModified ? new Date(out.LastModified).toISOString() : null,
        }
      } catch (err) {
        if (err.name === 'ObjectNotFound') return null
        throw err
      }
    },

    async deleteObject(key) {
      await run(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: joinKey(key) })))
      return true
    },

    /* ------------------------------ JSON ------------------------------ */

    /** 读 JSON；不存在返回 { data: null, etag: null } */
    async getJson(key) {
      try {
        const res = await this.getObject({ key })
        const chunks = []
        for await (const chunk of res.body) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        return { data: JSON.parse(text), etag: unquote(res.headers.etag) || null }
      } catch (err) {
        if (err.name === 'ObjectNotFound') return { data: null, etag: null }
        // JSON 坏了按「没有」处理，交给上层重建，不让一个坏对象拖死整个清单
        if (err instanceof SyntaxError) return { data: null, etag: null }
        throw err
      }
    },

    async putJson(key, data) {
      const buffer = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
      const { etag } = await this.putObject({
        key,
        body: buffer,
        size: buffer.length,
        contentType: 'application/json; charset=utf-8',
      })
      return { etag }
    },

    /* --------------------------- 分片上传 --------------------------- */

    async createMultipart({ key, contentType = 'application/octet-stream' }) {
      const out = await run(() =>
        client.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: joinKey(key),
            ContentType: contentType,
          }),
        ),
      )
      return { uploadId: out.UploadId }
    },

    /**
     * 传一片。body 必须是可读流或 Buffer，且 size 必填 ——
     * S3 的 UploadPart 收 chunked body 会挂住，表现为请求永不返回。
     */
    async uploadPart({ key, uploadId, partNumber, body, size }) {
      const out = await run(() =>
        client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: joinKey(key),
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body,
            ContentLength: size,
          }),
        ),
      )
      return { etag: out.ETag, size }
    },

    /** 列出已上传分片，自动翻页（超过 1000 片时只拿第一页会误判缺片） */
    async listParts({ key, uploadId }) {
      const parts = []
      let marker
      for (;;) {
        const out = await run(() =>
          client.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: joinKey(key),
              UploadId: uploadId,
              ...(marker ? { PartNumberMarker: marker } : {}),
            }),
          ),
        )
        for (const p of out.Parts || []) {
          parts.push({
            partNumber: p.PartNumber,
            etag: p.ETag,
            size: Number(p.Size) || 0,
            lastModified: p.LastModified ? new Date(p.LastModified).toISOString() : null,
          })
        }
        if (!out.IsTruncated) break
        marker = out.NextPartNumberMarker
        if (!marker) break
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber)
    },

    async completeMultipart({ key, uploadId, parts }) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
      const out = await run(() =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: joinKey(key),
            UploadId: uploadId,
            MultipartUpload: {
              Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          }),
        ),
      )
      return { etag: unquote(out.ETag), location: out.Location }
    },

    async abortMultipart({ key, uploadId }) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: joinKey(key), UploadId: uploadId }),
        )
      } catch (err) {
        // 已经完成 / 已被清理的分片，Abort 会 404（NoSuchUpload），视为成功
        const code = err?.Code || err?.name
        if (code !== 'NoSuchUpload' && code !== 'NoSuchKey' && code !== 'NotFound') throw err
      }
      return true
    },

    /* ------------------------------ 枚举 ------------------------------ */

  /**
   * 按前缀列 key。
   *
   * 返回的 key 是**逻辑 key**（去掉 MINIO_PREFIX），与 getObject/putObject
   * 的入参同一套语义。否则配了前缀时，上层拿到的 key 再拼一次前缀会变成
   * `prefix/prefix/...`，manifest 目录也会因为 slice 位置错位而整体读不到。
   */
  async listKeys(prefixKey = '', { limit = 5000 } = {}) {
    const out = []
    let token
    for (;;) {
      const res = await run(() =>
        client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: joinKey(prefixKey),
            MaxKeys: 1000,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        ),
      )
      for (const obj of res.Contents || []) {
        out.push({ key: stripKey(obj.Key), size: Number(obj.Size) || 0, lastModified: obj.LastModified })
      }
      if (!res.IsTruncated || out.length >= limit) break
      token = res.NextContinuationToken
      if (!token) break
    }
    return out
  },
  }
}
