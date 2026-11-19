# 依赖库管理端（dep-manage）
#
# 两阶段：先在 Node 镜像里构建 React 前端，再把 dist 拷进运行镜像。
# 运行镜像不带 vite / react / typescript 之类的构建期依赖。
#
# 构建上下文是 manage/（不是 manage/server/）：
# 服务端要托管 ../web/dist，镜像内必须保持 /app/server + /app/web/dist 的结构。
#
# 构建：docker build -t dep-manage:latest .    （在 manage/ 目录下执行）
# 运行：docker run -d ... dep-manage:latest

# ---------------------------------------------------------------- 前端构建
FROM node:22-alpine AS web-builder

# 依赖源。国内默认走 npmmirror；海外构建时用
#   --build-arg NPM_REGISTRY=https://registry.npmjs.org
# 覆盖。注意 package-lock.json 的 resolved 已指向 npmmirror，换源后要重新生成锁文件才生效。
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /build

# 依赖单独一层：只改业务代码时不会触发重装
COPY web/package.json web/package-lock.json ./
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm ci \
    && npm cache clean --force

COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- 运行
FROM node:22-alpine AS runtime

ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 只装服务端运行时依赖（express + @aws-sdk/client-s3）
COPY server/package.json server/package-lock.json ./server/
RUN npm config set registry "${NPM_REGISTRY}" \
    && cd server \
    && npm ci --omit=dev \
    && npm cache clean --force

COPY server/ ./
COPY --from=web-builder /build/dist ./web/dist

EXPOSE 8788

# 根路径就是静态 index.html：能拿到 200 说明服务、静态资源、dist 都在位。
# 不用 /server/** 探活，那条要鉴权，401 会被 wget 判成失败。
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8788}/" || exit 1

# 8788 不需要特权端口，用镜像内置的非 root 用户跑
USER node

CMD ["node", "server/index.js"]
