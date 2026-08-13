/**
 * 本地服务：零第三方依赖，只用 node: 内置模块。
 *
 * 这么克制是有原因的 —— Windows 上让用户跑 `npm install` 是有真实成本的：
 * 装 node-gyp、装 VS Build Tools、公司网络还可能连不上 registry。
 * 现在的形态是：装个 Node，双击启动.bat 就能用；要打包成 exe 再另说。
 *
 * 安全上按"本机专用服务"来设计：只监听 127.0.0.1，校验 Host 与 Origin，
 * 防的是浏览器里某个网页偷偷往你本地端口发请求（DNS rebinding 那一类）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UI_DIR, DATA_DIR, ensureDirs } from './paths.js';
import * as settings from './settings.js';
import * as vault from './vault.js';
import * as logbus from './logbus.js';
import * as httpClient from './http-client.js';
import * as store from './store.js';
import * as ffmpeg from './ffmpeg.js';
import * as providers from './providers/index.js';
import * as adapters from './providers/adapters.js';
import * as studio from './pipeline/studio.js';
import * as preflight from './preflight.js';
import * as styles from './styles.js';
import * as duration from './duration.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon'
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * NDJSON 流：一行一个事件。
 * 用它而不是 SSE，是因为前端要的就是"边跑边看"，而 NDJSON 在 fetch + ReadableStream 下
 * 处理起来比 EventSource 简单，还能带 POST body。
 */
function ndjson(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });
  let closed = false;
  return {
    send(event) {
      if (closed) return;
      res.write(`${JSON.stringify(event)}\n`);
    },
    end(event) {
      if (closed) return;
      if (event) res.write(`${JSON.stringify(event)}\n`);
      closed = true;
      res.end();
    },
    get closed() {
      return closed;
    }
  };
}

