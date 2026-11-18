# 依赖库 · 客户端下载页

公共资源中心「依赖库」模块的客户端下载页。展示 Gitea generic registry 里的制品，
按 **平台 / 架构 / 分类** 组织，点击即下载。

前端是纯静态页面（HTML + CSS + 原生 JS），**没有框架、没有构建步骤**，改完文件刷新即生效。
这样 Windows 7 上能装的旧版 Chrome / Edge 也能正常打开。

## 目录结构

```
portal/
├── server/          门面服务（Express，唯一需要装依赖的部分）
│   ├── src/index.js    /client/deps 接口 + 托管前端静态文件
│   ├── src/catalog.js  制品目录：拉包、识别平台与架构、组装目录项
│   ├── src/gitea.js    Gitea API 封装（列包、取文件、带 Range 转发字节）
│   └── .env.example    配置模板
├── web/             前端静态资源（无构建）
│   ├── index.html     页面骨架
│   ├── app.js         全部交互逻辑
│   ├── styles.css     样式
│   └── favicon.svg
├── Dockerfile        镜像定义（上下文是 portal/，要同时带上 server 和 web）
└── .dockerignore     构建时排除 node_modules / .env
```

## 环境要求

- **Node ≥ 22.9**（服务端用了 `--env-file-if-exists`，20 及以下不支持）

本机装了 nvm，默认指向旧版本时先切换：

```bash
nvm use 22.22.2
node -v          # 应输出 v22.x
```

前端没有依赖，浏览器要求见文末「浏览器兼容性」。

## 跑起来

```bash
# 1. 装依赖（只有服务端有依赖）
cd portal/server
npm install

# 2. 配置（首次运行才需要）
cp .env.example .env
# 编辑 .env，填 GITEA_TOKEN，获取方式见 .env.example 里的注释

# 3. 启动
npm start
```

打开 <http://localhost:8787>，接口和页面在同一个端口。

开发时改 `web/index.html`、`web/app.js`、`web/styles.css` 直接刷新浏览器即可，
不需要编译。改服务端代码用 `npm run dev`（`--watch` 自动重启）。

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

## Docker 部署（四步）

镜像里**不带任何配置**，所有参数都在启动命令里用 `-e` 注入。传完镜像后，服务器上不需要任何
配置文件，也不依赖本地环境。

前置：服务器装好 docker（20.10+），安全组放行 8888。

**本地（WSL，在 `portal/` 目录下）**

```bash
# 1. 构建
docker build -t dep-portal:latest .

# 2. 打包
docker save dep-portal:latest | gzip -9 > dep-portal.tar.gz
```

**服务器（`dep-portal.tar.gz` 放上去之后）**

```bash
# 3. 加载包
gunzip -c dep-portal.tar.gz | docker load

# 4. 启动（先删旧容器，再带参数重建）
docker rm -f dep-portal 2>/dev/null
docker run -d \
  --name dep-portal \
  --restart unless-stopped \
  -p 8888:8787 \
  --add-host host.docker.internal:host-gateway \
  --log-opt max-size=10m --log-opt max-file=3 \
  -e GITEA_BASE_URL=http://47.103.196.145:3000 \
  -e GITEA_OWNER=zxp \
  -e GITEA_TOKEN=<read:package + read:repository 的令牌> \
  dep-portal:latest
```

四步跑完，打开 `http://47.103.196.145:8888`。

### 参数说明

| 参数 | 不写时的默认值 | 说明 |
| --- | --- | --- |
| `-e GITEA_TOKEN` | 空 | **必须给**，空的话页面能开但列表永远是空的 |
| `-e GITEA_BASE_URL` | `http://47.103.196.145:3000` | Gitea 地址 |
| `-e GITEA_OWNER` | `zxp` | 仓库 owner |
| `-e GITEA_REPO` | `my-dependency` | 一般不用写 |
| `-e GITEA_DEPS_DIR` | `deps` | 一般不用写 |
| `-e GITEA_BRANCH` | `main` | 一般不用写 |
| `-e PORT` | `8787` | **别改**，改了 `-p 8888:8787` 就对不上 |

端口、重启策略、日志上限都写在启动命令里，健康检查写在镜像里，没有任何外部文件。

### 改参数 / 更新版本

改哪一行就重跑第 4 步。`docker rm -f` 已经把旧容器删了，新容器一定带新参数，
不存在「改了没生效」的情况。只换端口就改 `-p 8888:8787` 的左边。

### 令牌别留在命令历史里

```bash
read -rsp 'GITEA_TOKEN: ' GITEA_TOKEN; echo
export GITEA_TOKEN
docker run -d ... -e GITEA_TOKEN ... dep-portal:latest    # 只写变量名、不带 =value
```

