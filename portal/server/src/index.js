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
const WEB_DIST = path.resolve(__dirname, '../../web/dist');

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

app.get(
  '/client/deps/:code/versions/:version/download',
  wrap(async (req, res) => {
    const { code, version } = req.params;
    const platform = req.query.platform ? String(req.query.platform) : '';
    const arch = req.query.arch ? String(req.query.arch) : '';
    const target = await findVersion(code, version, platform, arch);
    if (!target) {
      return res.status(404).json({ message: '该版本不存在' });
    }

    const upstream = await openArtifact(code, version, target.fileName, req.headers.range);
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
    res.setHeader(
      'content-disposition',
      `attachment; filename="${target.fileName}"; filename*=UTF-8''${encodeURIComponent(target.fileName)}`,
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

// 生产构建产物：npm --prefix web run build 之后可直接用这一个进程跑
if (fs.existsSync(WEB_DIST)) {
  app.use(
    express.static(WEB_DIST, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        // 带 hash 的静态资源可以长缓存，入口 HTML 必须每次回源，
        // 否则重新构建后浏览器会拿着旧 HTML 去找已删除的旧 JS，直接白屏。
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
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
