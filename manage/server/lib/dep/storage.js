/**
 * 依赖库存储驱动：只有 Gitea，没有本地落盘。
 *
 * 两条通道刻意分开：
 *   manifest -> 仓库 contents API（几 KB 的 JSON，人可读、可 diff、可回滚）
 *   制品字节 -> generic package registry（裸字节 PUT，不 base64、不进 git 历史、不落临时盘）
 *
 * 为什么不走仓库 contents 存制品：要 base64（体积 +34%），且受
 * [repository.upload] FILE_MAX_SIZE（默认 50 MB）限制，几百 MB 的 exe 直接被拒。
 */
import { Readable } from 'node:stream'
import { HttpError } from '../http-error.js'

const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/')

const notFound = (msg = '制品文件不存在') => new HttpError(404, msg)

export function createDepGiteaDriver({ gitea, cfg }) {
  const { giteaUrl, giteaToken, owner, repo, branch, depsDir } = cfg
  const base = giteaUrl.replace(/\/+$/, '')
  const repoApi = `${base}/api/v1/repos/${enc(owner)}/${enc(repo)}`
  const auth = { Authorization: `token ${giteaToken}` }
  const manifestPath = (code) => `${depsDir}/${code}/manifest.json`
  const packageUrl = (code, version, fileName) =>
    `${base}/api/packages/${enc(owner)}/generic/${enc(code)}/${enc(version)}/${enc(fileName)}`

  const LONG_TIMEOUT_MS = 6 * 3600 * 1000

  async function tree(shaOrRef) {
    let res
    try {
      res = await fetch(`${repoApi}/git/trees/${encodeURIComponent(shaOrRef)}`, {
        headers: auth,
        signal: AbortSignal.timeout(20000),
      })
    } catch {
      throw new HttpError(502, 'Gitea 不可达，检查 GITEA_URL 与网络')
    }
    if (res.status === 404) return null
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(502, '制品库鉴权失败：令牌缺少 read:repository 权限，或仓库不存在')
    }
    if (!res.ok) throw new HttpError(502, `读取仓库树失败（${res.status}）`)
    return res.json()
  }

  return {
    name: 'gitea',

    async listManifests() {
      const root = await tree(branch)
      if (!root) return []
      const dir = (root.tree || []).find((e) => e.type === 'tree' && e.path === depsDir)
      if (!dir) return []

      const list = await tree(dir.sha)
      const codes = (list?.tree || []).filter((e) => e.type === 'tree').map((e) => e.path)

      const out = []
      const queue = codes.slice()
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
      const file = await gitea.getFile(manifestPath(code))
      if (!file) return null
      try {
        return JSON.parse(file.content.toString('utf8'))
      } catch {
        return null
      }
    },

    async writeManifest(manifest) {
      const filePath = manifestPath(manifest.code)
      const buffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      const existing = await gitea.getFile(filePath)
      try {
        await gitea.putFile(filePath, buffer, `chore(dep): 更新 ${manifest.code}`, existing?.sha)
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          throw new HttpError(502, '写 manifest 失败：令牌缺少 write:repository 权限')
        }
        if (err?.status === 404) {
          throw new HttpError(502, `仓库 ${owner}/${repo} 不存在或分支 ${branch} 不存在`)
        }
        throw err
      }
    },

    async deleteManifest(code) {
      await gitea.deleteFile(manifestPath(code), `chore(dep): 删除 ${code}`)
    },

    async putArtifact({ code, version, fileName, stream, size }) {
      let res
      try {
        res = await fetch(packageUrl(code, version, fileName), {
          method: 'PUT',
          headers: {
            ...auth,
            'Content-Type': 'application/octet-stream',
            ...(size ? { 'Content-Length': String(size) } : {}),
          },
          body: Readable.toWeb(stream),
          duplex: 'half',
          signal: AbortSignal.timeout(LONG_TIMEOUT_MS),
        })
      } catch {
        throw new HttpError(502, '上传中断：Gitea 不可达或连接被重置')
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (res.status === 409) throw new HttpError(409, '该版本下已存在同名文件，版本不可覆盖')
        if (res.status === 400) throw new HttpError(422, 'Gitea 拒绝了文件名或版本号格式')
        if (res.status === 401 || res.status === 403) {
          throw new HttpError(502, '制品库鉴权失败：令牌缺少 write:package 权限')
        }
        if (res.status === 413) throw new HttpError(413, '超过制品库单文件上限')
        throw new HttpError(502, `Gitea 上传失败（${res.status}）${text ? `：${text.slice(0, 160)}` : ''}`)
      }
      return { path: `${code}/${version}/${fileName}`, size: size || 0 }
    },

    async deleteArtifact(relPath) {
      const [code, version, fileName] = relPath.split('/')
      if (!code || !version || !fileName) return
      await fetch(packageUrl(code, version, fileName), {
        method: 'DELETE',
        headers: auth,
        signal: AbortSignal.timeout(30000),
      }).catch(() => {})
    },

    async fetchArtifact(relPath, { range } = {}) {
      const [code, version, fileName] = relPath.split('/')
      if (!code || !version || !fileName) throw notFound('制品路径不合法')

      let res
      try {
        res = await fetch(packageUrl(code, version, fileName), {
          headers: { ...auth, ...(range ? { Range: range } : {}) },
          signal: AbortSignal.timeout(LONG_TIMEOUT_MS),
        })
      } catch {
        throw new HttpError(502, '取制品失败：Gitea 不可达')
      }
      if (!res.ok) {
        if (res.status === 404) throw notFound()
        if (res.status === 401 || res.status === 403) {
          throw new HttpError(502, '读制品失败：令牌缺少 read:package 权限')
        }
        throw new HttpError(502, `取制品失败（${res.status}）`)
      }
      const headers = {}
      for (const key of ['content-length', 'content-range', 'accept-ranges', 'content-type']) {
        const value = res.headers.get(key)
        if (value) headers[key] = value
      }
      if (!headers['content-type']) headers['content-type'] = 'application/octet-stream'
      return {
        status: res.status,
        headers,
        body: res.body ? Readable.fromWeb(res.body) : Readable.from([]),
      }
    },
  }
}