必须 `export`：`-e 变量名` 这种写法是 docker 从自己的进程环境里取值，只 `read` 不 `export`
会注入一个空值，症状和「没配置」一样。

`-e` 的代价是 `docker inspect dep-portal` 里能看到明文，这个没法避开。

### 服务器常用命令

```bash
docker logs -f --tail=100 dep-portal     # 日志
docker restart dep-portal                # 重启
docker rm -f dep-portal                  # 停止并删除容器
docker ps --filter name=dep-portal       # 状态（含 healthy）
docker exec dep-portal ls /app/web       # 看前端有没有打进镜像
```

### 回滚

打包时顺手留一份归档 `cp dep-portal.tar.gz dep-portal-20261118.tar.gz`，
回滚就 `gunzip -c 那份 | docker load`，再跑第 4 步。

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

新增一个分类要改两个地方：

| 文件 | 改动 |
| --- | --- |
| `server/src/catalog.js` | `CATEGORY_LABEL` 加键值 |
| `web/app.js` | `CATEGORY_ORDER` 加进排序，`CATEGORY_CLASS` 加样式映射 |

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

## 浏览器兼容性

前端只用了 ES2015 语法（`const` / 箭头函数 / 模板字符串 / `fetch` / `Promise`）
和 CSS 变量、Flexbox、Grid，**没有使用可选链、空值合并、`Array.flat`、`padStart`**
这类较新的语法，也没有用 ES Module（`<script type="module">`），
避免旧内核因为模块解析失败而整页白屏。

| 浏览器 | 支持情况 |
| --- | --- |
| Chrome 51+ / Edge 79+ | 完整支持 |
| Firefox 54+ | 完整支持 |
| Windows 7 上的 Chrome 109 / Edge 109 | 完整支持 |
| IE 11 | **不支持**（缺 CSS 变量与 `Promise`） |

改代码时注意别引入上面列出的新语法，`node --check web/app.js` 可以过一遍基础语法。

## 常见问题

**页面能打开但没有制品**
按顺序排查：`GITEA_OWNER` 是否写对 → `GITEA_TOKEN` 是否有 `read:package` →
包里是否上传了能识别出平台的制品（文件名不带平台标识的 `.zip` 会被忽略）。

**`npm start` 报 `fetch is not defined` 或 `--env-file-if-exists` 不认识**
Node 版本太低，`nvm use 22.22.2` 再跑。

**端口被占用**
改 `.env` 里的 `PORT`。

**改了 `web` 下的文件但页面没变**
服务端对静态文件设了 `no-cache`，正常刷新即可；如果还不变，检查是不是开了别的端口
（比如之前 `vite` 的 5173）。

**目录数据不是最新的**
服务端有 15 秒缓存，刷新页面不会绕过。加 `?refresh=1` 或点页面上的「刷新」按钮。

**Windows 7 上打开空白页**
先按 F12 看 Console 有没有语法错误。如果是 `Unexpected token` 之类，
说明新代码里混进了 ES2018+ 语法（可选链 `?.`、空值合并 `??` 最常见），改回兼容写法。

**Docker：第 4 步报找不到 `dep-portal:latest`**
第 3 步没成功，或者构建机用了别的 tag。服务器上 `docker images dep-portal` 确认镜像在不在。

**Docker：启动报 `port is already allocated`**
宿主机 8888 被占了。`ss -lntp | grep 8888` 看是谁，改启动命令里 `-p 8888:8787` 的左边，
安全组同步放行，再跑第 4 步。

**Docker：容器 healthy，但页面 404**
前端没进镜像。`docker exec dep-portal ls /app/web` 看一眼——空的就是 `.dockerignore`
把 `web/` 排掉了，或者 Dockerfile 里的 `COPY web ./web` 被改坏。

**Docker：页面能打开，制品列表空**
参数没注入进去或注入错了。先看容器里实际拿到什么：

```bash
docker inspect dep-portal --format '{{json .Config.Env}}' | tr ',' '\n' | grep GITEA
docker exec dep-portal sh -c 'wget -qO- http://127.0.0.1:8787/healthz'
```

`authenticated` 为 `false` → `-e GITEA_TOKEN` 没给或给了空值；owner 写错 → 日志里会有 `Gitea 404`。
Gitea 就在同一台宿主机上、且 3000 没对公网开放时，`-e GITEA_BASE_URL=http://host.docker.internal:3000`
（启动命令里已经加了 `--add-host host.docker.internal:host-gateway`）。

**Docker：本地构建卡在 `npm ci`**
`package-lock.json` 里的 `resolved` 已经指向 `registry.npmmirror.com`，正常几十秒装完。
换过源的话，锁文件里的地址不会自动跟着变，本地 `rm package-lock.json && npm install` 重新生成再提交。
