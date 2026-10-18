/**
 * 服务器模式（部署在自己的云服务器上）：任务交给服务器做，手机 / 电脑只负责发任务、看进度、取结果。
 *
 * 开启：设置环境变量 JARVIS_DATA（数据目录）和 JARVIS_PASSWORD（访问密码）。
 * 开启后网关所有 /api 接口都要先登录（/api/health 和登录本身除外），防止别人用你的模型额度。
 *
 *   POST   /api/server/login               { password } → { token }
 *   GET    /api/server/status              正在做 / 排队的任务
 *   GET    /api/server/config              模型设置（密钥只显示后 4 位）
 *   PUT    /api/server/config              保存模型设置（密钥留空 = 不改）
 *   GET    /api/server/update              版本号、自动更新装没装、上次检查 / 更新的结果
 *   POST   /api/server/update              马上检查并更新（留一个请求文件，由 root 的 jarvis-update 服务去做，见 deploy/update.sh）
 *   POST   /api/tasks                      { sessionId?, text } → { id, sessionId }
 *   GET    /api/tasks/<id>                 任务状态
 *   GET    /api/tasks/<id>/events?after=N  进度事件流（SSE）：先补发序号 > N 的，再实时推送，做完就结束
 *   POST   /api/tasks/<id>/stop            叫停
 *   GET    /api/sessions                   对话列表（不含消息内容）
 *   POST   /api/sessions/import            传一段本机的对话上来（服务器上已有同一段的不覆盖）
 *   GET    /api/sessions/<id>              一段对话
 *   PATCH  /api/sessions/<id>              { title?, pinned? } 改标题、钉住
 *   DELETE /api/sessions/<id>              删除对话
 *   GET    /api/files                      工作区文件列表
 *   GET    /api/files/raw?path=            下载文件
 *   PUT    /api/files/raw?path=            上传文件（请求体就是文件内容）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFileStore } from './fileStore.mjs';
import { createTaskRunner } from './taskRunner.mjs';
import { useBackend } from '../src/agent/store.js';
import { seedBuiltins } from '../src/agent/skillPacks.js';
import * as sessions from '../src/agent/sessions.js';
import * as ws from '../src/agent/workspace.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

const UPLOAD_LIMIT = 50 * 1024 * 1024;
/** 程序所在目录（安装包里的 VERSION 文件在这里） */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** install.sh 装的“立即更新”触发器：有它才能从手机上更新 */
const UPDATE_UNIT = '/etc/systemd/system/jarvis-update.path';
/** 上传一段本机对话的大小上限 */
const IMPORT_LIMIT = 8 * 1024 * 1024;
/** 登录令牌：由密码算出来（改密码后旧令牌自动失效），不在服务器上另存 */
export const tokenFor = (password) => createHash('sha256').update(`jarvis-server:${password}`).digest('hex');

/** 模型设置里的密钥只给看后 4 位 */
export function maskConfig(cfg) {
  const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
  return { ...cfg, keys: Object.fromEntries(Object.entries(cfg.keys ?? {}).map(([k, v]) => [k, mask(v)])), tavilyKey: mask(cfg.tavilyKey), bochaKey: mask(cfg.bochaKey) };
}
/** 保存时：密钥没改（还是 •••• 或留空）就沿用原来的 */
export function mergeConfig(old, next) {
  const keep = (n, o) => (!n || String(n).startsWith('••••') ? o ?? '' : n);
  const keys = { ...(old.keys ?? {}) };
  for (const [k, v] of Object.entries(next.keys ?? {})) keys[k] = keep(v, old.keys?.[k]);
  return { ...old, ...next, keys, tavilyKey: keep(next.tavilyKey, old.tavilyKey), bochaKey: keep(next.bochaKey, old.bochaKey) };
}

/**
 * @param {{ dataDir: string, password: string, maxRunning?: number, runner?: object }} o
 */
