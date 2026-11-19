# 依赖库 · 管理端

公共资源中心「依赖库」模块的管理端。从 dsh 插件市场里分离出来的独立服务：
只保留**依赖库**这一块（资产登记、制品上传、启停、审计），插件库的路由、仓储、
包上传都不在这个进程里。

和 `portal/`（客户端下载页）是一对：同一个 MinIO 桶、同一批资产，两个服务分端口。

制品、清单、审计全部落 MinIO（S3 协议），本地不落任何状态。
分片上传 8 MiB/片，支持断点续传；小文件（< 32 MiB）走单请求直传省两次往返。

```
manage/
├── server/                  Express 服务（唯一需要装依赖的部分）
│   ├── index.js               启动入口：监听、超时、错误提示
│   ├── app.js                 路由装配：登录 / 审计 / 静态托管
│   ├── lib/
│   │   ├── config.js             .env 解析与配置项
│   │   ├── auth.js               管理端会话（Bearer，平台账号）
│   │   ├── audit.js              审计日志（audit.json，串行写入）
│   │   ├── http-error.js         带状态码的业务错误
│   │   ├── storage/s3.js         MinIO / S3 客户端封装（对象 + Multipart）
│   │   └── dep/                  资产仓储、清单、MinIO 驱动、分片会话
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
cp .env.example .env          # 填 MINIO_* 与 ADMIN_PASSWORD
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

配置项见 `server/.env.example`。与 `portal/` 的差异：

| 本服务 | portal | 说明 |
| --- | --- | --- |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 同名 | 本服务要**读写**，portal 只读（建议单独建只读账号） |
| `PORT=8788` | `PORT=8787` | 错开端口 |
| 分片参数（`DEP_*`） | 无 | portal 只读，不需要 |

`MINIO_ENDPOINT` / `MINIO_BUCKET` / `MINIO_PREFIX` 两边必须完全一致，
否则下载页会变空（不报错，更难发现）。

## Docker 部署（四步）

镜像里**不带任何配置**，所有参数都在启动命令里用 `-e` 注入。传完镜像后，服务器上不需要任何
配置文件，也不依赖本地环境。

和 `portal/` 的关系：两个容器必须指向**同一个 MinIO 桶**，但用**不同凭据** ——
manage 读写、portal 只读。**先启动 manage**：它会自动建桶；portal 先起会读不到桶。

前置：服务器装好 docker（20.10+），安全组放行 8889。

**本地（在 `manage/` 目录下）**

```bash
# 1. 构建。要装两套依赖并在镜像里构建前端，首次约 2~4 分钟
docker build -t dep-manage:latest .

# 2. 打包
docker save dep-manage:latest | gzip -9 > dep-manage.tar.gz
```

**服务器（`dep-manage.tar.gz` 放上去之后）**

```bash
# 3. 加载包
gunzip -c dep-manage.tar.gz | docker load

# 4. 启动（先删旧容器，再带参数重建）
docker rm -f dep-manage 2>/dev/null
docker run -d \
  --name dep-manage \
  --restart unless-stopped \
  -p 8889:8788 \
  --add-host host.docker.internal:host-gateway \
  --log-opt max-size=10m --log-opt max-file=3 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD='<强密码>' \
  -e SESSION_SECRET='<32 字节 hex，见下>' \
  -e MINIO_ENDPOINT=host.docker.internal \
  -e MINIO_PORT=9000 \
  -e MINIO_ACCESS_KEY='<读写凭据>' \
  -e MINIO_SECRET_KEY='<读写密钥>' \
  -e MINIO_BUCKET=dep-artifacts \
  dep-manage:latest
```

四步跑完，打开 `http://47.103.196.145:8889`。

### 参数说明

必须给的三项，缺了会出问题：

| 参数 | 为什么必须 | 不填的后果 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 管理端登录密码 | 回落到代码里的 `dsh@2026`，等于没密码 |
| `SESSION_SECRET` | 给登录 token 签名 | 回落到公开的 `dev-only-change-me`，拿到这个值就能伪造管理员 token |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 读写对象存储 | 启动日志报「对象存储初始化失败」，所有接口 502 |

其余参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | 登录账号 |
| `ADMIN_NAME` | `平台管理员` | 审计里显示的操作人 |
| `SESSION_TTL_SECONDS` | `43200` | 登录态有效期（12 小时） |
| `MINIO_ENDPOINT` | `127.0.0.1` | 容器里填 `127.0.0.1` 指向容器自己，见下节 |
| `MINIO_PORT` | `9000` | |
| `MINIO_USE_SSL` | `false` | 内网 http 保持 false |
| `MINIO_BUCKET` | `dep-artifacts` | 与 portal 必须一致 |
| `MINIO_PREFIX` | 空 | 与 portal 必须一致，不一致会变成空目录 |
| `MINIO_AUTO_CREATE_BUCKET` | `true` | 桶不存在时自动建（默认私有） |
| `DEP_PART_SIZE` | `8388608` | 分片大小，**不能低于 5 MiB**，否则合并会被 MinIO 拒绝 |
| `DEP_MAX_FILE_BYTES` | `21474836480` | 单文件上限，默认 20 GiB |
| `PORT` | `8788` | **别改**，改了 `-p 8889:8788` 就对不上 |

