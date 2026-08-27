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

import { UI_DIR, DATA_DIR, ensureDirs, safeFileName } from './paths.js';
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
import * as anglesLib from './pipeline/angles.js';
import * as speakerLib from './pipeline/speaker.js';
import * as preflight from './preflight.js';
import * as styles from './styles.js';
import * as duration from './duration.js';
import * as skillsLib from './skills.js';
import * as zip from './zip.js';
import * as deploy from './deploy.js';
import * as oss from './oss.js';
import * as accounts from './accounts.js';
import * as tiers from './tiers.js';
import * as version from './version.js';
import * as jobs from './jobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
/**
 * 心跳间隔。**每次取值**而不是模块加载时定死 ——
 * 定死的话自检根本改不动它：ESM 的静态 import 在任何代码之前就跑完了，
 * 等测试去设环境变量时，这个常量早就是 15000 了。
 * 做成可配的唯一理由就是能测，那它就必须在测试够得着的时候才取。
 */
function pingMs() {
  return Number(process.env.FUTUREDREAM_PING_MS) || 15000;
}

function ndjson(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });
  let closed = false;

  /**
   * 心跳。**这条流经常一分多钟一个字节都不写。**
   *
   * ── 为什么必须有 ──
   *
   * 出一张图要等厂商三十秒到两分钟，这期间流上完全是静默的。
   * 而一条静默的连接会被沿途任何一环掐掉：手机基站的 NAT 表、
   * 运营商的空闲超时、反向代理、浏览器自己在息屏时收紧的策略。
   *
   * 掐掉之后浏览器那边 fetch 直接 reject，报的是一句
   * **`network error`** —— 它不区分"服务器挂了""网断了""连接闲太久被回收了"，
   * 而这三件事该做的处理完全不同。用户看到的就是一句什么也没说的报错，
   * 更糟的是：**任务在服务器上还好好跑着**，图其实出来了。
   *
   * 每 15 秒写一行 ping 就能把整条链路上的空闲计时器全部重置。
   * 代价是每分钟四行 JSON，可以忽略。
   *
   * ping 这一行客户端不用特别处理：各端都是 `JSON.parse` 一行、按 type 分派，
   * 不认识的 type 天然被忽略。
   */
  const beat = setInterval(() => {
    if (closed) return;
    try {
      res.write('{"type":"ping"}\n');
    } catch {
      // 对端已经走了。这里不该抛 —— 心跳失败不是业务失败
    }
  }, pingMs());
  // 别让一个定时器把进程吊着不退（打包成 exe 之后这会表现为"关不掉"）
  beat.unref?.();
  const stop = () => clearInterval(beat);
  res.on('close', stop);

  return {
    send(event) {
      if (closed) return;
      res.write(`${JSON.stringify(event)}\n`);
    },
    end(event) {
      if (closed) return;
      if (event) res.write(`${JSON.stringify(event)}\n`);
      closed = true;
      stop();
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

  /**
   * 服务器模式：Host 必须**正好是**你配的那个域名。
   *
   * 为什么这么严：这台机器在公网上，任何解析到它 IP 的域名都会把请求送进来。
   * 只认一个域名，等于把"别人拿自己的域名指过来"这条路堵死；
   * 而反向代理（Caddy）转发时会原样带上你的域名，所以正常访问不受影响。
   * 代理自己那一跳走 127.0.0.1，也放行。
   */
  if (deploy.SERVER_MODE) {
    const ok = loopback || (deploy.PUBLIC_HOST && host === deploy.PUBLIC_HOST);
    if (!ok) return `这台服务器只认 ${deploy.PUBLIC_HOST || '（还没配域名）'}，这个 Host 不是：${host}`;
    return originGuard(req, hostHeader);
  }

  if (!lan && !loopback) return '仅允许通过 127.0.0.1 访问';
  if (lan && !loopback && !isPrivateHost(host)) {
    return `手机端只接受局域网地址，这个 Host 不是：${host}`;
  }

  return originGuard(req, hostHeader);
}

/**
 * 是不是手机在敲门。
 *
 * 只用来决定"根地址跳不跳到 /m"，**不做任何安全判断** —— UA 是客户端随便写的，
 * 拿它当门禁是错的。这里最坏的后果只是跳错页面，而地址栏里加个 `?pc=1` 就能纠正。
 *
 * 排除 iPad：它屏幕够大，电脑版那套用着更顺手；而新版 iPadOS 的 Safari
 * UA 里本来就写着 Macintosh，本来也认不出来。
 */
function isPhone(req) {
  const ua = req.headers['user-agent'] || '';
  if (/iPad|Tablet/i.test(ua)) return false;
  return /Android.*Mobile|iPhone|iPod|Windows Phone|Mobile Safari/i.test(ua);
}

/** 跨站防护：别人的网页不能拿你的浏览器往这个服务发请求 */
function originGuard(req, hostHeader) {
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
  // 服务器模式用的是**长口令**（32 位），不是局域网那个 8 位配对码 ——
  // 公网上 8 位配不上，40 bit 慢慢试是试得出来的
  const expected = deploy.SERVER_MODE ? deploy.accessToken() : settings.get('lanToken') || '';
  if (!expected) return '手机端还没生成配对码，去电脑上的「设置 → 手机遥控」打开一次';

  if (KEY_ATTEMPTS.until > Date.now()) {
    const mins = Math.ceil((KEY_ATTEMPTS.until - Date.now()) / 60000);
    return `配对码错误次数过多，${mins} 分钟后再试`;
  }

  const raw = req.headers['x-fd-key'] || url.searchParams.get('k') || '';
  /**
   * 局域网那个 8 位配对码**不区分大小写**，服务器那个 32 位口令区分。
   *
   * 配对码的字母表本来就只有大写（见 TOKEN_ALPHABET）—— 它是给人在手机上
   * 一个一个敲进去的，为大小写卡住用户毫无意义。而服务器口令是复制粘贴的，
   * 大小写混排正是它熵的一部分，抹平等于白扔掉将近一半强度。
   *
   * 之前手机端为了配对码好敲，在**客户端**把输入无脑转成大写 —— 于是服务器上
   * 那个混排口令一输进去就被毁掉，手机端根本登不进去。规矩应该定在这里，
   * 而不是让每个客户端各自猜。
   */
  /**
   * **没带口令**和**口令猜错了**是两件事，不能算同一笔。
   *
   * 打开页面时那一批请求本来就没有口令（还没登录呢），一次页面加载能发好几条 ——
   * 都记成"猜错"的话，人还没开始输就已经用掉一半配额，十次一到直接锁十分钟，
   * 而他什么都没做错。真正要防的是**拿着不同的码一个个试**，那一定是带了码的。
   */
  if (!raw) return '要配对码';

  /**
   * 会话凭证。**放在口令前面试**：建了账号之后，日常进来的都是它。
   *
   * 老那串口令继续有效 —— 已经部署好的服务不该因为升级一次就进不去，
   * 而且第一次建账号时要靠它证明"你是这台服务器的主人"。
   */
  if (accounts.whoIs(raw)) return null;

  const given = deploy.SERVER_MODE ? raw : raw.toUpperCase();
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
      // 跑的是哪一版。服务器上更新完拿这个确认，比"去点个新功能试试"可靠得多
      ...version.info(),
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
      // 台词的四种类型。界面要按它给下拉，也要按它解释"心里话和旁白差在哪"
      lineKinds: speakerLib.LINE_KINDS,
      // 设定图有哪些角度可补。界面不能直接 import core/ 里的模块
      // （那些文件不发给浏览器），所以角度表和衔接关系一样，从这里下发
      sheetAngles: {
        char: anglesLib.extraAngles('char'),
        scene: anglesLib.extraAngles('scene'),
        prop: anglesLib.extraAngles('prop')
      },
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

  /**
   * ---- 账号 ----
   *
   * 这一组的路由规矩和别处不同，值得说清楚：
   *
   *   /account/login   **不能**要凭证 —— 它就是用来换凭证的
   *   /account/setup   第一次建管理员，要拿那串访问口令证明"你是这台机器的主人"。
   *                    没有这一条的话，一个刚上线还没建账号的服务，
   *                    任何人都能抢先建一个管理员，然后你就进不去自己的服务器了
   *   其余              照常要凭证（上面统一的 checkKey 已经拦过了）
   */
  if (a === 'account') {
    if (b === 'login' && method === 'POST') {
      const body = await readBody(req);
      const out = accounts.login(body.user, body.password, { device: req.headers['user-agent'] || '' });
      if (!out) {
        // 不说"用户名不存在"还是"密码错了"—— 那等于帮人把用户名一个个试出来
        return json(res, 401, { error: '用户名或密码不对' });
      }
      return json(res, 200, out);
    }

    if (b === 'setup' && method === 'POST') {
      if (accounts.hasAccounts()) return json(res, 409, { error: '已经建过账号了，直接登录' });
      const body = await readBody(req);
      const proof = String(body.accessToken || req.headers['x-fd-key'] || '');
      const expected = deploy.SERVER_MODE ? deploy.accessToken() : settings.get('lanToken') || '';
      // 本机模式下没有口令这一说，坐在这台机器前就是证明
      const needProof = deploy.SERVER_MODE || Boolean(settings.get('lanToken'));
      if (needProof && (!proof || proof !== expected)) {
        return json(res, 403, { error: '要先证明你是这台服务器的主人：把启动日志里那串访问口令填进来' });
      }
      try {
        const created = accounts.createUser(body.user, body.password, { admin: true });
        const session = accounts.login(body.user, body.password, { device: req.headers['user-agent'] || '' });
        return json(res, 200, { ...created, ...session });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // 下面这些都要先登录。谁在问 —— 从凭证反查，不听客户端自报
    const me = accounts.whoIs(req.headers['x-fd-key'] || url.searchParams.get('k') || '');

    if (b === 'me' && method === 'GET') {
      return json(res, 200, me ? { ...me, users: accounts.listUsers() } : { user: null });
    }

    if (!me) return json(res, 401, { error: '先登录' });

    if (b === 'password' && method === 'POST') {
      const body = await readBody(req);
      try {
        accounts.changePassword(me.user, body.oldPassword, body.newPassword);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (b === 'sessions' && method === 'GET') {
      return json(res, 200, { sessions: accounts.sessionsOf(me.user), current: me.sessionId });
    }
    if (b === 'sessions' && c && method === 'DELETE') {
      return json(res, 200, { ok: accounts.revoke(me.user, c) });
    }
    // 手机丢了、密码泄了：一次全踢，包括当前这台 ——
    // "除了我" 会让人以为安全了，而那台"我"可能正是被别人拿着的那台
    if (b === 'sessions' && method === 'DELETE') {
      return json(res, 200, { revoked: accounts.revokeAll(me.user) });
    }
    if (b === 'users' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, accounts.createUser(body.user, body.password));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
  }

  // ---- 镜头分级：这部片子按档位分下来是什么样 ----
  // 先给这个，人才判断得出"值不值得配"——低档只有一镜的话，配这一层就是白折腾
  if (a === 'tiers') {
    return json(res, 200, {
      tiers: tiers.TIERS.map((id) => ({ id, label: tiers.TIER_LABELS[id], hint: tiers.TIER_HINTS[id] })),
      config: settings.get('videoTiers') || {}
    });
  }

  // ---- 对象存储（阿里云 OSS）----
  if (a === 'oss') {
    if (method === 'GET' && !b) {
      const c = oss.config();
      const k = oss.credentials();
      return json(res, 200, {
        ...c,
        regions: oss.REGIONS,
        host: c.bucket ? oss.host(c) : '',
        /**
         * 绝不回密钥本身。但"配没配"这三个字是不够的 ——
         * 这两个框写着「已配置（留空表示不改）」，于是**存着的那份错值
         * 会一直看不见**：用户以为自己这次填对了，实际上只填了一栏，
         * 另一栏还留着上回粘错的东西，而界面上永远只显示"已配置"。
         *
         * AccessKey ID 给指纹（头四尾四 + 长度）—— 它本来就会出现在
         * 每一个签名请求的 OSSAccessKeyId 参数里，不是秘密。
         * Secret 只给长度：30 位对不对，看这一个数就够了。
         */
        hasKeyId: Boolean(k.accessKeyId),
        hasKeySecret: Boolean(k.accessKeySecret),
        keyIdHint: k.accessKeyId ? oss.fingerprint(k.accessKeyId) : '',
        keySecretLen: k.accessKeySecret ? k.accessKeySecret.length : 0,
        ready: oss.ready()
      });
    }
    /**
     * 真写、真读、真删一次。
     *
     * 只"看看能不能连上"是不够的：真正会卡住人的是**写权限**。一把只读的
     * AccessKey 在任何"测试连接"里都表现正常，直到第一次出图完才报错 ——
     * 那时候钱已经花了。
     */
    if (method === 'POST' && b === 'probe') {
      try {
        return json(res, 200, await oss.probe());
      } catch (err) {
        return json(res, 200, { ok: false, steps: [], error: err.message });
      }
    }
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
      /**
       * 换画风时顺手把设定集里那段风格锚也换掉。
       *
       * 以前换完画风，出图纹丝不动 —— 因为风格锚是跑第 01 步时冻结进设定集的，
       * 改 styleId 碰不到它。当时给的答复是"重跑第 01 步"，但那要重新生成
       * 全部角色和场景，手改过的外貌描述全丢，为了换一句话代价太大。
       *
       * 风格锚本来就直接来自预设，不是模型产出的，所以只换这一段就够了。
       * 只在**明确改了画风**时做 —— 改标题、改比例都不该动设定集。
       */
      const touchesStyle =
        Object.prototype.hasOwnProperty.call(patch, 'styleId') ||
        Object.prototype.hasOwnProperty.call(patch, 'style');
      const next = store.update(b, (p) => {
        Object.assign(p, patch, { id: p.id });
        // patch 里自己带了 bible（设定集页面在存风格锚）就听它的，别打架
        if (touchesStyle && !patch.bible) styles.syncBibleStyle(p);
        return p;
      });
      return json(res, 200, next);
    }

    // 设定集里冻结的画风，和预设对得上吗；对不上就让用户一键换过来
    // 这个项目的镜头按档位分下来是什么样
    if (b && c === 'tiers' && method === 'GET') {
      const p = store.read(b);
      if (!p) return json(res, 404, { error: '项目不存在' });
      return json(res, 200, {
        summary: tiers.summarize(p.shots || []),
        shots: (p.shots || []).map((s) => ({
          index: s.index, tier: tiers.tierOf(s), reason: tiers.reasonFor(s), manual: tiers.TIERS.includes(s.tier)
        }))
      });
    }

    if (b && c === 'style' && !d && method === 'GET') {
      const p = store.read(b);
      if (!p) return json(res, 404, { error: '项目不存在' });
      return json(res, 200, styles.styleDrift(p));
    }
    if (b && c === 'style' && d === 'sync' && method === 'POST') {
      const p = store.read(b);
      if (!p) return json(res, 404, { error: '项目不存在' });
      if (!p.bible) return json(res, 400, { error: '这个项目还没有设定集' });
      const project = store.update(b, (x) => {
        styles.syncBibleStyle(x);
        return x;
      });
      return json(res, 200, { project, style: project.bible.style });
    }
    /**
     * 背景音乐。cap:film-music
     *
     * 走流式（ndjson）和设定图上传同一个理由：一首歌十几 MB，
     * 存盘 + 探时长要几秒，闷着等没有任何反馈是最糟的。
     */
    if (b && c === 'music' && !d && method === 'POST') {
      // base64 会把体积撑大三分之一，限额要按**编码后**算，
      // 否则一首 20MB 的歌会在读请求体这一步被拦掉，而报错完全看不出是为什么
      const body = await readBody(req, 28 * 1024 * 1024);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const project = await studio.attachMusic(b, body, (ev) => stream.send(ev));
        stream.end({ type: 'finished', project });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }
    if (b && c === 'music' && !d && method === 'DELETE') {
      const p = store.read(b);
      if (!p) return json(res, 404, { error: '项目不存在' });
      return json(res, 200, studio.detachMusic(b));
    }

    if (b && !c && method === 'DELETE') return json(res, 200, { ok: store.remove(b) });

    // ── 手改一镜的文案：自动拆的分镜有时不准，改一行字比重跑十次便宜 ──
    // 只认白名单字段（见 pipeline/studio.js），不会碰 imagePath / videoPath 这些产物。
    // 一段镜头一起改衔接关系 —— "这一段是一个连贯动作"是按段发生的想法，不是按镜
    /**
     * 让调度模型通读全片，自动标出哪些是「连续动作」。cap:link-auto
     * 走流式：通读一遍要十几秒，而且每改一镜都要说一句为什么。
     */
    if (b && c === 'shots' && d === 'link' && e === 'auto' && method === 'POST') {
      const opts = await readBody(req);
      const stream = ndjson(res);
      req.on('close', () => stream.end());
      try {
        const out = await studio.suggestLinks(b, { ...opts, onEvent: (ev) => stream.send(ev) });
        stream.end({ type: 'finished', project: out.project, changed: out.changed, refused: out.refused });
      } catch (err) {
        stream.end({ type: 'error', message: err.message });
      }
      return undefined;
    }

    if (b && c === 'shots' && d === 'link' && method === 'POST') {
      const body = await readBody(req);
      try {
        // cap:link-batch
        return json(res, 200, studio.setLinkRange(b, body));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // 这一镜出过几版 / 回到某一版。cap:shot-versions
    if (b && c === 'shots' && d && e === 'versions' && method === 'GET') {
      try {
        return json(res, 200, studio.shotVersions(b, d));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (b && c === 'shots' && d && e === 'versions' && f === 'restore' && method === 'POST') {
      try {
        return json(res, 200, studio.restoreShotVersion(b, d, await readBody(req)));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (b && c === 'shots' && d && !e && method === 'PATCH') {
      const patch = await readBody(req);
      try {
        const { project, changed } = studio.updateShot(b, d, patch);
        return json(res, 200, { project, changed });
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }

    /**
     * 把某一镜的场景骨架（地标 + 光位）存成这个场景的默认布局。cap:scene-layout
     *
     * 同一个场景往往会反复回来（第 3 镜在码头、第 11 镜又回码头）。
     * 逐镜继承只在连着的那几镜里管用，中间隔一场就断了 ——
     * 于是同一个码头被摆了三遍，三遍的灯塔在不同方位。而观众记得住地方。
     */
    if (b && c === 'scene-layout' && method === 'POST') {
      const { scene, stage } = await readBody(req);
      try {
        return json(res, 200, studio.saveSceneLayout(b, scene, stage));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    /**
     * 把一个场景摆到某片场地的某个坐标上。cap:site-map
     *
     * 排位管的是"一个场景内部"，场景布局管的是"同一个场景反复回来"。
     * 这一条管的是两个场景**之间** —— 大殿在山门外的北边三十米。
     * 那件事在两张分开的俯视图上永远读不出来，而它决定了
     * "他往北走出画"的下一场接不接得上。
     *
     * place 传 null 就是从场地图上摘下来。
     */
    if (b && c === 'scene-place' && method === 'POST') {
      const { scene, place } = await readBody(req);
      try {
        return json(res, 200, studio.saveScenePlace(b, scene, place ?? null));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    /**
     * 一片场地自己的远景地标和太阳。cap:site-map
     *
     * 太阳挂在场地上、不挂在场景上，是因为**一个地方只有一个太阳**。
     * 挂在场景上的那份是各摆各的，于是同一座山上三场戏三个方向的光 ——
     * 而这正是检查要抓的东西。
     */
    /**
     * 把场地上定的远景地标和光位，一次套到这片场地的所有场景上。cap:site-map
     *
     * ⚠ 必须排在下面那条 `c === 'site'` **前面**：那条不看 d，
     * 排在后面的话这条永远轮不到，而表现是"点了按钮，接口回 200，
     * 什么也没发生"—— 最难查的一种。
     */
    if (b && c === 'site' && d === 'apply' && method === 'POST') {
      const { site } = await readBody(req);
      try {
        return json(res, 200, studio.applySiteLayout(b, site));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (b && c === 'site' && !d && method === 'POST') {
      const { site, marks, sun } = await readBody(req);
      try {
        return json(res, 200, studio.saveSiteMap(b, site, { marks, sun }));
      } catch (err) {
        return json(res, 400, { error: err.message });
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

    /**
     * 把这部片子的素材打成一个包。
     *
     * 一部二十镜的片子有四十来个文件（成片、每镜片段、字幕、每条配音），
     * 逐个"存到手机"要点四十次 —— 没人会这么干。而这些素材的意义正在于
     * **一起拿走**：进剪映之后按顺序拖进时间线，那就是初剪的起点。
     *
     * 走 GET 而不是 POST：手机上要能直接点一个链接下载，
     * <a download> 发不了 POST，而配对码可以走查询串。
     */
    if (b && c === 'export.zip' && method === 'GET') {
      const project = store.read(b);
      if (!project) return json(res, 404, { error: '项目不存在' });

      const shots = (project.shots || []).slice().sort((x, y) => x.index - y.index);
      const entries = [];
      if (project.outputs?.video) entries.push({ file: project.outputs.video, name: `成片_${safeFileName(project.title)}.mp4` });
      if (project.outputs?.subtitle) entries.push({ file: project.outputs.subtitle, name: '字幕.srt' });
      for (const sh of shots) {
        if (sh.videoPath) entries.push({ file: sh.videoPath, name: `分镜片段/${zip.zipName(sh.index, sh.description, '.mp4')}` });
        else if (sh.imagePath) entries.push({ file: sh.imagePath, name: `分镜图/${zip.zipName(sh.index, sh.description, '.png')}` });
        if (sh.audioPath) entries.push({ file: sh.audioPath, name: `配音/${zip.zipName(sh.index, sh.speaker || '旁白', '.mp3')}` });
      }

      // 一张分镜表：进剪映之后想知道"第 7 个片段是哪一镜、说了什么"，
      // 靠文件名不够，靠脑子记更不行
      const sheet = [
        `${project.title}`,
        `画幅 ${project.aspectRatio || '跟随设置'} · ${shots.length} 镜`,
        '',
        ...shots.map((sh) =>
          [
            `${String(sh.index).padStart(2, '0')}  ${Number(sh.duration).toFixed(1)}s  ${sh.camera || ''}`,
            `    ${sh.description || ''}`,
            sh.dialogue ? `    ${sh.speaker || '旁白'}：${sh.dialogue}` : ''
          ].filter(Boolean).join('\n'))
      ].join('\n');
      const sheetFile = path.join(store.projectDir(b), '分镜表.txt');
      fs.writeFileSync(sheetFile, sheet, 'utf8');
      entries.push({ file: sheetFile, name: '分镜表.txt' });

      // 文件名里的中文要按 RFC 5987 编码，否则 Windows 上下下来是一串乱码
      const fname = `${safeFileName(project.title)}-素材.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="futuredream-assets.zip"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Cache-Control': 'no-store'
      });
      try {
        await zip.writeZip(entries, res);
      } catch (err) {
        // 头已经发出去了，这里只能把连接断掉 —— 至少不会给一个"看着完整其实截断"的包
        logbus.record({ provider: 'local', label: '打包素材', error: err.message });
      }
      res.end();
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
      // 补出正面之外的角度（角色的侧/背，场景的左右/俯视）。cap:sheet-angles
      // 走流式：一次可能出三四张图，闷着等两分钟没有任何反馈是最糟的
      if (e && f === 'angles' && method === 'POST') {
        const opts = await readBody(req);
        const stream = ndjson(res);
        req.on('close', () => stream.end());
        try {
          const project = await studio.generateAngles(b, kind, decodeURIComponent(e), opts, (ev) => stream.send(ev));
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

    // 成片体检：现在能不能发。cap:quality-report
    if (b && c === 'quality' && method === 'GET') {
      try {
        return json(res, 200, studio.qualityReport(b));
      } catch (err) {
        return json(res, 404, { error: err.message });
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

    /**
     * 现在在跑什么。
     *
     * 页面刷新之后要能接着看到"它还在跑"和那个「停下来」按钮 ——
     * 少了这一条，关一次页面就再也停不下来了（流断了，后台循环还在跑）。
     */
    if (b && c === 'job' && method === 'GET') return json(res, 200, jobs.describe(b));

    // 叫停。回的是一句人话，说清接下来会发生什么 —— 见 jobs.js 里的说明
    if (b && c === 'cancel' && method === 'POST') return json(res, 200, jobs.cancel(b));

    // 跑某一阶段，进度流式回传
    if (b && c === 'stage' && d && method === 'POST') {
      const opts = await readBody(req);
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
      if (!runner) return json(res, 400, { error: `未知阶段：${d}` });

      /**
       * 登记这份活儿。要在开流**之前**做：同项目已经在跑时要回一个正经的
       * 409，而不是开一条流再往里塞一条 error —— 前端对这两者的处理不一样。
       */
      let job;
      try {
        job = jobs.start(b, d);
      } catch (err) {
        return json(res, err.code === 'BUSY' ? 409 : 500, { error: err.message });
      }

      /**
       * 开跑前把 shotId → 第几镜 存一份。
       *
       * 一次读盘，换来"流断了之后还能说出跑到第几镜" —— 而这正是
       * 手机上最缺的那句话：切屏回来一刷新，页面是静止的，
       * 人只能判断成卡死了，然后再点一次「往后全跑」，撞上 409。
       */
      const shotIndexOf = new Map(
        (store.read(b)?.shots || []).map((s) => [s.id, s.index])
      );

      /**
       * 跑完之后把**这一次的结果**存进项目里。
       *
       * 不存的话，一关页面就什么都没有了：手机切屏回来看到的是一个静止的
       * 流水线 —— 4/12，没有转圈，没有报错，没有任何痕迹说明刚才跑过一次。
       * 用户读到的是"这个 bug 还在"，而实际上那一次早就跑完了，
       * 只是**跑完的结果没有留下来**。
       *
       * 进度流是给"正在看着"的那个人用的，这一条是给"回来的人"用的。
       * 两者缺一不可，而这一端原来只有前者。
       */
      let failedCount = 0;
      const runStartedAt = new Date().toISOString();
      const recordRun = (outcome, message = '') => {
        try {
          store.update(b, (p) => {
            p.lastRun = {
              stage: d,
              stageLabel: job.stageLabel || d,
              outcome, // done / cancelled / error
              at: new Date().toISOString(),
              startedAt: runStartedAt,
              failed: failedCount,
              message: String(message || '').slice(0, 300)
            };
            return p;
          });
        } catch {
          /* 记账失败不该影响这一趟的结果 */
        }
      };

      const stream = ndjson(res);
      /**
       * ⚠ 关掉页面**不等于**取消。
       *
       * 这里只断流，不动那份活儿 —— 出到一半的片子还在跑，
       * 关掉浏览器就把它们全丢掉（而且钱照花）是更糟的默认行为。
       * 要停就明确点「停下来」。
       */
      req.on('close', () => stream.end());
      try {
        const project = await runner(b, {
          ...opts,
          signal: job.signal,
          onEvent: (ev) => {
            if (ev?.message) job.note = String(ev.message).slice(0, 120);
            /**
             * 顺手把"跑到哪一镜"记进登记表。
             *
             * 流断了这份活儿照样在跑（关页面不等于取消），而断了之后
             * 界面就再也不知道它在干嘛了 —— 手机切屏回来一刷新，
             * 看到的是一个静止的页面，人只能判断成"卡死了"，
             * 然后再点一次「往后全跑」，撞上 409。
             *
             * 登记表本来就在内存里，记两个数就能让 GET /job 回答那个问题。
             */
            if (ev?.type === 'shot' && ev.status === 'running' && ev.shotId) {
              job.shotId = ev.shotId;
              // 从 id 查序号，**不去解析那句话**：文案随时会改，
              // 而正则读文案坏掉的方式是安静地读不出来
              if (shotIndexOf.has(ev.shotId)) job.shotIndex = shotIndexOf.get(ev.shotId);
            }
            if (ev?.type === 'shot' && ev.status === 'failed') failedCount += 1;
            stream.send(ev);
          }
        });
        recordRun('done');
        stream.end({ type: 'finished', project });
      } catch (err) {
        recordRun(jobs.isCancel(err) ? 'cancelled' : 'error', err.message);
        stream.end(
          jobs.isCancel(err)
            ? { type: 'cancelled', message: err.message, project: store.read(b) }
            : { type: 'error', message: err.message }
        );
      } finally {
        jobs.finish(job);
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
    /**
     * 「这台服务要我输的是什么」—— 登录屏之前唯一放行的一条。
     *
     * 手机端那一屏原本写死了局域网的规矩：8 位、全大写、最长 12。放到服务器上
     * 要输的却是 32 位大小写混排的访问口令，于是那一屏**根本输不进去**。
     * 它必须先知道自己面对的是哪一种，而这一问必然发生在拿到口令之前。
     *
     * 只回一个模式名，不带任何数据 —— 而且登录屏上写着"这台服务器在公网上，
     * 要口令才能进"，模式本来就不是秘密。
     */
    if (url.pathname === '/api/mode') {
      return json(res, 200, {
        mode: deploy.SERVER_MODE ? 'server' : lan ? 'lan' : 'desktop',
        // 建了账号就该问用户名密码，没建就还是问那串口令。
        // 登录屏必须先知道该问什么 —— 而这一问必然发生在拿到凭证之前
        auth: accounts.hasAccounts() ? 'account' : 'token'
      });
    }

    /**
     * 登录和首次建账号这两条**必须在鉴权之前放行** —— 它们就是用来换凭证的，
     * 要凭证才能进就成了死结。它们自己各有各的门槛：
     * 登录要用户名密码，建账号要那串访问口令。
     */
    const isAuthDoor = url.pathname === '/api/account/login' || url.pathname === '/api/account/setup';

    if (lan) {
      /**
       * 手机版那张网页会 import 两个**根路径上的模块**（预演台画布 + 它的几何）。
       *
       * 它们和 /m/m.js 是同一类东西：程序代码，里面没有任何用户数据。
       * 不放行的话它们 401，而 `import` 失败会让**整个 m.js 加载不起来** ——
       * 表现是手机上打开一片空白，连"请输入配对码"那一屏都没有。
       * 这比少一个功能糟糕得多，而且完全看不出是鉴权造成的。
       *
       * 放行的是这两个确切的路径，不是"所有 .js"—— 后者会把电脑版
       * 整套界面代码一起放出去，那不是同一件事。
       */
      const SHARED_MODULES = ['/previz-canvas.js', '/site-canvas.js', '/previz.js', '/site.js', '/duration.js', '/transitions.js', '/fx.js', '/edit.js', '/seam.js'];
      const isShell =
        url.pathname === '/m'
        || url.pathname.startsWith('/m/')
        || SHARED_MODULES.includes(url.pathname);
      if (!isShell && !isAuthDoor) {
        const bad = checkKey(req, url);
        if (bad) return json(res, 401, { error: bad });
      }
    }

    /**
     * 服务器模式：除了页面壳子本身，**每一条**都要口令。
     *
     * 放行壳子是必须的 —— 不放行就没法显示"请输入访问口令"那一屏，
     * 打开只看到一个 401，没人知道该干什么。壳子里没有任何数据，
     * 数据全在 /api 和 /media 后面。
     *
     * /api/auth 也放行：登录页要有个地方能问"这个口令对不对"，
     * 而它只回 ok / 不 ok，不带任何内容。
     */
    if (deploy.SERVER_MODE) {
      const isShell =
        !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/media');
      const isAuthProbe = url.pathname === '/api/auth';
      if (!isShell && !isAuthProbe && !isAuthDoor) {
        const bad = checkKey(req, url);
        if (bad) return json(res, 401, { error: bad });
      }
      if (isAuthProbe) {
        const bad = checkKey(req, url);
        return json(res, bad ? 401 : 200, bad ? { error: bad } : { ok: true, mode: 'server' });
      }
    }

    try {
      /**
       * 手机打开根地址，直接送到手机端那套页面去。
       *
       * 服务器模式下电脑和手机是**同一个地址**，没法像局域网那样在电脑上
       * 显示一个 `.../m` 的二维码。不做这一跳，手机用户看到的是被压扁的
       * 电脑版工作台 —— 能用，但很难用，而且没人会想到该在地址后面补个 /m。
       *
       * 认 UA 是有名的不可靠，所以只用它做"跳转"这一件事，
       * 并留一条后路：`?pc=1` 强制看电脑版（平板上偶尔想要大屏那套）。
       */
      if (url.pathname === '/' && !url.searchParams.has('pc') && isPhone(req)) {
        res.writeHead(302, { Location: `/m${url.search}` });
        return res.end();
      }
      // 手机端是独立的一套页面，不是把电脑版缩小 —— 见 ui/m/README 里的取舍
      if (url.pathname === '/m' || url.pathname === '/m/') return serveStatic(req, res, '/m/index.html');
      /**
       * 把**流水线自己那份**几何模块原样发给浏览器。
       *
       * 界面要在拖动时实时显示景别、机位关系、越轴 —— 那些全是 previz.js 里的算法。
       * 三条路可选，两条是错的：
       *   在界面里再写一份  → 两份算法会以肉眼看不出的方式漂开（一边顺时针、
       *                      一边逆时针），而漂开不报错，只是"预览和成片对不上"
       *   每次拖动问服务端  → 拖一下发一次请求，手感烂，还得处理乱序返回
       *   **发同一个文件**  → 一份代码两处跑，不可能漂
       *
       * 前提是这个文件必须保持**零依赖**（它现在就是纯计算，不碰 node: 任何东西）。
       * 自检里有一条守着这件事 —— 哪天有人给它加个 import，那条会先红。
       */
      if (url.pathname === '/previz.js') {
        return fs.readFile(path.join(HERE, 'pipeline', 'previz.js'), (err, data) => {
          if (err) return json(res, 404, { error: '找不到 previz.js' });
          res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      }
      /**
       * 同一个道理，台词时长的估法也发原件。
       *
       * 手机端要在人边打字边说"这句约 2.1 秒，本镜 3.2 秒，说得完"。
       * 在界面里另写一个估法的话，两份系数迟早会漂 —— 然后界面说念得完、
       * 合成那步说念不完，而两句话都是我们自己说的。
       */
      if (url.pathname === '/duration.js') {
        return fs.readFile(path.join(HERE, 'duration.js'), (err, data) => {
          if (err) return json(res, 404, { error: '找不到 duration.js' });
          res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      }
      /**
       * 转场表和效果表，也发原件 —— 和上面两个是同一条理由。
       *
       * 剪辑台上那两个下拉框要列出**能做的每一种**转场和效果。在界面里
       * 另抄一份清单的话，加一个新转场就必须记得改两个地方，
       * 而漏掉界面那份的表现是"引擎支持但没人选得到"（谁也不会发现），
       * 漏掉引擎那份的表现是"选了没效果"（用户发现，然后报"点了没反应"）。
       *
       * 这两个文件必须保持纯计算（不 import 任何 node: 模块），自检守着这一条。
       */
      if (url.pathname === '/transitions.js' || url.pathname === '/fx.js' || url.pathname === '/seam.js') {
        const file = url.pathname.slice(1);
        return fs.readFile(path.join(HERE, file), (err, data) => {
          if (err) return json(res, 404, { error: `找不到 ${file}` });
          res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      }
      /**
       * 剪辑那一层也发原件 —— 这一条是这几个里最要紧的。
       *
       * 剪辑台要在浏览器里**画出成片的时间线**：每一镜从第几秒开始、占多长。
       * 而同一份计算在服务端决定配音摆在第几秒、字幕什么时候出、片段怎么裁。
       * 界面里另写一份的话，两份一定会漂（少减一次转场重叠、时长策略读了
       * 另一个字段），表现是"时间线上写第 22 秒、成片里在第 20.5 秒" ——
       * 没有任何报错，只能拿秒表去比，而没人会那么做。
       *
       * 它 import 的 `../transitions.js`、`../fx.js` 在浏览器里会解析到
       * `/transitions.js`、`/fx.js`（URL 里 `/` 的上一级还是 `/`），
       * 正好就是上面那两条路由。自检守着"只许 import 这两个"。
       */
      /**
       * 场地图那一层也发原件。
       *
       * 它 import 的 `./previz.js` 在浏览器里从 `/site.js` 出发正好解析到
       * `/previz.js` —— 上面那条路由。自检守着"只许 import 这一个"。
       *
       * 为什么必须共用：画布上拖场景时要当场算"大殿在山门外正北 30 米"，
       * 而同一份计算在服务端判断太阳对不对得上、远景地标有没有跑。
       * 界面里另写一份的话，图上说正北、检查说西北 —— 两句话都是我们说的。
       */
      if (url.pathname === '/site.js') {
        return fs.readFile(path.join(HERE, 'pipeline', 'site.js'), (err, data) => {
          if (err) return json(res, 404, { error: '找不到 site.js' });
          res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      }
      if (url.pathname === '/edit.js') {
        return fs.readFile(path.join(HERE, 'pipeline', 'edit.js'), (err, data) => {
          if (err) return json(res, 404, { error: '找不到 edit.js' });
          res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      }
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
  /**
   * 服务器模式下**配错就不启动**。
   *
   * 一个"少配了一项、于是谁都能进"的服务，比起不起来危险得多 ——
   * 因为它看起来一切正常，没人会去查。所以宁可在这里退出，
   * 把缺什么、怎么补印清楚。
   */
  if (deploy.SERVER_MODE) {
    const cfg = deploy.checkConfig();
    for (const note of cfg.notes || []) console.log(`[部署] ${note}`); // eslint-disable-line no-console
    if (!cfg.ok) {
      const msg = `服务器模式配置不完整，拒绝启动：\n  - ${cfg.problems.join('\n  - ')}`;
      return Promise.reject(new Error(msg));
    }
  }

  return new Promise((resolve, reject) => {
    const server = createServer();
    /**
     * ⚠ **端口 0 是有意义的**：它表示"随便给我一个空闲端口"（内核分配）。
     *
     * 原来写的是 `preferredPort || ...`，而 0 是假值 —— 于是 listen(0) 被悄悄
     * 换成了 5178。所有测试脚手架都在用 listen(0)，也就都在抢同一个端口。
     *
     * Linux 上这个错**看不出来**：撞了端口会 EADDRINUSE 然后顺延，一切照常。
     * Windows 上 `0.0.0.0:5178` 和 `127.0.0.1:5178` 可以同时存在，而发往
     * 127.0.0.1 的连接会落到更具体的那个绑定上 —— 于是子进程报的是自己的端口，
     * 请求却全被父进程接走了。表现是"服务器模式的测试全红，报错说只允许 127.0.0.1"，
     * 而那正是**另一个进程**的规矩。这条让 Windows 打包红了一整轮。
     */
    const wantsEphemeral = preferredPort === 0;
    let port = wantsEphemeral
      ? 0
      : preferredPort || Number(process.env.PORT) || settings.get('port') || 5178;
    let tried = 0;
    // 服务器模式要对外可达（前面通常还有一层 Caddy 反代）；桌面模式只听本机
    const bindHost = deploy.SERVER_MODE ? '0.0.0.0' : '127.0.0.1';
    const tryListen = () => {
      server.listen(port, bindHost);
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
    server.on('listening', () => {
      // 端口 0 时真实端口只有内核知道，必须问 address()，不能报那个 0
      const actual = server.address()?.port || port;
      port = actual;
      resolve({
        server,
        port: actual,
        url: deploy.SERVER_MODE
          ? `https://${deploy.PUBLIC_HOST}`
          : `http://127.0.0.1:${actual}`
      });
    });
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

      /**
       * 自己开浏览器，用的是真实绑定到的端口 —— 启动脚本里写死端口会在端口顺延时打开空白页。
       *
       * 服务器上不开：那台机器没有桌面，也没人坐在它前面。更要紧的是下面这一条 ——
       *
       * ⚠ spawn 找不到程序时**不是抛异常**，而是异步 emit 一个 'error' 事件。
       *   没人听这个事件，Node 就把它变成未捕获异常，整个进程 exit(1)。
       *   try/catch 包不住它。容器里没有 xdg-open，于是"启动成功"打印完就崩，
       *   restart: unless-stopped 再把它拉起来 —— 无限重启。
       *   所以这里必须挂 on('error')，而不是只靠 try/catch。
       */
      if (process.env.FUTUREDREAM_NO_OPEN !== '1' && !deploy.SERVER_MODE) {
        const { spawn } = await import('node:child_process');
        const cmd =
          process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin'
              ? ['open', [url]]
              : ['xdg-open', [url]];
        try {
          const child = spawn(cmd[0], cmd[1], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.on('error', () => {
            /* 打不开就算了，地址已经在上面打印出来了 —— 但绝不能因此把服务弄死 */
          });
          child.unref();
        } catch {
          /* 同上 */
        }
      }
    })
    .catch((err) => {
      console.error('启动失败：', err.message);
      process.exit(1);
    });
}

/** 只给自检用：心跳是看不见的东西，不测就永远不知道它有没有在跳 */
export const __ndjson = ndjson;
