# 依赖库 · 客户端下载页

公共资源中心「依赖库」模块的客户端下载页。展示 Gitea generic registry 里的制品，
按 **平台 / 架构 / 分类** 组织，点击即下载。

## 目录结构

```
portal/
├── server/          门面服务（Express）
│   ├── src/index.js    /client/deps 接口 + 生产环境托管前端
│   ├── src/catalog.js  制品目录：拉包、识别平台与架构、组装目录项
│   ├── src/gitea.js    Gitea API 封装（列包、取文件、带 Range 转发字节）
│   └── .env.example    配置模板
└── web/             前端（React 18 + Vite 5 + TypeScript）
    ├── src/App.tsx
    ├── src/components/
    └── src/styles.css
```

## 环境要求

- **Node ≥ 22.9**（服务端用了 `--env-file-if-exists`，20 及以下不支持）

本机装了 nvm，默认指向旧版本时先切换：

```bash
nvm use 22.22.2
node -v          # 应输出 v22.x
```

## 五分钟跑起来

```bash
# 1. 安装依赖
cd portal/server && npm install
cd ../web && npm install

# 2. 配置（首次运行才需要）
cd ../server
cp .env.example .env
# 编辑 .env，填 GITEA_TOKEN，获取方式见 .env.example 里的注释

# 3. 构建前端
cd ../web && npm run build

# 4. 启动，接口和页面在同一个端口
cd ../server && npm start
```

打开 <http://localhost:8787>。

### 开发模式（前端热更新）

前后端分开跑，Vite 把 `/client` 代理到门面：

```bash
# 终端 1
cd portal/server && npm run dev     # http://localhost:8787（--watch 自动重启）

# 终端 2
cd portal/web && npm run dev        # http://localhost:5173
```

改前端代码时访问 5173，改服务端时 8787 会自动重启。

### 生产模式

前端构建产物在 `web/dist`，门面检测到该目录就直接托管：

```bash
cd portal/web && npm run build
cd ../server && npm start           # 单进程，只需 8787 一个端口
```

## 配置项

| 变量 | 说明 |
| --- | --- |
| `GITEA_BASE_URL` | Gitea 地址，如 `http://47.103.196.145:3000` |
| `GITEA_OWNER` | generic registry 的 owner，组织名或用户名 |
| `GITEA_TOKEN` | 访问令牌，**只需要 `read:package` 权限** |
| `PORT` | 门面端口，默认 8787 |

令牌获取（二选一，只在生成时显示一次）：

```bash
# 网页：登录 → 头像 → 设置 → 应用 → 生成新令牌，只勾 read:package

# 命令行
docker exec -u git gitea gitea admin user generate-access-token \
  --username <用户名> --token-name dep-portal-read --scopes read:package --raw
```

真实令牌只写进 `.env`（已在 `.gitignore` 中）。`.env.example` 会进版本库，保持空值。

## 制品怎么放

往 Gitea 上传 generic 包，**平台和架构靠文件名识别**：

```bash
curl -X PUT \
  -H "Authorization: token <write:package 的令牌>" \
  --data-binary @demo-client-win10-x64.exe \
  http://<gitea>/api/packages/<owner>/generic/demo-client/1.0.0/demo-client-win10-x64.exe
```

| 文件名里的标识 | 识别结果 |
| --- | --- |
| `win7` | Windows 7 |
| `win10` / `win11` | Windows 10+ |
| `macos` / `osx` / `darwin`，或后缀 `.dmg` `.pkg` | macOS |
| `linux` / `ubuntu` / `debian`，或后缀 `.deb` `.rpm` `.AppImage` `.tar.gz` | Linux |
| 无平台标识的 `.exe` | 默认 Windows 10+ |
| 认不出平台的（`.json`、无标识的 `.zip` 等） | 不进目录，直接忽略 |

架构：`arm64` / `aarch64` → arm64，`x64` / `amd64` / `x86_64` → x64，
`x86` / `i386` / `ia32` → x86，都没写时用配置里的默认值（x64）。

同一个版本可以放多个平台的制品，目录会自动拆成多条；同一个「平台 + 架构」有多个文件时，取体积最大的那个。

### 展示名称与分类

包名是英文 code，页面上的中文名、描述、分类在 `server/src/catalog.js` 的 `META` 里配：

```js
const META = {
  'demo-client': {
    name: '客户端安装包',
    description: '主程序安装包，含内置运行时。',
    category: 'installer',   // installer / runtime / driver / patch，未配则归 other
    tags: ['安装包'],
  },
};
```

没登记的包照常显示，用包名当名称、分类落到「未分类」。

新增一个分类要同时改三个地方：

| 文件 | 改动 |
| --- | --- |
| `server/src/catalog.js` | `CATEGORY_LABEL` 加键值 |
| `web/src/App.tsx` | `CATEGORY_ORDER` 加进排序 |
| `web/src/components/DependencyCard.tsx` | `CATEGORY_CLASS` 加样式映射 |

## 接口

```http
GET /client/deps/catalog
    ?q=关键字
    &platform=win7|win10|macos|linux
    &arch=x64|x86|arm64
    &os=windows|macos|linux
    &refresh=1           # 跳过 15 秒缓存

GET /client/deps/{code}/versions/{version}/download
    ?platform=win7&arch=x64
```

下载响应带 `Content-Disposition: attachment` 和 `Accept-Ranges: bytes`，
浏览器直接接管下载，支持断点续传。

## 常见问题

**页面能打开但没有制品**
按顺序排查：`GITEA_OWNER` 是否写对 → `GITEA_TOKEN` 是否有 `read:package` →
包里是否上传了能识别出平台的制品（文件名不带平台标识的 `.zip` 会被忽略）。

**`npm start` 报 `fetch is not defined` 或 `--env-file-if-exists` 不认识**
Node 版本太低，`nvm use 22.22.2` 再跑。

**端口被占用**
改 `.env` 里的 `PORT`，前端开发模式还要同步改 `web/vite.config.ts` 的代理目标。

**部署后前端白屏**
`index.html` 已经设成 `no-cache`，带 hash 的静态资源是长缓存。
如果还是白屏，检查 `web/dist` 是否是最近一次 `npm run build` 的产物。

**目录数据不是最新的**
服务端有 15 秒缓存，刷新页面不会绕过。加 `?refresh=1` 或等 15 秒。