### MINIO_ENDPOINT 怎么填

容器里的 `127.0.0.1` 是容器自己，不是宿主机。三种情况：

| MinIO 在哪 | 填什么 | 备注 |
| --- | --- | --- |
| 同一台宿主机（docker） | `host.docker.internal` | 启动命令已加 `--add-host`，Linux 也能解析 |
| 同一台宿主机（裸装进程） | `host.docker.internal` | 同上 |
| 另一台机器 / 云上独立实例 | 内网 IP，如 `172.24.0.5` | 别填公网 IP，走内网免流量费也更快 |

也可以用 `--network host` 让容器直用宿主网络栈，那时 `MINIO_ENDPOINT=127.0.0.1` 就对，
但 `-p` 会失效（端口直接占宿主的 8788）。

### 凭据权限

manage 要读写，别把 portal 那个只读凭据拿来用：

```
s3:*  on arn:aws:s3:::dep-artifacts/*        必需：Get/Put/Delete/List + 各类 multipart
s3:CreateBucket  on arn:aws:s3:::dep-artifacts   自动建桶需要，关掉开关后可去掉
```

生命周期规则（`AbortIncompleteMultipartUpload`）需要 `s3:PutBucketLifecycleConfiguration`。
给不了也不影响上传下载，只是中断的分片要靠服务端 TTL 兜底。

### SESSION_SECRET 怎么来

不是去哪里申请，是随便生成一串随机值：

```bash
openssl rand -hex 32
# 或
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

改掉这个值，所有已登录会话立即失效（要重新登录）。

### 改参数 / 更新版本

改哪一行就重跑第 4 步。`docker rm -f` 已经把旧容器删了，新容器一定带新参数，
不存在「改了没生效」的情况。只换端口就改 `-p 8889:8788` 的左边。

### 密码别留在命令历史里

```bash
read -rsp 'ADMIN_PASSWORD: ' ADMIN_PASSWORD; echo
read -rsp 'MINIO_SECRET_KEY: ' MINIO_SECRET_KEY; echo
export ADMIN_PASSWORD MINIO_SECRET_KEY
docker run -d ... -e ADMIN_PASSWORD -e MINIO_SECRET_KEY ... dep-manage:latest    # 只写变量名、不带 =value
```

必须 `export`：`-e 变量名` 这种写法是 docker 从自己的进程环境里取值，只 `read` 不 `export`
会注入空值，症状和「没配置一样」。

`-e` 的代价是 `docker inspect dep-manage` 里能看到明文，这个没法避开。

### 和下载页一起部署

```bash
# 1. 先起 manage —— 它会建桶、初始化目录
docker run -d --name dep-manage ... dep-manage:latest

# 2. 确认桶正常（日志里应有「对象存储可用」）
docker logs --tail=20 dep-manage

# 3. 再起 portal，指向同一个桶
docker run -d --name dep-portal ... dep-portal:latest
```

顺序反了不会报错，只是下载页目录为空 —— 因为桶还没建出来。

### 服务器常用命令

```bash
docker logs -f --tail=100 dep-manage          # 日志
docker logs --tail=50 dep-manage | grep -E "桶|对象存储|分片"   # 看存储自检结果
docker restart dep-manage                     # 重启
docker rm -f dep-manage                       # 停止并删除容器
docker ps --filter name=dep-manage            # 状态（含 healthy）
docker exec dep-manage ls /app/web/dist       # 看前端有没有打进镜像
```

### 回滚

打包时顺手留一份归档 `cp dep-manage.tar.gz dep-manage-20261119.tar.gz`，
回滚就 `gunzip -c 那份 | docker load`，再跑第 4 步。

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
| POST | `/server/deps/:code/versions` | 单请求直传（小文件） |
| POST | `/server/deps/:code/uploads` | 创建分片上传会话 |
| GET | `/server/deps/:code/uploads` | 进行中的会话列表 |
| GET | `/server/deps/:code/uploads/:uploadId` | 查已传分片（断点续传） |
| PUT | `/server/deps/:code/uploads/:uploadId/parts/:n` | 上传一片 |
| POST | `/server/deps/:code/uploads/:uploadId/complete` | 完成并登记版本（幂等） |
| DELETE | `/server/deps/:code/uploads/:uploadId` | 放弃会话，Abort 分片 |
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

- **制品不走 base64、不落本地磁盘**：分片模式下每片直接管道到对象存储；
  单请求模式下边收边算 sha256 再流式写入。
- **分片阶段不持写锁**：只有 `commitVersion` 进锁。旧实现整个上传周期持锁，
  一个大文件会把所有写操作排队 30 分钟。
- **两段写**：先写字节再写 manifest；manifest 失败会删掉刚写入的字节，
  不留绕过「版本不可变」的孤儿制品。
- **每片 ≥ 5 MiB**（末片除外）：S3 规范硬约束，配小了会在 complete 被拒。
- **版本不可变**：同版本重复上传直接 409，没有覆盖入口。
- **审计不阻断主流程**：落盘失败回滚内存并返回 null，不影响上传本身。
- **上传超时不设总时长**（`server.requestTimeout = 0`），只限制头部超时，
  否则几百 MB 的 exe 会被默认 300 秒掐断。