/** 只有本机、只有自己的页面能调 */
function guard(req) {
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    return '仅允许通过 127.0.0.1 访问';
  }
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) && origin !== 'null') {
    return `拒绝跨站请求：${origin}`;
  }
  return null;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const full = path.join(UI_DIR, rel);
  // 目录穿越防护：解析后必须仍在 ui/ 之内
  if (!full.startsWith(UI_DIR + path.sep) && full !== path.join(UI_DIR, 'index.html')) {
    return json(res, 403, { error: '非法路径' });
  }
  fs.readFile(full, (err, data) => {
    if (err) return json(res, 404, { error: `找不到 ${rel}` });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/** 播放项目里的图片/视频。只放行 DATA_DIR 之内的文件。 */
function serveMedia(req, res, url) {
  const target = url.searchParams.get('p');
  if (!target) return json(res, 400, { error: '缺少 p 参数' });
  const full = path.resolve(target);
  if (!full.startsWith(path.resolve(DATA_DIR) + path.sep)) {
    return json(res, 403, { error: '只允许访问应用数据目录内的文件' });
  }
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    // 视频要能拖进度条，就得支持 Range
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    const start = Number(startRaw) || 0;
    const end = endRaw ? Number(endRaw) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      // 重出的图/视频文件名不变，浏览器一缓存就会拿旧的糊弄你 ——
      // "明明重出了却还是原来那张"多半就是这么来的
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(full).pipe(res);
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c, d, e, f] = seg;
  const method = req.method;

  // ---- 基础信息 ----
  if (a === 'health') {
    return json(res, 200, {
      ok: true,
      dataDir: DATA_DIR,
      node: process.version,
      platform: process.platform,
      vaultBackend: vault.backendName(),
      // 有一份读不出来的旧密钥文件时，界面要能说清楚怎么办 ——
      // 光报"连不上"等于把用户堵在门外
      vault: vault.status(),
      // 桌面版才有系统代理这条路（Chromium 网络栈），命令行模式下没有
      systemProxyAvailable: httpClient.systemProxyAvailable(),
      electron: Boolean(process.versions.electron)
    });
  }

  if (a === 'catalog' && method === 'GET') {
    return json(res, 200, {
      providers: providers.catalogForUI(),
      capabilities: providers.CAPABILITIES,
      settings: settings.all(),
      routing: adapters.resolvedRouting(),
      stages: store.STAGES.map((id) => ({
        id,
        label: store.STAGE_LABELS[id],
        hint: store.STAGE_HINTS[id] || ''
      })),
      durationPresets: duration.DURATION_PRESETS,
      // 厂商只接受固定档位（5/10 秒之类）。提前告诉界面，
      // 免得用户设了 4 秒、出来 5 秒，事后才在日志里看到一句解释
      videoDurations: adapters.routedVideoDurations(),
      ffmpeg: ffmpeg.locate()
    });
  }

  // ---- 设置 ----
  if (a === 'settings') {
    if (method === 'GET') return json(res, 200, settings.all());
    if (method === 'POST') return json(res, 200, settings.patch(await readBody(req)));
  }

  // ---- 凭据 ----
  if (a === 'secrets') {
    if (method === 'GET') {
      return json(res, 200, { backend: vault.backendName(), items: vault.listMasked() });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      vault.setMany(body.secrets || {});
      return json(res, 200, { ok: true, items: vault.listMasked() });
    }
    if (method === 'DELETE' && b) {
      vault.setSecret(decodeURIComponent(b), '');
      return json(res, 200, { ok: true, items: vault.listMasked() });
    }
  }

  // ---- 画风预设 ----
  if (a === 'styles') {
    if (method === 'GET' && !b) return json(res, 200, { presets: styles.presetsForUI() });

    // 用**用户自己的模型**出预览图。不打包现成图片是刻意的：
    // 网上找来的是别人的作品，随应用分发出去版权说不清。
    if (b && c === 'preview' && method === 'POST') {
      const style = styles.getStyle(b);
      if (!style) return json(res, 404, { error: `没有这个画风：${b}` });
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const r = adapters.resolvedRouting();
        const { prompt, negative } = styles.previewPrompt(style);
        stream.send({ type: 'note', message: `${style.name}：${r.image.provider} / ${r.image.model}` });
        const image = await adapters.generateImage({
          providerId: r.image.provider,
          model: r.image.model,
          prompt,
          negative,
          label: `画风预览·${style.name}`,
          onEvent: (ev) => stream.send(ev)
        });
        const dest = styles.previewPath(b);
        await studio.saveMedia(image, dest);
        stream.end({ type: 'finished', id: b, path: dest });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }

    if (b && c === 'preview' && method === 'DELETE') {
      fs.rmSync(styles.previewPath(b), { force: true });
      return json(res, 200, { ok: true });
    }
  }

  // ---- 体检 ----
  if (a === 'preflight') {
    if (method === 'GET') return json(res, 200, { checks: preflight.CHECKS });
    if (method === 'POST') {
      const opts = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        await preflight.run(opts, (ev) => stream.send(ev));
        stream.end({ type: 'finished' });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }
  }

  // ---- 服务商 ----
  if (a === 'providers' && b) {
    if (c === 'probe' && method === 'POST') {
      return json(res, 200, await providers.probe(b));
    }
    if (c === 'models' && method === 'GET') {
      return json(res, 200, await preflight.listModels(b));
    }
    // 逐个探测候选模型：请求多、耗时长，用 NDJSON 边探边报
    if (c === 'candidates' && method === 'POST') {
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const result = await preflight.probeCandidates(b, (ev) => stream.send(ev));
        stream.end({ type: 'finished', ...result });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }
    if (c === 'template' && d && method === 'GET') {
      return json(res, 200, providers.draftFromTemplate(b, d));
    }
  }

  // ---- 联调台：发请求（NDJSON 流式回传）----
  if (a === 'debug' && b === 'send' && method === 'POST') {
    const spec = await readBody(req);
    const stream = ndjson(res);
    req.on('close', () => stream.end());
    try {
      const runner = spec.async ? providers.sendAsync : providers.send;
      const result = await runner(spec, (ev) => stream.send(ev));
      stream.end({ type: 'finished', result: spec.async ? summarize(result) : summarize({ submitted: result }) });
    } catch (err) {
      stream.end({ type: 'error', message: err.message, missing: err.missing || null });
    }
    return undefined;
  }

  // ---- 日志 ----
  if (a === 'logs') {
    if (method === 'GET' && b) return json(res, 200, logbus.get(b) || { error: '没有这条记录' });
    if (method === 'GET') {
      return json(res, 200, {
        stats: logbus.stats(),
        items: logbus.list({
          limit: Number(url.searchParams.get('limit')) || 80,
          provider: url.searchParams.get('provider')
        })
      });
    }
    if (method === 'DELETE') {
      logbus.clear();
      return json(res, 200, { ok: true });
    }
  }

  // ---- 项目 ----
  if (a === 'projects') {
    if (method === 'GET' && !b) return json(res, 200, store.list());
    if (method === 'POST' && !b) return json(res, 201, store.create(await readBody(req)));
    // 这三条必须加 !c 限定"路径到此为止"。
    // 否则 DELETE /projects/:id/bible/prop/xxx 会命中这里，把整个项目删掉；
    // GET /projects/:id/chapters 也会返回项目而不是章节。子路由都在下面。
    if (b && !c && method === 'GET') {
      const p = store.read(b);
      return p ? json(res, 200, p) : json(res, 404, { error: '项目不存在' });
    }
    if (b && !c && method === 'PATCH') {
      const patch = await readBody(req);
      return json(
        res,
        200,
        store.update(b, (p) => Object.assign(p, patch, { id: p.id }))
      );
    }
    if (b && !c && method === 'DELETE') return json(res, 200, { ok: store.remove(b) });

    // ── 单镜重出：图或视频，可临时换服务商/模型 ──
    if (b && c === 'shots' && d && e === 'regenerate' && method === 'POST') {
      const opts = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const run = opts.kind === 'video' ? studio.regenerateShotVideo : studio.regenerateShot;
        const project = await run(b, d, opts, (ev) => stream.send(ev));
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }

    // ── 手动补入：中转平台查不到任务时，从平台复制地址贴回来 ──
    if (b && c === 'shots' && d && e === 'attach' && method === 'POST') {
      const body = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const project = await studio.attachShotMedia(b, d, body, (ev) => stream.send(ev));
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }

    // ── 设定集条目：重出 / 新增 / 删除 ──
    if (b && c === 'bible' && d) {
      const kind = d; // char | scene | prop
      if (e && f === 'regenerate' && method === 'POST') {
        const opts = await readBody(req);
        const stream = ndjson(res);
        req.on('close', () => stream.end());
        try {
          const project = await studio.regenerateSheet(b, kind, decodeURIComponent(e), opts, (ev) => stream.send(ev));
          stream.end({ type: 'finished', project });
        } catch (err) {
          stream.end({ type: 'error', message: err.message });
        }
        return undefined;
      }
      if (!e && method === 'POST') {
        return json(res, 201, await studio.addBibleEntry(b, kind, await readBody(req)));
      }
      if (e && method === 'DELETE') {
        return json(res, 200, studio.removeBibleEntry(b, kind, decodeURIComponent(e)));
      }
    }

    // ── 时长 ──
    if (b && c === 'duration') {
      const p = store.read(b);
      if (!p) return json(res, 404, { error: '项目不存在' });
      const policy = settings.get('durationPolicy') || 'trim';
      if (method === 'GET') {
        return json(res, 200, {
          summary: duration.summarize(p, { policy }),
          policy,
          presets: duration.DURATION_PRESETS,
          suggestedShots: duration.planShotCount(p.targetDuration)
        });
      }
      // 按目标时长重新分配每镜时长：保留原有的节奏比例，只做整体缩放
      if (d === 'rescale' && method === 'POST') {
        const { targetDuration } = await readBody(req);
        const updated = store.update(b, (proj) => {
          if (targetDuration) proj.targetDuration = Number(targetDuration);
          proj.shots = duration.rescale(proj.shots, proj.targetDuration);
          return proj;
        });
        return json(res, 200, { project: updated, summary: duration.summarize(updated, { policy }) });
      }
    }

    // ── 章节 ──
    if (b && c === 'chapters') {
      if (method === 'GET') {
        const p = store.read(b);
        if (!p) return json(res, 404, { error: '项目不存在' });
        return json(res, 200, { chapters: p.chapters || [], advice: studio.chapterAdvice(p.script) });
      }
      if (d === 'split' && method === 'POST') {
        const opts = await readBody(req);
        return json(res, 200, studio.splitChapters(b, opts));
      }
      if (method === 'DELETE') return json(res, 200, studio.clearChapters(b));
    }

    // 跑某一阶段，进度流式回传
    if (b && c === 'stage' && d && method === 'POST') {
      const opts = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      const runners = {
        bible: studio.buildBible,
        script: studio.analyzeScript,
        assets: studio.generateAssets,
        video: studio.generateVideos,
        voice: studio.generateVoice,
        compose: studio.compose,
        all: studio.runAll
      };
      const runner = runners[d];
      if (!runner) return stream.end({ type: 'error', message: `未知阶段：${d}` });
      try {
        const project = await runner(b, { ...opts, onEvent: (ev) => stream.send(ev) });
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }
  }

  // ---- FFmpeg ----
  if (a === 'ffmpeg' && method === 'GET') return json(res, 200, ffmpeg.status());

  return json(res, 404, { error: `未知接口 ${url.pathname}` });
}

function summarize(r) {
  const s = r.submitted || r;
  return {
    logId: s.logId,
    status: s.status,
    ok: s.ok,
    totalMs: s.totalMs,
    ttfbMs: s.ttfbMs,
    task: r.task || null,
    polledStatus: r.polled?.status ?? null
  };
}

export function createServer() {
  ensureDirs();
  // 上次删项目时被 Windows 文件占用打断的残骸，开机顺手扫掉
  store.sweepOrphans();
  return http.createServer(async (req, res) => {
    const denied = guard(req);
    if (denied) return json(res, 403, { error: denied });

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname === '/media') return serveMedia(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const out = await handleApi(req, res, url);
        if (out === undefined && !res.headersSent) {
          return json(res, 405, { error: `${req.method} 不支持` });
        }
        return undefined;
      }
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!res.headersSent) return json(res, 500, { error: err.message });
      try {
        res.end();
      } catch {
        /* 已经断了 */
      }
      return undefined;
    }
  });
}

