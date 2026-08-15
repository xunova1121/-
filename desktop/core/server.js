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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
import * as continuity from './pipeline/continuity.js';
import * as preflight from './preflight.js';
import * as styles from './styles.js';
import * as duration from './duration.js';
import * as skillsLib from './skills.js';

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

/**
 * 这个地址算不算"局域网里的自己人"。
 *
 * 只认私网 IP 字面量，不认域名 —— 这一条是防 DNS rebinding 的：
 * 攻击者可以让 evil.com 解析到 192.168.1.7，浏览器就会带着 Host: evil.com
 * 往你手机所在的这台机器发请求。只要求 Host 必须是私网 IP 本身，这条路就断了。
 */
function isPrivateHost(host) {
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  const m = host.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // IPv6 链路本地 / 唯一本地地址
  return /^(fe80|fc|fd)/i.test(host);
}

/**
 * 谁能调这个服务。
 *
 * 本机那条监听（127.0.0.1）维持原样：能打开这个端口的人本来就坐在这台机器前。
 * 手机那条监听是**另开的一个端口**，规矩严得多 ——
 * 它后面是你的 API 密钥和额度，同一个 Wi-Fi 下的人不该随手就能驱动它。
 */
function guard(req, { lan = false } = {}) {
  const hostHeader = req.headers.host || '';
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

  if (!lan && !loopback) return '仅允许通过 127.0.0.1 访问';
  if (lan && !loopback && !isPrivateHost(host)) {
    return `手机端只接受局域网地址，这个 Host 不是：${host}`;
  }

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    const sameOrigin = origin === `http://${hostHeader}` || origin === `https://${hostHeader}`;
    if (!sameOrigin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return `拒绝跨站请求：${origin}`;
    }
  }
  return null;
}

/**
 * 配对码校验（只在手机那条监听上做）。
 *
 * 两个细节值得写下来：
 *   ① 也认查询串里的 k。<img src> / <video src> 没法带自定义头，
 *      而手机端最主要的用途就是看图看片，不认它等于这个功能白做。
 *   ② 错太多次就锁一阵子。配对码只有 8 位，局域网里慢慢试是能试出来的；
 *      锁 10 分钟之后，暴力枚举的期望时间就变得不现实了。
 */
const KEY_ATTEMPTS = { bad: 0, until: 0 };
const KEY_MAX_BAD = 10;
const KEY_LOCK_MS = 10 * 60 * 1000;

export function resetKeyLockout() {
  KEY_ATTEMPTS.bad = 0;
  KEY_ATTEMPTS.until = 0;
}

function checkKey(req, url) {
  const expected = settings.get('lanToken') || '';
  if (!expected) return '手机端还没生成配对码，去电脑上的「设置 → 手机遥控」打开一次';

  if (KEY_ATTEMPTS.until > Date.now()) {
    const mins = Math.ceil((KEY_ATTEMPTS.until - Date.now()) / 60000);
    return `配对码错误次数过多，${mins} 分钟后再试`;
  }

  const given = req.headers['x-fd-key'] || url.searchParams.get('k') || '';
  // 长度不同直接判错，不进 timingSafeEqual（它要求等长）
  let ok = given.length === expected.length;
  if (ok) {
    ok = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
  if (!ok) {
    KEY_ATTEMPTS.bad += 1;
    if (KEY_ATTEMPTS.bad >= KEY_MAX_BAD) {
      KEY_ATTEMPTS.until = Date.now() + KEY_LOCK_MS;
      KEY_ATTEMPTS.bad = 0;
    }
    return '配对码不对';
  }
  KEY_ATTEMPTS.bad = 0;
  return null;
}

/** 本机的局域网地址，用来在设置页里告诉用户"手机上该输什么" */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.internal) continue;
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      if (!isPrivateHost(ni.address)) continue;
      out.push({ name, address: ni.address });
    }
  }
  return out;
}

/** 配对码用去掉易混字符的字母表：手机上是要一个一个敲进去的 */
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newToken(len = 8) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join('');
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

