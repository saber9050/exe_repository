/**
 * 依赖库存储驱动：MinIO（S3 兼容对象存储）。
 *
 * 三条不变量：
 *   1. 存储只存字节与清单，可见性/版本状态一律由上层判定
 *   2. 对象 key 与 manifest 的 files[].path 逐字符一致
 *   3. manifest 是唯一事实源，制品路径从 manifest 取，不由存储层推断
 *
 * 前缀约定见方案 §5：制品在 deps/，清单与会话在 meta/。
 */
import { HttpError } from '../http-error.js'

const notFound = (msg = '制品文件不存在') => new HttpError(404, msg)

/** 存储层异常统一收口：不存在给 404，其余给 502 */
function wrapStorageError(err, action = '存储操作') {
  if (err instanceof HttpError) return err
  if (err?.name === 'ObjectNotFound') return notFound()
  return new HttpError(502, `${action}失败：存储不可用，请稍后重试`, { code: 'STORAGE_UNAVAILABLE' })
}

export function createDepDriver({ store }) {
  const MANIFEST_ROOT = 'meta/deps'
  const HISTORY_KEEP = 20

  const manifestKey = (code) => `${MANIFEST_ROOT}/${code}/manifest.json`
  const historyPrefix = (code) => `${MANIFEST_ROOT}/${code}/history/`

  return {
    name: 'minio',

    async listManifests() {
      let keys
      try {
        keys = await store.listKeys(`${MANIFEST_ROOT}/`)
      } catch (err) {
        throw wrapStorageError(err, '读取资产清单')
      }
      const targets = keys
        .map((k) => k.key)
        .filter((k) => k.endsWith('/manifest.json'))
        .map((k) => k.slice(`${MANIFEST_ROOT}/`.length).replace(/\/manifest\.json$/, ''))

      const out = []
      const queue = targets.slice()
      const worker = async () => {
        while (queue.length) {
          const code = queue.shift()
          try {
            const manifest = await this.readManifest(code)
            if (manifest) out.push(manifest)
          } catch {
            /* 单个坏 manifest 不影响整体 */
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()))
      return out
    },

    async readManifest(code) {
      try {
        const { data } = await store.getJson(manifestKey(code))
        return data || null
      } catch (err) {
        throw wrapStorageError(err, '读取 manifest')
      }
    },

    /**
     * 写 manifest。S3 没有 CAS，靠上层 withLock 串行 + 写前归档旧版兜底：
     * 归档补上「可回滚」能力，最近 20 版留着，排查误操作够用。
     */
    async writeManifest(manifest) {
      await this.archiveManifest(manifest.code)
      const buffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      try {
        await store.putObject({
          key: manifestKey(manifest.code),
          body: buffer,
          size: buffer.length,
          contentType: 'application/json; charset=utf-8',
        })
      } catch (err) {
        throw wrapStorageError(err, '写 manifest')
      }
    },

    async archiveManifest(code) {
      try {
        const { data } = await store.getJson(manifestKey(code))
        if (!data) return null
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const key = `${historyPrefix(code)}${stamp}.json`
        const buffer = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
        await store.putObject({
          key,
          body: buffer,
          size: buffer.length,
          contentType: 'application/json; charset=utf-8',
        })
        // 只留最近 20 版；历史清理失败不影响主流程
        const olds = (await store.listKeys(historyPrefix(code)))
          .sort((a, b) => String(b.key).localeCompare(String(a.key)))
          .slice(HISTORY_KEEP)
        for (const item of olds) await store.deleteObject(item.key).catch(() => {})
        return { key }
      } catch {
        return null
      }
    },

    async deleteManifest(code) {
      await store.deleteObject(manifestKey(code)).catch(() => {})
      // 历史一并清掉：删资产时留一堆孤儿 JSON 没有意义
      try {
        const olds = await store.listKeys(historyPrefix(code))
        for (const item of olds) await store.deleteObject(item.key).catch(() => {})
      } catch {
        /* 忽略 */
      }
    },

    async statArtifact(relPath) {
      try {
        return await store.statObject(relPath)
      } catch (err) {
        throw wrapStorageError(err, '读取对象属性')
      }
    },

    async putArtifact({ relPath, stream, size }) {
      try {
        const { etag } = await store.putObject({
          key: relPath,
          body: stream,
          size,
          contentType: 'application/octet-stream',
        })
        return { path: relPath, size: size || 0, etag }
      } catch (err) {
        throw wrapStorageError(err, '上传制品')
      }
    },

    async deleteArtifact(relPath) {
      await store.deleteObject(relPath).catch(() => {})
    },

    async fetchArtifact(relPath, { range } = {}) {
      try {
        return await store.getObject({ key: relPath, range })
      } catch (err) {
        throw wrapStorageError(err, '读取制品')
      }
    },

    /* ------------------------------ 分片 ------------------------------ */

    async createUpload({ relPath, contentType = 'application/octet-stream' }) {
      try {
        const { uploadId } = await store.createMultipart({ key: relPath, contentType })
        if (!uploadId) throw new Error('未返回 uploadId')
        return { uploadId }
      } catch (err) {
        throw wrapStorageError(err, '创建分片上传')
      }
    },

    async uploadPart({ relPath, uploadId, partNumber, stream, size }) {
      try {
        return await store.uploadPart({
          key: relPath,
          uploadId,
          partNumber,
          body: stream,
          size,
        })
      } catch (err) {
        throw wrapStorageError(err, '写入分片')
      }
    },

    async listParts({ relPath, uploadId }) {
      try {
        return await store.listParts({ key: relPath, uploadId })
      } catch (err) {
        throw wrapStorageError(err, '读取分片列表')
      }
    },

    async completeUpload({ relPath, uploadId, parts }) {
      try {
        return await store.completeMultipart({ key: relPath, uploadId, parts })
      } catch (err) {
        throw wrapStorageError(err, '合并分片')
      }
    },

    async abortUpload({ relPath, uploadId }) {
      try {
        await store.abortMultipart({ key: relPath, uploadId })
      } catch {
        /* 已完成的会话 Abort 会 404，忽略 */
      }
      return true
    },

    /** 审计等元数据读写 */
    meta: {
      name: 'minio',
      async getJson(key) {
        return store.getJson(`meta/${key}`)
      },
      async putJson(key, data) {
        return store.putJson(`meta/${key}`, data)
      },
      async deleteKey(key) {
        return store.deleteObject(`meta/${key}`)
      },
      /**
       * 列 meta/{prefix} 下的对象，返回**相对 key**（如 `up_xxx.json`）。
       *
       * 不能直接拿 store.listKeys 去扫 `uploads/`：会话实际写在
       * `meta/uploads/` 下，查错前缀的结果是「永远没有进行中的会话」，
       * 表现为暂停后继续又从第 1 片开始传。前缀收敛在这一层，上层不该知道 meta/。
       */
      async list(prefix) {
        const base = `meta/${prefix}`
        const items = await store.listKeys(base)
        return items.map((item) => ({
          key: String(item.key).startsWith(base) ? String(item.key).slice(base.length) : String(item.key),
          size: item.size,
        }))
      },
    },

    /** 供路由按前缀列上传会话 */
    store,
  }
}