/** 端口被占就顺延，最多试 20 个 —— 5178 撞车在开发机上太常见了 */
export function listen(preferredPort, attempts = 20) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let port = preferredPort || settings.get('port') || 5178;
    let tried = 0;
    const tryListen = () => {
      server.listen(port, '127.0.0.1');
    };
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tried < attempts) {
        tried += 1;
        port += 1;
        tryListen();
      } else {
        reject(err);
      }
    });
    server.on('listening', () => resolve({ server, port, url: `http://127.0.0.1:${port}` }));
    tryListen();
  });
}

// 直接 `node core/server.js` 启动（不走 Electron）
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  listen()
    .then(async ({ url, port }) => {
      console.log(`\n  未来创梦 已启动`);
      console.log(`  界面：    ${url}`);
      console.log(`  数据目录： ${DATA_DIR}`);
      if (port !== (settings.get('port') || 5178)) {
        console.log(`  （默认端口被占用，已顺延到 ${port}）`);
      }
      console.log(`\n  按 Ctrl+C 停止。\n`);

      // 自己开浏览器，用的是真实绑定到的端口 —— 启动脚本里写死端口会在端口顺延时打开空白页
      if (process.env.FUTUREDREAM_NO_OPEN !== '1') {
        const { spawn } = await import('node:child_process');
        const cmd =
          process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin'
              ? ['open', [url]]
              : ['xdg-open', [url]];
        try {
          spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } catch {
          /* 打不开就算了，地址已经在上面打印出来了 */
        }
      }
    })
    .catch((err) => {
      console.error('启动失败：', err.message);
      process.exit(1);
    });
}
