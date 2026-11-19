/**
 * MinIO 读取端：只读凭据，只做两件事。
 *   1. 读 `meta/deps/{code}/manifest.json` 生成目录
 *   2. GetObject 流式转发制品字节（透传 Range）
 *
 * 与 manage 端刻意不共用代码：portal 是独立进程、独立部署、独立凭据，
 * 让它依赖 manage 的内部模块会把两个服务的发布节奏绑在一起。
 */
import { Readable } from 'node:stream'
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'

const ENDPOINT = (process.env.MINIO_ENDPOINT || '127.0.0.1').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const PORT = Number(process.env.MINIO_PORT || 9000)
const USE_SSL = String(process.env.MINIO_USE_SSL || 'false').toLowerCase() !== 'false'
const BUCKET = process.env.MINIO_BUCKET || 'dep-artifacts'
const REGION = process.env.MINIO_REGION || 'us-east-1'
const PREFIX = (process.env.MINIO_PREFIX || '').replace(/^\/+|\/+$/g, '')
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY || ''
const SECRET_KEY = process.env.MINIO_SECRET_KEY || ''

const MANIFEST_ROOT = 'meta/deps'

const client = new S3Client({
  region: REGION,
  endpoint: `${USE_SSL ? 'https' : 'http'}://${ENDPOINT}:${PORT}`,
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  // 见 manage/server/lib/storage/s3.js 的说明：新版 SDK 默认加 CRC32 头，
  // 部分 MinIO 版本会直接 400
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const joinKey = (key) => (PREFIX ? `${PREFIX}/${String(key).replace(/^\/+/, '')}` : String(key).replace(/^\/+/, ''))

async function listKeys(prefix) {
  const out = []
  let token
  for (;;) {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: joinKey(prefix),
        MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    )
    for (const obj of res.Contents || []) out.push(obj.Key)
    if (!res.IsTruncated) break
    token = res.NextContinuationToken
    if (!token) break
  }
  return out
}

async function readJson(key) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: joinKey(key) }))
    const chunks = []
    for await (const chunk of res.Body) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** 读单个资产的 manifest；不存在或解析失败返回 null，不打断整体目录 */
export async function getManifest(code) {
  return readJson(`${MANIFEST_ROOT}/${code}/manifest.json`)
}

/**
 * 列出全部资产 manifest。
 * 目录不存在（还没登记过任何资产）时返回空数组，不报错。
 */
export async function listManifests() {
  let keys
  try {
    keys = await listKeys(`${MANIFEST_ROOT}/`)
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode
    if (status === 404) return []
    throw err
  }

  const codes = keys
    .filter((k) => k.endsWith('/manifest.json'))
    .map((k) => k.slice(`${joinKey(MANIFEST_ROOT)}/`.length).replace(/\/manifest\.json$/, ''))

  const manifests = await Promise.all(codes.map((code) => getManifest(code)))
  return manifests.filter(Boolean)
}

/**
 * 流式读取制品。透传 Range，让浏览器/客户端能续传。
 * fileName 用 manifest 里的 storageName（.dat），不是用户看到的原始名。
 *
 * 返回值刻意做成 Response 的形状（ok / status / headers.get / body），
 * 这样 index.js 里那套转发逻辑一行都不用改。
 */
export async function openArtifact(code, version, fileName, range) {
  const key = `${code}/${version}/${fileName}`
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: joinKey(key),
        ...(range ? { Range: range } : {}),
      }),
    )
    const headers = new Map()
    if (res.ContentLength !== undefined) headers.set('content-length', String(res.ContentLength))
    if (res.ContentRange) headers.set('content-range', res.ContentRange)
    if (res.AcceptRanges) headers.set('accept-ranges', res.AcceptRanges)
    headers.set('content-type', res.ContentType || 'application/octet-stream')
    if (res.LastModified) headers.set('last-modified', new Date(res.LastModified).toUTCString())

    const status = res.ContentRange ? 206 : 200
    return {
      ok: true,
      status,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      body: Readable.toWeb(res.Body),
    }
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode
    const notFound = status === 404 || err?.name === 'NoSuchKey' || err?.name === 'NotFound'
    return {
      ok: false,
      status: notFound ? 404 : 502,
      headers: { get: () => null },
      body: null,
    }
  }
}

export const storageConfig = {
  driver: 'minio',
  base: `${USE_SSL ? 'https' : 'http'}://${ENDPOINT}:${PORT}`,
  bucket: BUCKET,
  prefix: PREFIX,
  authenticated: Boolean(ACCESS_KEY && SECRET_KEY),
}