export function createServerMode({ dataDir, password, maxRunning = 1, runner: injected = null, appDir = APP_DIR, updateUnit = UPDATE_UNIT }) {
  if (!password || String(password).length < 8) throw new Error('服务器模式需要设置 JARVIS_PASSWORD（至少 8 位）');
  const store = createFileStore(path.join(dataDir, 'store'));
  useBackend(store);
  // 内置技能（做 PPT、Word、Excel 的步骤和规范）：和手机 / 电脑一样装上，版本更新时跟着升级
  seedBuiltins().catch((e) => console.warn('[服务器模式] 内置技能没装上：', e?.message || e));
  const configFile = path.join(dataDir, 'config.json');
  const loadConfig = () => {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch { return { ...DEFAULT_CONFIG }; }
  };
  const saveConfig = (cfg) => { fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 }); fs.renameSync(`${configFile}.tmp`, configFile); };
  const runner = injected ?? createTaskRunner({ getConfig: async () => loadConfig(), maxRunning });
  const want = Buffer.from(tokenFor(password));
  const failures = new Map(); // IP → 最近登录失败的时间（防止暴力猜密码）

  function authorized(req) {
    const url = new URL(req.url, 'http://x');
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function readBody(req, limit) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('文件太大（最多 50 MB）'), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  const readJson = async (req, limit = 256 * 1024) => {
    try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
  };

  function login(req, res, body) {
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    const recent = (failures.get(ip) ?? []).filter((t) => Date.now() - t < 10 * 60_000);
    if (recent.length >= 5) return json(res, 429, { error: '密码错误次数太多，10 分钟后再试' });
    const got = Buffer.from(tokenFor(String(body.password ?? '')));
    if (got.length === want.length && timingSafeEqual(got, want)) { failures.delete(ip); return json(res, 200, { token: tokenFor(password) }); }
    failures.set(ip, [...recent, Date.now()]);
    return json(res, 401, { error: '密码不对' });
  }

  function streamEvents(req, res, id, after) {
    const backlog = runner.events(id, after);
    if (!backlog) return json(res, 404, { error: '找不到这个任务（可能已经做完很久了，结果在对话记录里）' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const send = (ev) => res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    for (const ev of backlog) send(ev);
    const last = backlog.at(-1);
    const finished = (ev) => ev?.type === 'task_state' && ['done', 'error', 'stopped'].includes(ev.status);
    if (finished(last)) return res.end();
    let sent = last?.seq ?? after;
    const unsubscribe = runner.subscribe(id, (ev) => {
      if (ev.seq <= sent) return;
      sent = ev.seq;
      send(ev);
      if (finished(ev)) { cleanup(); res.end(); }
    });
    if (!unsubscribe) return res.end();
    // 心跳：中间的 Nginx / 手机网络长时间没数据会断开连接
    const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
    const cleanup = () => { clearInterval(beat); unsubscribe(); };
    req.on('close', cleanup);
  }

  /** 处理服务器模式的接口；不是这些接口返回 false */
  async function handle(req, res, pathname) {
    const url = new URL(req.url, 'http://x');
    if (pathname === '/api/server/login' && req.method === 'POST') { login(req, res, await readJson(req)); return true; }
    if (pathname === '/api/server/status' && req.method === 'GET') { json(res, 200, { ok: true, running: runner.running, tasks: runner.list().filter((t) => t.status === 'running' || t.status === 'queued') }); return true; }
    if (pathname === '/api/server/config') {
      if (req.method === 'GET') { json(res, 200, maskConfig(loadConfig())); return true; }
      if (req.method === 'PUT') { saveConfig(mergeConfig(loadConfig(), await readJson(req))); json(res, 200, { ok: true }); return true; }
    }
    if (pathname === '/api/server/update') {
      const auto = fs.existsSync(updateUnit);
      if (req.method === 'GET') {
        let last = null;
        try { last = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-status.json'), 'utf8')); } catch { /* 还没检查过 */ }
        let version = '';
        try { version = fs.readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim(); } catch { /* 不是用安装包装的 */ }
        json(res, 200, { version, auto, last, requested: fs.existsSync(path.join(dataDir, 'update-request')) });
        return true;
      }
      if (req.method === 'POST') {
        if (!auto) { json(res, 409, { error: '服务器上还没装自动更新：在服务器终端用新版安装包运行一次 install.sh 就有了' }); return true; }
        fs.writeFileSync(path.join(dataDir, 'update-request'), `${new Date().toISOString()}\n`);
        json(res, 200, { ok: true });
        return true;
      }
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const { sessionId = null, text, images, voice } = await readJson(req, IMPORT_LIMIT); // 可能带图片，放宽大小
      json(res, 200, await runner.start({ sessionId, text, images, voice: voice === true })); return true;
    }
    if (pathname === '/api/tasks' && req.method === 'GET') { json(res, 200, runner.list()); return true; }
    const t = pathname.match(/^\/api\/tasks\/([\w-]+)(\/events|\/stop)?$/);
    if (t) {
      if (!t[2] && req.method === 'GET') { const info = runner.get(t[1]); info ? json(res, 200, info) : json(res, 404, { error: '找不到这个任务' }); return true; }
      if (t[2] === '/events' && req.method === 'GET') { streamEvents(req, res, t[1], Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0)); return true; }
      if (t[2] === '/stop' && req.method === 'POST') { json(res, 200, { ok: runner.stop(t[1]) }); return true; }
    }
    if (pathname === '/api/sessions/import' && req.method === 'POST') {
      // 手机 / 电脑本机的对话传上来：服务器上没有的才存（已有的不覆盖，免得冲掉服务器上新聊的内容）
      const one = JSON.parse((await readBody(req, IMPORT_LIMIT)).toString('utf8') || '{}');
      if (!/^[\w-]{1,40}$/.test(String(one.id)) || !Array.isArray(one.messages)) { json(res, 400, { error: '对话格式不对' }); return true; }
      if (await sessions.get(one.id)) { json(res, 200, { ok: true, skipped: true }); return true; }
      const messages = one.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(({ role, content, ts, tools, files }) => ({ role, content, ts: Number(ts) || Date.now(), ...(Array.isArray(tools) && { tools: tools.slice(0, 30) }), ...(Array.isArray(files) && { files: files.slice(0, 12) }) }));
      if (!messages.length) { json(res, 200, { ok: true, skipped: true }); return true; }
      await sessions.save({ id: one.id, title: String(one.title || '新对话').slice(0, 60), titleSet: Boolean(one.titleSet), createdAt: Number(one.createdAt) || Date.now(), updatedAt: Number(one.updatedAt) || Date.now(), pinned: Boolean(one.pinned), messages, ...(one.summary && { summary: one.summary }), ...(one.requirements && { requirements: one.requirements }) });
      json(res, 200, { ok: true, imported: true });
      return true;
    }
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const busy = new Map(runner.list().filter((x) => x.status === 'running' || x.status === 'queued').map((x) => [x.sessionId, x.id]));
      json(res, 200, (await sessions.list()).map(({ messages, requirements, ...s }) => ({ ...s, count: messages.length, taskId: busy.get(s.id) ?? null })));
      return true;
    }
    const s = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (s) {
      if (req.method === 'GET') {
        const one = await sessions.get(s[1]);
        const busy = runner.list().find((x) => x.sessionId === s[1] && (x.status === 'running' || x.status === 'queued'));
        // 还在做的：半截回答不给（手机会接上实时进度，做完拿完整的）
        one ? json(res, 200, { ...one, messages: busy ? one.messages.filter((m) => m.draftOf !== busy.id) : one.messages, taskId: busy?.id ?? null }) : json(res, 404, { error: '找不到这个对话' });
        return true;
      }
      if (req.method === 'PATCH') {
        const { title, pinned } = await readJson(req);
        if (title !== undefined) await sessions.rename(s[1], title);
        if (pinned !== undefined) await sessions.setPinned(s[1], Boolean(pinned));
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'DELETE') { await sessions.remove(s[1]); json(res, 200, { ok: true }); return true; }
    }
    if (pathname === '/api/files' && req.method === 'GET') { json(res, 200, await ws.list(url.searchParams.get('prefix') || '')); return true; }
    if (pathname === '/api/files/raw') {
      const p = ws.normalize(url.searchParams.get('path') || '');
      if (req.method === 'GET') {
        const blob = await ws.readBlob(p).catch(() => null);
        if (!blob) { json(res, 404, { error: '找不到文件' }); return true; }
        res.writeHead(200, { 'Content-Type': blob.type || 'application/octet-stream', 'Content-Length': blob.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(p.split('/').pop())}`, 'Cache-Control': 'no-store' });
        res.end(Buffer.from(await blob.arrayBuffer()));
        return true;
      }
      if (req.method === 'PUT') {
        // encoding=base64：内容是 { data: Base64 }（手机 App 原生网络传不了原始字节）
        const raw = await readBody(req, url.searchParams.get('encoding') === 'base64' ? Math.ceil(UPLOAD_LIMIT * 1.4) : UPLOAD_LIMIT);
        const bytes = url.searchParams.get('encoding') === 'base64' ? Buffer.from(JSON.parse(raw.toString('utf8') || '{}').data || '', 'base64') : raw;
        const r = await ws.write(p, new Blob([bytes], { type: ws.MIME[ws.ext(p)] || 'application/octet-stream' }));
        json(res, 200, r);
        return true;
      }
    }
    return false;
  }

  return { authorized, handle, runner, store };
}
