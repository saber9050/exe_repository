# 依赖库 · 管理端

公共资源中心「依赖库」模块的管理端。从 dsh 插件市场里分离出来的独立服务：
只保留**依赖库**这一块（资产登记、制品上传、启停、审计），插件库的路由、仓储、
包上传都不在这个进程里。

和 `portal/`（客户端下载页）是一对：同一套 Gitea 仓库、同一批资产，两个服务分端口。

```
manage/
├── server/                  Express 服务（唯一需要装依赖的部分）
│   ├── index.js               启动入口：监听、超时、错误提示
│   ├── app.js                 路由装配：登录 / 审计 / 静态托管
│   ├── lib/
│   │   ├── config.js             .env 解析与配置项
│   │   ├── gitea.js              Gitea API（contents + generic registry）
│   │   ├── auth.js               管理端会话（Bearer，平台账号）
│   │   ├── audit.js              审计日志（audit.json，串行写入）
│   │   ├── http-error.js         带状态码的业务错误
│   │   └── dep/                  资产仓储、清单、制品驱动、下载计数
│   ├── routes/deps.js           /server/deps/** 与 /client/deps/**
│   └── .env.example             配置模板
└── web/                     React + Vite 管理端
    ├── src/
    │   ├── pages/admin/          登录、资产列表、登记、详情、审计
    │   ├── api/                  请求层（同源，令牌只在内存/localStorage）
    │   ├── components/           表格、徽章、确认框等
    │   └── styles/               tokens / base / admin
    └── vite.config.js
```

## 环境要求

- **Node ≥ 22**（服务端用了 `fetch` + `AbortSignal.timeout` 与大文件流式转发）

## 跑起来

### 开发模式（两个进程，前端热更新）

```bash
# 1. 服务端
cd manage/server
cp .env.example .env          # 填 GITEA_OWNER / GITEA_TOKEN / ADMIN_PASSWORD
npm install
npm run dev                   # http://127.0.0.1:8788

# 2. 前端（另开一个终端）
cd manage/web
npm install
npm run dev                   # http://127.0.0.1:5184，/client 与 /server 代理到 8788
```

### 生产模式（单进程）

```bash
cd manage/web && npm install && npm run build   # 产物在 web/dist
cd ../server && npm install && npm start        # 服务端直接托管 web/dist
```

访问 `http://127.0.0.1:8788` 即可；根路径会跳到 `/admin/deps`。

## 配置

配置项见 `server/.env.example`。与 `portal/` 的差异只在变量名：

| 本服务 | portal | 说明 |
| --- | --- | --- |
| `GITEA_URL` | `GITEA_BASE_URL` | 同一个 Gitea 实例 |
| `GITEA_OWNER` / `GITEA_REPO` / `GITEA_BRANCH` | 同名 | 同一个仓库 |
| `GITEA_TOKEN` | `GITEA_TOKEN` | 本服务要 **读写**（repository + package），portal 只读 |
| `PORT=8788` | `PORT=8787` | 错开端口 |
| `DEP_GITEA_DIR=deps` | `GITEA_DEPS_DIR=deps` | 清单目录 |

令牌权限要求不同：管理端要写清单、传制品，portal 只需要读。

## 接口

管理端（需登录，`Authorization: Bearer <token>`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/server/auth/login` | 换 token |
| GET | `/server/me` | 当前账号 |
| GET | `/server/deps/meta` | 分类 / 平台 / 架构 / 上限 |
| GET | `/server/deps` | 资产列表（`q` / `status` / `category`） |
| POST | `/server/deps` | 登记资产 |
| GET | `/server/deps/:code` | 资产详情（含版本表） |
| PUT | `/server/deps/:code` | 改元信息 |
| POST | `/server/deps/:code/versions` | 上传制品（裸流，非 base64） |
| POST | `/server/deps/:code/versions/:version/enable` | 版本生效 |
| POST | `/server/deps/:code/versions/:version/disable` | 版本失效 |
| DELETE | `/server/deps/:code/versions/:version` | 删版本 |
| POST | `/server/deps/:code/enable` · `disable` · `take-down` · `restore` | 资产开关 |
| DELETE | `/server/deps/:code` | 删资产 |
| GET | `/server/audit` | 审计（最新在前） |

客户端（只读，允许跨域）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/client/deps/catalog` | 目录（`os` / `arch` / `category` / `q`） |
| GET | `/client/deps/:code` | 资产详情 |
| GET | `/client/deps/:code/versions` | 版本列表 |
| GET | `/client/deps/:code/versions/:version/download` | 下载（透传 Range） |

## 几条硬约定

- **制品走裸流**：上传用 `Content-Type: application/octet-stream` 直接写请求体，
  不经过 base64，也不落本地磁盘 —— 边收边算 sha256，直接流式转给 Gitea。
- **两段写**：先写字节再写 manifest；manifest 失败会删掉刚写入的字节，
  不留绕过「版本不可变」的孤儿制品。
- **版本不可变**：同版本重复上传直接 409，没有覆盖入口。
- **审计不阻断主流程**：落盘失败回滚内存并返回 null，不影响上传本身。
- **上传超时不设总时长**（`server.requestTimeout = 0`），只限制头部超时，
  否则几百 MB 的 exe 会被默认 300 秒掐断。
