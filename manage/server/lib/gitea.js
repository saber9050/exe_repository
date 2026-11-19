/**
 * Gitea REST 客户端。
 *
 * 只做三件事：读文件、写文件、拿原始字节流。
 * 所有判定（可见性、版本状态、校验和）都在这一层之上，Gitea 只当存储。
 */
import { config } from './config.js'

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')

export class GiteaError extends Error {
  constructor(status, message, body) {
    super(message)
    this.name = 'GiteaError'
    this.status = status
    this.body = body
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createGitea(cfg = config) {
  const base = cfg.giteaUrl.replace(/\/+$/, '')
  const repoApi = `/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
  const auth = { Authorization: `token ${cfg.giteaToken}` }

  /**
   * 一次完整请求。
   *
   * 注意：AbortSignal.timeout 覆盖的不只是建连，还包括读响应体。链路对大响应
   * 会在传了一半后停住，此时 fetch 已 resolve、res.text() 才抛 TimeoutError。
   * 这层必须一起包住，否则错误会以原始 "operation was aborted" 冒到接口上。
   */
  async function once(pathname, { method, body, timeout }) {
    let res
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          ...auth,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout || cfg.requestTimeoutMs),
      })
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? '请求超时' : '连接失败'
      throw new GiteaError(0, `Gitea ${reason}（${method} ${pathname}）`, null)
    }

    let text
    try {
      text = await res.text()
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? '响应读取超时' : '响应读取中断'
      throw new GiteaError(
        0,
        `Gitea ${reason}（${method} ${pathname}，${res.status}，已收 ${res.headers.get('content-length') || '未知'} 字节）`,
        null,
      )
    }

    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text }
    }
    if (!res.ok) {
      throw new GiteaError(res.status, payload?.message || `Gitea 返回 ${res.status}`, payload)
    }
    return payload
  }

  /**
   * 带一次重试的调用。只对「网络层失败」（status 0）重试，且只重试 GET：
   * 写请求可能已经落库，重试会造成 409 或重复提交。
   */
  async function call(pathname, { method = 'GET', body, timeout, retries } = {}) {
    const maxRetries = retries ?? (method === 'GET' ? 1 : 0)
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await once(pathname, { method, body, timeout })
      } catch (err) {
        lastError = err
        if (!(err instanceof GiteaError) || err.status !== 0 || attempt === maxRetries) break
        await sleep(500)
      }
    }
    throw lastError
  }

  return {
    base,

    htmlUrl(path = '') {
      return `${base}/${cfg.owner}/${cfg.repo}${path ? `/src/branch/${cfg.branch}/${path}` : ''}`
    },

    async repoInfo() {
      return call(repoApi)
    },

    /** 单个文件；不存在返回 null */
    async getFile(filePath, { ref = cfg.branch } = {}) {
      try {
        const data = await call(`${repoApi}/contents/${encodePath(filePath)}?ref=${ref}`)
        if (!data || Array.isArray(data)) return null
        const buffer = Buffer.from(String(data.content || ''), 'base64')
        return { content: buffer, sha: data.sha, size: buffer.length }
      } catch (err) {
        if (err instanceof GiteaError && err.status === 404) return null
        throw err
      }
    },

    async getJson(filePath, fallback = null) {
      const file = await this.getFile(filePath)
      if (!file) return { data: fallback, sha: null }
      try {
        return { data: JSON.parse(file.content.toString('utf8')), sha: file.sha }
      } catch {
        return { data: fallback, sha: file.sha }
      }
    },

    /** 新建或覆盖一个文件；sha 为空表示新建 */
    async putFile(filePath, buffer, message, sha) {
      const body = {
        content: Buffer.from(buffer).toString('base64'),
        message,
        branch: cfg.branch,
      }
      const endpoint = `${repoApi}/contents/${encodePath(filePath)}`
      if (sha) {
        body.sha = sha
        return call(endpoint, { method: 'PUT', body, timeout: 60000 })
      }
      try {
        return await call(endpoint, { method: 'POST', body, timeout: 60000 })
      } catch (err) {
        // 并发或缓存过期：文件其实已存在，补读 sha 后按更新重试一次
        if (err instanceof GiteaError && (err.status === 409 || err.status === 422)) {
          const existing = await this.getFile(filePath)
          if (existing?.sha) {
            body.sha = existing.sha
            return call(endpoint, { method: 'PUT', body, timeout: 60000 })
          }
        }
        throw err
      }
    },

    /** 写 JSON */
    async putJson(filePath, data, message, sha) {
      const buffer = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
      return this.putFile(filePath, buffer, message, sha)
    },

    async deleteFile(filePath, message, sha) {
      let fileSha = sha
      if (!fileSha) {
        const file = await this.getFile(filePath)
        if (!file) return false
        fileSha = file.sha
      }
      await call(`${repoApi}/contents/${encodePath(filePath)}`, {
        method: 'DELETE',
        body: { message, sha: fileSha, branch: cfg.branch },
      })
      return true
    },

    /**
     * 列出目录下的全部文件（逐层走 contents 接口）。
     *
     * 故意不用 `git/trees?recursive=true`：那条链路上递归响应容易传到一半卡住，
     * 而一个插件目录最多三四层（slug → dist → version），逐层列每层只有几个条目。
     * 返回的 `sha` 直接用于删除，省一次读文件的往返。
     */
    async listFilesUnder(dirPath, { depth = 4 } = {}) {
      const files = []
      const walk = async (dir, level) => {
        let entries
        try {
          entries = await call(`${repoApi}/contents/${encodePath(dir)}?ref=${encodeURIComponent(cfg.branch)}`)
        } catch (err) {
          if (err instanceof GiteaError && err.status === 404) return
          throw err
        }
        if (!Array.isArray(entries)) return
        for (const entry of entries) {
          if (entry.type === 'file') {
            files.push({ path: entry.path, sha: entry.sha, size: entry.size || 0 })
          } else if (entry.type === 'dir' && level < depth) {
            await walk(entry.path, level + 1)
          }
        }
      }
      await walk(dirPath, 1)
      return files
    },

    /**
     * 插件目录索引：只取两层浅树（root → plugins）。
     *
     * 刻意不用 `?recursive=true`：目标链路对较大响应会传到一半就停住
     * （实测 21 KB 的递归树首字节 2 秒、40 秒仍未传完），而浅树约 1 KB，
     * 能稳定返回。返回项形状与旧实现一致，`sha` 取插件目录的 tree sha——
     * 目录内任何文件变化都会改变它，正好可以当「manifest 是否变化」的缓存键。
     */
    async manifestRefs() {
      let root
      try {
        root = await call(`${repoApi}/git/trees/${encodeURIComponent(cfg.branch)}`)
      } catch (err) {
        // 空仓库 / 分支还不存在，视为没有插件
        if (err instanceof GiteaError && err.status === 404) return []
        throw err
      }

      const pluginsDir = (root?.tree || []).find((e) => e.type === 'tree' && e.path === 'plugins')
      if (!pluginsDir) return []

      const plugins = await call(`${repoApi}/git/trees/${pluginsDir.sha}`)
      return (plugins?.tree || [])
        .filter((e) => e.type === 'tree')
        .map((e) => ({
          type: 'blob',
          path: `plugins/${e.path}/manifest.json`,
          sha: e.sha,
          size: 0,
        }))
    },

    /** 原始字节流（下载插件包时用，避免整包进 Node 内存） */
    async rawStream(filePath) {
      let res
      try {
        res = await fetch(
          `${base}${repoApi}/raw/${encodePath(filePath)}?ref=${encodeURIComponent(cfg.branch)}`,
          { headers: auth, signal: AbortSignal.timeout(120000) },
        )
      } catch {
        throw new GiteaError(0, 'Gitea 不可达')
      }
      if (!res.ok) {
        throw new GiteaError(res.status === 404 ? 404 : 502, '制品在 Gitea 中不存在')
      }
      return res
    },

    /**
     * 确保仓库存在，并保证配置的分支可用。启动时调用一次，幂等。
     *
     * 为什么必须自动建：Gitea 的 contents API 在仓库不存在时直接 404，
     * 空仓库没有分支也写不进文件。手动建仓很容易漏掉「初始化仓库」这一步，
     * 结果第一次上传才报错，排查成本高。
     */
    async ensureRepo({ private: isPrivate = true } = {}) {
      let info = null
      try {
        info = await call(repoApi)
      } catch (err) {
        if (!(err instanceof GiteaError) || err.status !== 404) throw err
      }

      let created = false
      if (!info) {
        // owner 可能是组织，也可能就是令牌本人。
        // 404 = 不是组织；403 = 令牌没有 read:organization，判断不了，
        // 仍按「用户建仓」走，真错了下面的错误会点名缺哪个 scope。
        let isOrg = false
        try {
          await call(`/api/v1/orgs/${encodeURIComponent(cfg.owner)}`)
          isOrg = true
        } catch {
          /* 按用户建仓 */
        }

        const endpoint = isOrg
          ? `/api/v1/orgs/${encodeURIComponent(cfg.owner)}/repos`
          : '/api/v1/user/repos'

        try {
          info = await call(endpoint, {
            method: 'POST',
            body: {
              name: cfg.repo,
              description: '公共资源中心制品库（插件清单与依赖 manifest）',
              private: Boolean(isPrivate),
              auto_init: true,
              default_branch: cfg.branch,
              readme: 'Default',
            },
          })
          created = true
        } catch (err) {
          // 把 Gitea 的原始 message 带出来：它会直接点名缺哪个 scope，
          // 比「权限不足」这种笼统提示有用得多
          const detail = err.body?.message || err.message
          const scope = /scope\(s\):\s*\[([^\]]+)\]/.exec(detail)
          const hint = scope
            ? `令牌缺少 ${scope[1]} 权限（在 Gitea 令牌页面勾上对应用户/仓库/包权限，范围选「全部」）`
            : err.status === 409
              ? '同名仓库已存在但当前令牌读不到（令牌的仓库访问范围可能是「仅公开」）'
              : detail
          throw new GiteaError(err.status, `创建仓库 ${cfg.owner}/${cfg.repo} 失败：${hint}`, null)
        }

        // 按用户建仓时，仓库只能落在令牌本人名下；owner 不是自己又不是组织就说明配错了
        const actualOwner = info?.owner?.login || info?.owner?.username || ''
        if (actualOwner && actualOwner.toLowerCase() !== cfg.owner.toLowerCase()) {
          throw new GiteaError(
            0,
            `仓库被建到了 ${actualOwner} 名下，与 GITEA_OWNER=${cfg.owner} 不一致` +
              '（owner 既不是令牌本人也不是组织）',
            null,
          )
        }
      }

      const branchReady = await this.ensureBranch()
      return { created, branchReady, repo: info }
    },

    /** 分支不存在时，从默认分支拉一个同名分支，并把默认分支指过去 */
    async ensureBranch() {
      try {
        await call(`${repoApi}/branches/${encodeURIComponent(cfg.branch)}`)
        return true
      } catch (err) {
        if (!(err instanceof GiteaError) || err.status !== 404) throw err
      }

      let branches = []
      try {
        branches = await call(`${repoApi}/branches`)
      } catch {
        branches = []
      }
      if (!Array.isArray(branches) || branches.length === 0) return false

      const source = branches[0].name
      if (source === cfg.branch) return true

      try {
        await call(`${repoApi}/branches`, {
          method: 'POST',
          body: { new_branch_name: cfg.branch, old_branch_name: source },
        })
        await call(repoApi, { method: 'PATCH', body: { default_branch: cfg.branch } })
        return true
      } catch {
        return false
      }
    },
  }
}