async function handleApi(req, res, url, { lan = false } = {}) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c, d, e, f, g] = seg;
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
      // 镜与镜的衔接关系。界面要按它给下拉，也要按它解释"这两镜到底接不接得上"
      links: continuity.LINKS.map((id) => ({
        id,
        label: continuity.LINK_LABELS[id],
        hint: continuity.LINK_HINTS[id]
      })),
      // 厂商只接受固定档位（5/10 秒之类）。提前告诉界面，
      // 免得用户设了 4 秒、出来 5 秒，事后才在日志里看到一句解释
      videoDurations: adapters.routedVideoDurations(),
      ffmpeg: ffmpeg.locate()
    });
  }

  // ---- 技法库（镜头运用 / 光线 / 动作 / 氛围）----
  if (a === 'skills') {
    if (method === 'GET') return json(res, 200, { groups: skillsLib.catalogForUI() });
    if (method === 'POST' && !b) {
      try {
        return json(res, 201, { skill: skillsLib.addUserSkill(await readBody(req)), groups: skillsLib.catalogForUI() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (method === 'DELETE' && b) {
      const ok = skillsLib.removeUserSkill(decodeURIComponent(b));
      return json(res, ok ? 200 : 404, ok ? { ok, groups: skillsLib.catalogForUI() } : { error: '没有这张自定义技法卡' });
    }
  }

  // ---- 手机遥控 ----
  if (a === 'lan') {
    if (method === 'GET') return json(res, 200, lanStatus());
    if (method === 'POST') {
      // 开关和配对码只能在电脑上改。手机自己能换配对码的话，
      // 拿到过一次码的人就能永久续期 —— 撤销权必须留在这台机器上。
      if (lan) return json(res, 403, { error: '手机端不能改遥控设置，去电脑上的「设置 → 手机遥控」' });
      const body = await readBody(req);
      // 换配对码：手机丢了、或者给同事看过一次之后，得能一键作废
      if (body.rotate) {
        settings.patch({ lanToken: newToken() });
        resetKeyLockout();
        return json(res, 200, { ...lanStatus(), token: settings.get('lanToken') });
      }
      if (body.enabled === false) {
        settings.patch({ lanAccess: false });
        return json(res, 200, stopLan());
      }
      settings.patch({ lanAccess: true });
      const status = await startLan();
      // 配对码只在电脑这一侧回传：手机那一侧要是能查到它，配对码就等于没有
      return json(res, 200, { ...status, token: settings.get('lanToken') });
    }
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
    // ⚠ 必须写 `!d`：否则 /styles/:id/preview/upload 会被这一条先接住，
    // 于是"用本地图片"变成了"用模型再出一张"—— 花钱不说，回的还是 NDJSON 流
    if (b && c === 'preview' && !d && method === 'POST') {
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

    // 用本地图片当示例图。手上正好有一张想要的参照时，这比"再出一张"快得多
    if (b && c === 'preview' && d === 'upload' && method === 'POST') {
      try {
        const body = await readBody(req, 16 * 1024 * 1024);
        return json(res, 200, styles.attachPreview(b, body));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
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
  // 打开应用时自动跑这一条：只发各家最便宜的探针，不出图不出视频。
  // 配置坏了的代价不是"自检红一下"，而是你跑到第 04 步等两分钟才被告知密钥没配。
  if (a === 'routing' && b === 'check' && method === 'POST') {
    return json(res, 200, await providers.probeRouting());
  }

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

    // ── 手改一镜的文案：自动拆的分镜有时不准，改一行字比重跑十次便宜 ──
    // 只认白名单字段（见 pipeline/studio.js），不会碰 imagePath / videoPath 这些产物。
    if (b && c === 'shots' && d && !e && method === 'PATCH') {
      const patch = await readBody(req);
      try {
        const { project, changed } = studio.updateShot(b, d, patch);
        return json(res, 200, { project, changed });
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }

    // ── 让模型按画面描述给每一镜挑技法 ──
    // 手选的问题不在麻烦，在于你未必记得住那些术语 —— 四十七张卡里永远只用那三张。
    if (b && c === 'skills' && d === 'suggest' && method === 'POST') {
      const opts = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const { project } = await studio.suggestSkills(b, { ...opts, onEvent: (ev) => stream.send(ev) });
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }

    // ── 把台词绑到说话人身上 ──
    // 先按台词署名和描述提示确定性地定（不花钱、比模型准），
    // 只有"在场不止一个人又没线索"的那几条才交给调度模型按上下文判。
    if (b && c === 'speakers' && d === 'bind' && method === 'POST') {
      const opts = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const { project } = await studio.autoBindSpeakers(b, { ...opts, onEvent: (ev) => stream.send(ev) });
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }

    // ── 单独取一镜 ──
    // 出图/出视频跑完之后，界面只需要把**那一张卡片**换掉。
    // 为此重新拉一遍整个项目（几十镜、连提示词带复核记录）既慢又会把
    // 正在编辑的输入框冲掉 —— 那才是"生成一下，我改的字没了"的根源。
    if (b && c === 'shots' && d && !e && method === 'GET') {
      const project = store.read(b);
      const shot = (project?.shots || []).find((s) => s.id === d);
      if (!shot) return json(res, 404, { error: '没有这一镜' });
      return json(res, 200, { shot, updatedAt: project.updatedAt });
    }

    // ── 这一镜现在会发出去的提示词 ──
    // 界面上原来只看得到"上一次发出去的那条"，改完描述再看还是旧的，
    // 于是很容易以为"改了描述提示词不跟着变"。这条给的是**现算的**。
    if (b && c === 'shots' && d && e === 'prompts' && method === 'GET') {
      try {
        return json(res, 200, studio.promptsFor(b, d));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }

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

    // ── 待认领的任务：查一次，不重新生成，所以不花钱 ──
    if (b && c === 'tasks' && d === 'recheck' && method === 'POST') {
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const project = await studio.recheckPendingTasks(b, { onEvent: (ev) => stream.send(ev) });
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }
    if (b && c === 'tasks' && method === 'GET') {
      return json(res, 200, { pending: studio.listPendingTasks(b) });
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
      // 用本地图片当设定图。有些参照模型画不出来 —— 真人演员的照片、
      // 客户给的产品图、已经定稿的三视图，你要的就是那一张，不是"像那一张"。
      if (e && f === 'upload' && method === 'POST') {
        // 图片走 base64 内联，比模型出图那条路的请求体大得多，限额得单独放宽
        const body = await readBody(req, 16 * 1024 * 1024);
        const stream = ndjson(res);
        req.on('close', () => stream.end());
        try {
          const project = await studio.attachBibleSheet(b, kind, decodeURIComponent(e), body, (ev) => stream.send(ev));
          stream.end({ type: 'finished', project });
        } catch (err) {
          stream.end({ type: 'error', message: err.message });
        }
        return undefined;
      }
      // ── 变体：另一套衣服 / 另一个时段 ──
      if (e && f === 'variants' && method === 'POST') {
        try {
          return json(res, 201, studio.addVariant(b, kind, decodeURIComponent(e), await readBody(req)));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (e && f === 'variants' && g && method === 'PATCH') {
        try {
          return json(res, 200, studio.updateVariant(b, kind, decodeURIComponent(e), g, await readBody(req)));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (e && f === 'variants' && g && method === 'DELETE') {
        try {
          return json(res, 200, studio.removeVariant(b, kind, decodeURIComponent(e), g));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (!e && method === 'POST') {
        return json(res, 201, await studio.addBibleEntry(b, kind, await readBody(req)));
      }
      // 只改文字，不出图 —— 免费、立刻生效。
      // 之前唯一的保存路径是「改完重出」，等于"想改一句描述就得重烧一张图"。
      if (e && !f && method === 'PATCH') {
        try {
          const r = studio.updateBibleEntry(b, kind, decodeURIComponent(e), await readBody(req));
          return json(res, 200, r);
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (e && method === 'DELETE') {
        return json(res, 200, studio.removeBibleEntry(b, kind, decodeURIComponent(e)));
      }
    }

    // ── 设定图齐了没 ──
    // 界面在跑「分镜」之前就该知道还差几张，而不是点下去才被拦
    if (b && c === 'bible-readiness' && method === 'GET') {
      const p = store.read(b);
      if (!p) return json(res, 404, { error: '项目不存在' });
      return json(res, 200, studio.bibleReadiness(p));
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
      // 让模型按情节切。长篇要滑窗问好几轮，所以走流式，进度看得见
      if (d === 'smart-split' && method === 'POST') {
        const opts = await readBody(req);
        const stream = ndjson(res);
        req.on('close', () => stream.end());
        try {
          const project = await studio.smartSplitChapters(b, { ...opts, onEvent: (ev) => stream.send(ev) });
          stream.end({ type: 'finished', project });
        } catch (err) {
          stream.end({ type: 'error', message: err.message });
        }
        return undefined;
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

export function createServer({ lan = false } = {}) {
  ensureDirs();
  // 上次删项目时被 Windows 文件占用打断的残骸，开机顺手扫掉
  store.sweepOrphans();
  return http.createServer(async (req, res) => {
    const denied = guard(req, { lan });
    if (denied) return json(res, 403, { error: denied });

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    /**
     * 手机那条监听上，**除了手机端页面本身**，一切都要配对码。
     *
     * 页面文件放行是必须的：不放行就没法显示"请输入配对码"那一屏，
     * 用户只会看到一个 401，不知道该干什么。页面里没有任何数据，
     * 数据全在 /api 和 /media 后面 —— 那两条一步都不让。
     */
    if (lan) {
      const isShell = url.pathname === '/m' || url.pathname.startsWith('/m/');
      if (!isShell) {
        const bad = checkKey(req, url);
        if (bad) return json(res, 401, { error: bad });
      }
    }

    try {
      // 手机端是独立的一套页面，不是把电脑版缩小 —— 见 ui/m/README 里的取舍
      if (url.pathname === '/m' || url.pathname === '/m/') return serveStatic(req, res, '/m/index.html');
      if (url.pathname === '/media') return serveMedia(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const out = await handleApi(req, res, url, { lan });
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

/**
 * 手机遥控那条监听。
 *
 * 为什么是**另开一个端口**而不是把主监听改成 0.0.0.0：
 *   ① 开关要能随时开关，不该为了让手机连一次就重启整个应用；
 *   ② 两条口子的规矩不一样（本机免密、局域网必须配对码），
 *      分成两个 server 实例，规矩就是各自写死的，不会因为一处判断写漏而串门；
 *   ③ 关掉时是真的把端口关了，而不是留着一个"应该会拒绝"的监听。
 */
let lanServer = null;
let lanPort = 0;

export function lanStatus() {
  return {
    running: Boolean(lanServer),
    port: lanPort,
    hasToken: Boolean(settings.get('lanToken')),
    addresses: lanAddresses(),
    urls: lanServer ? lanAddresses().map((a) => `http://${a.address}:${lanPort}/m`) : []
  };
}

export function startLan(port) {
  if (lanServer) return lanStatus();
  // 没有配对码就不开 —— 不带锁的门比没有门更糟，因为你会以为它锁着
  if (!settings.get('lanToken')) settings.patch({ lanToken: newToken() });
  return new Promise((resolve, reject) => {
    const srv = createServer({ lan: true });
    let p = port || (settings.get('port') || 5178) + 1;
    let tried = 0;
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tried < 20) {
        tried += 1;
        p += 1;
        srv.listen(p, '0.0.0.0');
      } else {
        reject(err);
      }
    });
    srv.on('listening', () => {
      lanServer = srv;
      lanPort = p;
      resolve(lanStatus());
    });
    srv.listen(p, '0.0.0.0');
  });
}

export function stopLan() {
  if (!lanServer) return lanStatus();
  lanServer.close();
  lanServer = null;
  lanPort = 0;
  resetKeyLockout();
  return lanStatus();
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
