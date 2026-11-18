/**
 * 依赖库客户端门面（本地测试版）。
 *
 * 对外契约与设计方案 1.5「依赖库 · 客户端」一致：
 *   GET /client/deps/catalog?os=&arch=&q=
 *   GET /client/deps/:code/versions/:version/download
 * 生产环境这两个接口落在 Hub 的 DependencyModule 里，网关 /client/** 挂 jwt-auth；
 * 本地这层只负责把 Gitea generic registry 包成同样的形状，前端代码将来不用改。
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { getCatalog, findVersion } from './catalog.js';
import { openArtifact, giteaConfig } from './gitea.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
// 前端是纯静态页（html + css + 原生 js），没有构建产物，直接托管 web 目录
const WEB_ROOT = path.resolve(__dirname, '../../web');

const app = express();
app.disable('x-powered-by');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, gitea: giteaConfig });
});

app.get(
  '/client/deps/catalog',
  wrap(async (req, res) => {
    const { q = '', os = '', arch = '', platform = '', refresh = '' } = req.query;
    const data = await getCatalog({
      q: String(q),
      os: String(os),
      arch: String(arch),
      platform: String(platform),
      refresh: refresh === '1' || refresh === 'true',
    });
    res.json(data);
  }),
);

/**
 * 下载前的轻量探测。前端点下载先发 HEAD，只校验 manifest 不碰上游字节，
 * 失效时能拿到 4xx 原地提示，而不是让浏览器整页跳到 JSON。
 */
app.head(
  '/client/deps/:code/versions/:version/download',
  wrap(async (req, res) => {
    const { code, version } = req.params;
    const target = await findVersion(code, version);
    if (!target) {
      return res.status(404).end();
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(target.size || 0));
    res.status(200).end();
  }),
);

app.get(
  '/client/deps/:code/versions/:version/download',
  wrap(async (req, res) => {
    const { code, version } = req.params;
    // 平台/架构不再参与定位：manifest 里一个资产对应一套平台声明，
    // 这里只校验资产与版本是否启用。
    const target = await findVersion(code, version);
    if (!target) {
      return res.status(404).json({ message: '该版本不存在或未启用' });
    }

    const upstream = await openArtifact(code, version, target.storageName, req.headers.range);
    if (!upstream.ok && upstream.status !== 206) {
      // 403/404 是判定问题，5xx 才是存储不可用
      const status = upstream.status >= 500 ? 500 : 404;
      return res.status(status).json({
        message: status === 500 ? '服务暂时不可用，请稍后重试' : '文件不存在',
      });
    }
    if (!upstream.body) {
      return res.status(500).json({ message: '服务暂时不可用，请稍后重试' });
    }

    res.status(upstream.status);
    const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/octet-stream');
    // 头里只能出现 ASCII：中文文件名直接塞进 filename= 会让 Node 抛 ERR_INVALID_CHAR，
    // 整个响应变成 500。按 RFC 6266 / 5987 拆两段：
    //   filename=   给 ASCII 兜底（纯中文名换 download.exe 这种）
    //   filename*=  给真实名，percent-encoded，现代浏览器优先用它
    const fallbackName = /^[\x20-\x7E]+$/.test(target.fileName)
      ? target.fileName.replace(/["\\]/g, '_')
      : `download${path.extname(target.fileName).replace(/[^\x20-\x7E]/g, '')}`;
    res.setHeader(
      'content-disposition',
      `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(target.fileName)}`,
    );

    // 审计占位：生产环境这里是异步写 audit_log，不阻塞流
    const started = Date.now();
    res.on('close', () => {
      console.log(
        `[download] ${code}@${version} ${target.fileName} ${Math.round(target.size / 1024)}KB -> ${res.statusCode} ${Date.now() - started}ms`,
      );
    });

    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }),
);

// 静态页面：目录里没有构建步骤，改完文件刷新即生效，统一不缓存
if (fs.existsSync(WEB_ROOT)) {
  app.use(
    express.static(WEB_ROOT, {
      index: 'index.html',
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
}

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  const status = err.status === 404 ? 404 : 500;
  res.status(status).json({
    message: status === 500 ? '服务暂时不可用，请稍后重试' : '资源不存在',
  });
});

app.listen(PORT, () => {
  console.log(`[dep-portal] http://localhost:${PORT}`);
  console.log(`[dep-portal] gitea=${giteaConfig.base} owner=${giteaConfig.owner} auth=${giteaConfig.authenticated}`);
});
