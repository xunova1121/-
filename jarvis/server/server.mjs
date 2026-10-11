/**
 * 贾维斯 API 网关 + 静态资源服务（Node 18+，除 Anthropic SDK 外零依赖）。
 *
 *   POST /api/chat              对话流（SSE）：{ delta, emotion_hint, task_state, tool? }
 *   GET  /api/local/metrics     本机指标
 *   GET  /api/agent/events      情绪注入事件流（SSE，前端订阅）
 *   POST /api/agent/emotion     情绪信号注入（仅供后端内部系统：需 Bearer 令牌，未配置令牌时只接受本机回环地址）
 *   GET  /api/health            后端模式、已配置密钥的服务商
 *   ANY  /api/llm/<服务商>/...   大模型接口代理：绕过浏览器跨域限制；浏览器没带密钥时注入环境变量里的密钥
 *   GET  /api/fetch?url=         读取网页（智能体的 fetch_url 工具用；拒绝内网地址）
 *   其它                         dist/ 下的静态文件（先 npm run build）
 *
 * 环境变量：
 *   PORT                    默认 8787
 *   ANTHROPIC_API_KEY       配置后使用 Claude；否则使用本地演示智能体
 *   JARVIS_MODEL            默认 claude-opus-5-5
 *   JARVIS_INTERNAL_TOKEN   情绪注入端点的令牌
 *   HOST                    默认 127.0.0.1（只允许本机访问；设为 0.0.0.0 才对局域网开放）
 *   OPENAI_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / …  各服务商密钥（见 shared/providers.js 的 ENV_KEYS）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { ClaudeAgent, MockAgent } from './agents.mjs';
import { collectMetrics } from './metrics.mjs';
import { EMOTIONS } from '../shared/emotionTag.js';
import { upstreamFor, providerById, ENV_KEYS } from '../shared/providers.js';

const EXTRA_UPSTREAMS = { tavily: 'https://api.tavily.com' };
const FORWARD_HEADERS = ['content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'];

/** 内网 / 本机地址：/api/fetch 不允许访问，避免被用来探测局域网 */
export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h === '::1' || h === '0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

export function createServer({
  agent = process.env.ANTHROPIC_API_KEY ? new ClaudeAgent() : new MockAgent(),
  internalToken = process.env.JARVIS_INTERNAL_TOKEN || '',
  staticDir = DIST
} = {}) {
  const subscribers = new Set();
  let activeChats = 0;

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers) res.write(frame);
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req, limit = 256 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('JSON 格式错误'), { status: 400 });
    }
  }

  function authorizedInternal(req) {
    if (internalToken) {
      const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      const want = Buffer.from(internalToken);
      return got.length === want.length && timingSafeEqual(got, want);
    }
    const ip = req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  async function handleChat(req, res) {
    const { messages } = await readJson(req);
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    activeChats++;
    try {
      for await (const ev of agent.run(messages, { signal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        console.error('[chat]', err);
        res.write(`data: ${JSON.stringify({ delta: '', emotion_hint: '警觉', task_state: 'error', error: String(err.message || err) })}\n\n`);
      }
    } finally {
      activeChats--;
      res.end();
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    subscribers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); subscribers.delete(res); });
  }

  async function handleInject(req, res) {
    if (!authorizedInternal(req)) return json(res, 403, { error: '仅供后端内部系统调用' });
    const { state, ttl_ms: ttl = 5000, source = 'unknown' } = await readJson(req, 4096);
    if (!EMOTIONS.includes(state)) return json(res, 400, { error: `state 必须是 ${EMOTIONS.join('、')} 之一` });
    const ttlMs = Math.max(0, Math.min(Number(ttl) || 0, 10 * 60 * 1000));
    broadcast('emotion', { state, ttl_ms: ttlMs, source: String(source).slice(0, 64) });
    json(res, 202, { ok: true, delivered: subscribers.size });
  }

  async function handleLlmProxy(req, res, id, rest, search) {
    const base = upstreamFor(id) ?? EXTRA_UPSTREAMS[id];
    if (!base) return json(res, 404, { error: `不支持代理的服务商：${id}` });
    const headers = {};
    for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    // 浏览器没填密钥：用网关环境变量里的
    const envKey = process.env[ENV_KEYS[id]];
    if (id === 'anthropic') {
      if (!headers['x-api-key'] || headers['x-api-key'] === 'use-gateway-key') {
        if (envKey) headers['x-api-key'] = envKey; else delete headers['x-api-key'];
      }
    } else if (!headers.authorization || /^Bearer\s*(use-gateway-key)?$/i.test(headers.authorization)) {
      if (envKey) headers.authorization = `Bearer ${envKey}`; else delete headers.authorization;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const upstream = await fetch(`${base.replace(/\/$/, '')}/${rest}${search}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
    });
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache'
    });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  }

  async function handleFetch(req, res, target) {
    let url;
    try { url = new URL(target); } catch { return json(res, 400, { error: '地址无效' }); }
    if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return json(res, 403, { error: '只允许访问公网 http(s) 地址' });
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Jarvis local agent)' }, redirect: 'follow' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(buf.subarray(0, 5 * 1024 * 1024));
  }

  function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    let file = path.normalize(path.join(staticDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html');
    if (!fs.existsSync(file)) return json(res, 404, { error: '未找到前端构建产物，请先运行 npm run build' });
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
      if (pathname === '/api/local/metrics' && req.method === 'GET') return json(res, 200, await collectMetrics({ tasks: { active: activeChats } }));
      if (pathname === '/api/agent/events' && req.method === 'GET') return handleEvents(req, res);
      if (pathname === '/api/agent/emotion' && req.method === 'POST') return await handleInject(req, res);
      if (pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          backend: agent.model === 'mock' ? 'mock' : 'claude',
          model: agent.model,
          gatewayKeys: Object.entries(ENV_KEYS).filter(([, env]) => process.env[env]).map(([id]) => id)
        });
      }
      const llm = pathname.match(/^\/api\/llm\/([a-z0-9-]+)\/(.*)$/);
      if (llm) return await handleLlmProxy(req, res, llm[1], llm[2], new URL(req.url, 'http://x').search);
      if (pathname === '/api/fetch' && req.method === 'GET') return await handleFetch(req, res, new URL(req.url, 'http://x').searchParams.get('url'));
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.message });
      else res.end();
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.onnx': 'application/octet-stream',
  '.task': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary'
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`贾维斯网关已启动: http://127.0.0.1:${port}`);
    const keys = Object.entries(ENV_KEYS).filter(([, env]) => process.env[env]).map(([id]) => providerById(id)?.name ?? id);
    if (keys.length) console.log(`网关已配置密钥：${keys.join('、')}`);
    console.log(process.env.ANTHROPIC_API_KEY ? `对话后端: Claude (${process.env.JARVIS_MODEL || 'claude-opus-5-5'})` : '对话后端: 本地演示智能体（设置 ANTHROPIC_API_KEY 以接入 Claude）');
  });
}
