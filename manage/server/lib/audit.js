/**
 * 审计日志。
 *
 * 插件库和依赖库写的是同一份 `audit.json`：一个进程、一套登录、一个制品库，
 * 没有理由让人去两个地方翻「谁在什么时候改过什么」。
 *
 * 这份实现刻意做成一个独立对象而不是各自留在两个 store 里，原因是缓存：
 * 两个 store 各自持有一份数组和 blob 版本号的话，A 写完 B 拿旧版本号再写会被
 * 存储的乐观锁顶掉，表现就是审计记录随机丢。这里只有一份缓存、一条写队列。
 *
 * 存储通过 meta 适配器注入（`{ getJson, putJson }`），这一层不关心是
 * 哪个后端、也不该关心。
 *
 * 约定：append 永不抛错。审计落盘失败不能把发布、上传、删除这些主流程拖下来。
 */
import crypto from 'node:crypto'

const nowIso = () => new Date().toISOString()

export class AuditLog {
  /**
   * @param {{ meta: object, file?: string, limit?: number, ttlMs?: number }} options
   *   meta 需要实现 getJson(key) -> { data, etag } 与 putJson(key, data, { etag })
   */
  constructor({ meta, file = 'audit.json', limit = 200, ttlMs = 30000 }) {
    if (!meta) throw new Error('AuditLog 需要一个 meta 适配器（getJson / putJson）')
    this.meta = meta
    this.file = file
    this.limit = limit
    this.ttlMs = ttlMs

    this.items = null
    this.etag = null
    this.at = 0
    /** 写队列：append 之间串行，避免同进程内两次写互相覆盖 */
    this.queue = Promise.resolve()
  }

  /** 缓存超过 ttlMs * 5 就重拉；写之前一律用最新的版本号 */
  async load() {
    if (this.items && Date.now() - this.at < this.ttlMs * 5) return
    const { data, etag } = await this.meta
      .getJson(this.file)
      .catch(() => ({ data: null, etag: this.etag }))
    this.items = Array.isArray(data?.items) ? data.items : []
    this.etag = etag || null
    this.at = Date.now()
  }

  /**
   * 追加一条记录。
   * @param {object} entry - actor / action / code / version / sha256 / size / scope 等
   * @returns {Promise<object|null>} 写入的记录；落盘失败返回 null，不抛错
   */
  async append(entry) {
    const run = this.queue.then(async () => {
      await this.load()

      const record = {
        id: `a-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        at: nowIso(),
        result: 'success',
        ...entry,
      }

      const before = this.items
      this.items = [record, ...before].slice(0, this.limit)

      try {
        const res = await this.meta.putJson(this.file, { items: this.items }, { etag: this.etag })
        this.etag = res?.etag || this.etag
        this.at = Date.now()
        return record
      } catch {
        // 写失败就把内存里这条撤掉：内存里有一条存储里没有的记录，
        // 比少一条更糟 —— 下次 list 会把它当成真的展示出来。
        this.items = before
        return null
      }
    })

    this.queue = run.catch(() => {})
    return run.catch(() => null)
  }

  /**
   * 取最近的记录，最新在前。
   * @param {number} limit - 条数上限
   */
  async list(limit = 60) {
    await this.load()
    return this.items.slice(0, limit)
  }
}
