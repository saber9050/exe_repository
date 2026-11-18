# 依赖库客户端门面（dep-portal）
#
# 构建上下文是 portal/ 而不是 portal/server/：
# 服务端要托管同级的 web/ 静态目录（src/index.js 里 WEB_ROOT = ../../web），
# 镜像内必须保持 /app/server + /app/web 的兄弟目录结构。
#
# 构建：docker compose build        （在 portal/ 目录下执行）
# 运行：docker compose up -d

FROM node:22-alpine

# 依赖源。国内默认走 npmmirror；海外构建时用 --build-arg NPM_REGISTRY=https://registry.npmjs.org 覆盖。
# 注意 package-lock.json 里的 resolved 已经指向 npmmirror，换源后需要重新生成锁文件才生效。
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 依赖单独一层：只改业务代码时不会触发重装
COPY server/package.json server/package-lock.json ./server/
RUN npm config set registry "${NPM_REGISTRY}" \
    && cd server \
    && npm ci --omit=dev \
    && npm cache clean --force

COPY server/src ./server/src
COPY web ./web

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8787}/healthz" || exit 1

# 端口 8787 不需要特权，用镜像内置的非 root 用户跑
USER node

CMD ["node", "server/src/index.js"]
