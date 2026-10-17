/**
 * 未央 API 网关 + 静态资源服务（Node 18+，除 Anthropic SDK 外零依赖）。
 *
 *   POST /api/chat              对话流（SSE）：{ delta, emotion_hint, task_state, tool? }
 *   GET  /api/local/metrics     本机指标
 *   GET  /api/agent/events      情绪注入事件流（SSE，前端订阅）
 *   POST /api/agent/emotion     情绪信号注入（仅供后端内部系统：需 Bearer 令牌，未配置令牌时只接受本机回环地址）
 *   GET  /api/health            后端模式、已配置密钥的服务商
 *   ANY  /api/llm/<服务商>/...   大模型接口代理：绕过浏览器跨域限制；浏览器没带密钥时注入环境变量里的密钥
 *   GET  /api/fetch?url=         读取网页（智能体的 fetch_url 工具用；拒绝内网地址）
 *   /api/ollama/...             本机模型：检测 / 启动 / 下载 / 删除（见 ollama.mjs；仅本机页面可调用）
 *   /api/server/… /api/tasks/… /api/sessions/… /api/files/…  服务器模式（见 serverMode.mjs）
 *   其它                         dist/ 下的静态文件（先 npm run build）
 *
 * 环境变量：
 *   PORT                    默认 8787
 *   ANTHROPIC_API_KEY       配置后使用 Claude；否则使用本地演示智能体
 *   JARVIS_MODEL            默认 claude-opus-5-5
 *   JARVIS_INTERNAL_TOKEN   情绪注入端点的令牌
 *   HOST                    默认 127.0.0.1（只允许本机访问；设为 0.0.0.0 才对局域网开放）
 *   JARVIS_DATA             服务器模式的数据目录（设置了就开启服务器模式）
 *   JARVIS_PASSWORD         服务器模式的访问密码（至少 8 位）
 *   JARVIS_MAX_TASKS        服务器模式同时最多做几个任务（默认 1）
 *   OPENAI_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / …  各服务商密钥（见 shared/providers.js 的 ENV_KEYS）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { ClaudeAgent, MockAgent } from './agents.mjs';
import { collectMetrics } from './metrics.mjs';
import { EMOTIONS } from '../shared/emotionTag.js';
import { upstreamFor, providerById, ENV_KEYS, isPrivateHost } from '../shared/providers.js';
import { createMcpManager } from './mcp.mjs';
import { createOllama } from './ollama.mjs';
import { edgeSpeak } from './edgeTts.mjs';
import { createWeatherProxy } from './weather.mjs';

const CORS_PATHS = /^\/api\/(health|local\/metrics|llm\/.+|tts\/edge)$/;
/** 服务器模式里允许跨域调用的接口（手机 App、电脑版连自己的服务器） */
const SERVER_CORS = /^\/api\/(health|server\/.+|tasks(\/.*)?|sessions(\/.*)?|files(\/raw)?)$/;
export const EXTRA_UPSTREAMS = { tavily: 'https://api.tavily.com', bocha: 'https://api.bochaai.com', elevenlabs: 'https://api.elevenlabs.io' };
// 读取网页时用常见浏览器的请求头：不少网站（包括搜索引擎）会拒绝或降级陌生的客户端
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};
const FORWARD_HEADERS = ['content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'xi-api-key'];

export { isPrivateHost };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

export function createServer({
  agent = process.env.ANTHROPIC_API_KEY ? new ClaudeAgent() : new MockAgent(),
  internalToken = process.env.JARVIS_INTERNAL_TOKEN || '',
  staticDir = DIST,
  mcp = null, // createMcpManager() 的结果；为 null 时不提供 MCP 接口
  ollama = createOllama(),
  edgeTts = edgeSpeak, // Edge 在线朗读（测试可替换）
  ossFetch = (...a) => fetch(...a), // 转发到阿里云 OSS（测试可替换）
  serverMode = null // createServerMode() 的结果：部署在云服务器上、任务交给服务器做（见 serverMode.mjs）
} = {}) {
  const subscribers = new Set();
  const weather=createWeatherProxy();
  let activeChats = 0;

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers) res.write(frame);
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /**
   * 只允许本机页面调用的接口（MCP 能启动本机程序）：
   *   Host 必须是本机地址（防 DNS 重绑定）；有 Origin 时必须与 Host 同源（防其他网站跨站提交）；
   *   必须带自定义请求头（跨站请求会因此触发预检而被拦下）。
   */
  function sameOriginOnly(req) {
    const host = String(req.headers.host || '');
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return false;
    return req.headers['x-jarvis-client'] === '1';
  }

  async function handleMcp(req, res, pathname) {
    if (!sameOriginOnly(req)) return json(res, 403, { error: '只允许本机未央页面调用' });
    if (!mcp) return json(res, 404, { error: '当前网关没有启用 MCP', available: false });
    if (pathname === '/api/mcp' && req.method === 'GET') return json(res, 200, { available: true, configPath: mcp.configPath, servers: mcp.list() });
    if (pathname === '/api/mcp/call' && req.method === 'POST') {
      const { server, tool, arguments: args } = await readJson(req, 1024 * 1024);
      return json(res, 200, await mcp.call(String(server), String(tool), args && typeof args === 'object' ? args : {}));
    }
    const m = pathname.match(/^\/api\/mcp\/servers\/([^/]+)(\/restart)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] && req.method === 'POST') return json(res, 200, await mcp.restart(id));
      if (!m[2] && req.method === 'PUT') return json(res, 200, await mcp.upsert({ ...(await readJson(req)), id }));
      if (!m[2] && req.method === 'DELETE') { await mcp.remove(id); return json(res, 200, { ok: true }); }
    }
    return json(res, 404, { error: 'not found' });
  }

  async function handleOllama(req, res, pathname) {
    if (!sameOriginOnly(req)) return json(res, 403, { error: '只允许本机未央页面调用' });
    if (pathname === '/api/ollama/status' && req.method === 'GET') return json(res, 200, await ollama.status());
    if (pathname === '/api/ollama/start' && req.method === 'POST') return json(res, 200, await ollama.start());
    if (pathname === '/api/ollama/pull' && req.method === 'POST') {
      const { model } = await readJson(req, 4096);
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const upstream = await ollama.pull(String(model || ''), ac.signal);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      try {
        for await (const chunk of upstream.body) res.write(chunk);
      } catch { /* 用户取消 */ }
      return res.end();
    }
    const m = pathname.match(/^\/api\/ollama\/models\/(.+)$/);
    if (m && req.method === 'DELETE') return json(res, 200, await ollama.remove(decodeURIComponent(m[1])));
    return json(res, 404, { error: 'not found' });
  }

  /** Edge 在线朗读：POST { text, voice, rate, pitch } → mp3。需要本机未央页面的请求头 */
  async function handleEdgeTts(req, res, cross) {
    if (req.headers['x-jarvis-client'] !== '1' || (!cross && !sameOriginOnly(req))) return json(res, 403, { error: '只允许本机未央页面调用' });
    const { text, voice, rate, pitch } = await readJson(req, 64 * 1024);
    try {
      const audio = await edgeTts(String(text || ''), { voice: voice || undefined, rate: Number(rate) || 0, pitch: Number(pitch) || 0 });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      res.end(audio);
    } catch (e) {
      json(res, 502, { error: e.message });
    }
  }

  /**
   * 数据同步：把签好名的 OSS 请求转发到阿里云（浏览器不能设置 Date 头，OSS 默认也不允许跨域）。
   * 只转发到 <bucket>.oss-<地域>.aliyuncs.com；签名在页面里算好，网关看不到 AccessKey Secret。
   */
  async function handleOss(req, res) {
    if (!sameOriginOnly(req)) return json(res, 403, { error: '只允许本机未央页面调用' });
    const { method, url, headers = {}, body } = await readJson(req, 64 * 1024 * 1024);
    let u;
    try { u = new URL(String(url)); } catch { return json(res, 400, { error: '地址无效' }); }
    if (u.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.oss-[a-z0-9-]+(\.internal)?\.aliyuncs\.com$/.test(u.hostname)) return json(res, 403, { error: '只转发到阿里云 OSS' });
    if (!['GET', 'PUT', 'HEAD'].includes(method)) return json(res, 400, { error: '不支持的请求方法' });
    const fwd = {};
    for (const [k, v] of Object.entries(headers)) if (/^(date|authorization|content-type|content-md5|x-oss-[a-z0-9-]+)$/i.test(k)) fwd[k] = String(v);
    const upstream = await ossFetch(u, { method, headers: fwd, body: body == null ? undefined : String(body), signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'x-oss-status': String(upstream.status), 'x-oss-etag': upstream.headers.get('etag') || '' });
    res.end(buf);
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

  async function handleLlmProxy(req, res, id, rest, search, cross = false) {
    let base = id === 'ollama' ? `${ollama.host}/v1` : (upstreamFor(id) ?? EXTRA_UPSTREAMS[id]);
    if (id === 'custom' || id === 'claude-relay' || id === 'relay-multi') {
      // 自定义（OpenAI 兼容）接口：地址由前端在请求头里给出；允许内网地址（本机 / 局域网自建模型很常见）
      try {
        const u = new URL(String(req.headers['x-jarvis-upstream'] || ''));
        // 来自单文件版（跨域）的请求不允许指向内网，防止被网页当跳板探测局域网
        if (/^https?:$/.test(u.protocol) && !(cross && isPrivateHost(u.hostname))) base = u.href;
      } catch { /* 无效地址 */ }
      if (!base) return json(res, 400, { error: '自定义接口地址无效（需以 http:// 或 https:// 开头）' });
    }
    if (!base) return json(res, 404, { error: `不支持代理的服务商：${id}` });
    const headers = {};
    for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    // 浏览器没填密钥：用网关环境变量里的（跨域请求不注入，避免别的网页借用你的密钥）
    const envKey = cross ? undefined : process.env[ENV_KEYS[id]];
    if (id === 'elevenlabs') {
      if (!headers['xi-api-key'] || headers['xi-api-key'] === 'use-gateway-key') {
        if (envKey) headers['xi-api-key'] = envKey; else delete headers['xi-api-key'];
      }
    } else if (id === 'anthropic' || id === 'claude-relay') {
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
    // 每一跳重定向都重新检查，防止公网地址跳转到内网
    let upstream;
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return json(res, 403, { error: '只允许访问公网 http(s) 地址' });
      upstream = await fetch(url, { headers: FETCH_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const loc = upstream.headers.get('location');
      if (!(upstream.status >= 300 && upstream.status < 400 && loc)) break;
      if (hop >= 5) return json(res, 508, { error: '重定向次数过多' });
      url = new URL(loc, url);
    }
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
    // 单文件版（file:// 打开，Origin 为 null）可以借用本机网关转发模型请求，只开放这几个接口。
    // 不返回 Access-Control-Allow-Private-Network：Chrome 会因此拦下公网网页对本机网关的请求。
    const cross = req.headers.origin === 'null' && CORS_PATHS.test(pathname);
    if (cross) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        const asked = String(req.headers['access-control-request-headers'] || '');
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': /^[\w\-, ]*$/.test(asked) ? asked : 'content-type, authorization',
          'Access-Control-Max-Age': '600'
        });
        return res.end();
      }
    }
    try {
      // 服务器模式：除了健康检查和登录，所有接口都要先登录（别人拿不到你的模型额度、看不到你的对话）
      if (serverMode && pathname.startsWith('/api/')) {
        // 手机 App、电脑版的页面不是从这个网址打开的：允许跨域调用服务器模式的接口（凭令牌，不用 Cookie，所以对所有来源开放是安全的）
        if (req.headers.origin && SERVER_CORS.test(pathname)) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE', 'Access-Control-Allow-Headers': 'authorization, content-type, last-event-id', 'Access-Control-Max-Age': '600' });
            return res.end();
          }
        }
        if (pathname !== '/api/health' && pathname !== '/api/server/login' && !serverMode.authorized(req)) return json(res, 401, { error: '请先登录', login: true });
        if (await serverMode.handle(req, res, pathname)) return;
      }
      if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
      if (pathname === '/api/local/metrics' && req.method === 'GET') return json(res, 200, await collectMetrics({ tasks: { active: activeChats } }));
      if (pathname === '/api/agent/events' && req.method === 'GET') return handleEvents(req, res);
      if (pathname === '/api/agent/emotion' && req.method === 'POST') return await handleInject(req, res);
      if (pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          backend: agent.model === 'mock' ? 'mock' : 'claude',
          model: agent.model,
          cors: cross,
          mcp: Boolean(mcp) && !cross,
          ollama: !cross,
          serverMode: Boolean(serverMode),
          gatewayKeys: cross ? [] : Object.entries(ENV_KEYS).filter(([, env]) => process.env[env]).map(([id]) => id)
        });
      }
      const llm = pathname.match(/^\/api\/llm\/([a-z0-9-]+)\/(.*)$/);
      if (llm) return await handleLlmProxy(req, res, llm[1], llm[2], new URL(req.url, 'http://x').search, cross);
      if (pathname === '/api/mcp' || pathname.startsWith('/api/mcp/')) return await handleMcp(req, res, pathname);
      if (pathname === '/api/oss' && req.method === 'POST') return await handleOss(req, res);
      if (pathname === '/api/tts/edge' && req.method === 'POST') return await handleEdgeTts(req, res, cross);
      if (pathname.startsWith('/api/ollama/')) return await handleOllama(req, res, pathname);
      if (pathname === '/api/fetch' && req.method === 'GET') return await handleFetch(req, res, new URL(req.url, 'http://x').searchParams.get('url'));
      if ((pathname === '/api/weather'||pathname === '/api/weather/cities')&&req.method==='GET') return json(res,200,await weather(pathname,new URL(req.url,'http://x').searchParams));
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

// 直接运行（node server/server.mjs）时启动；用 pathToFileURL 比较，Windows 路径（C:\\…）也能匹配
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  // 服务器模式：设置了数据目录就开启（必须同时设置访问密码）；云服务器上不启动 MCP（会运行本机程序）
  // 按需加载：桌面版、本机网关用不到服务器模式，不加载智能体那一大套代码
  const serverMode = process.env.JARVIS_DATA ? (await import('./serverMode.mjs')).createServerMode({ dataDir: path.resolve(process.env.JARVIS_DATA), password: process.env.JARVIS_PASSWORD, maxRunning: Number(process.env.JARVIS_MAX_TASKS || 1) }) : null;
  const mcp = process.env.JARVIS_NO_MCP || serverMode ? null : createMcpManager({ log: (m) => console.log(m) });
  const server = createServer({ mcp, serverMode });
  mcp?.startAll();
  const shutdown = async () => { await mcp?.closeAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(port, host, () => {
    console.log(`未央网关已启动: http://127.0.0.1:${port}`);
    if (serverMode) console.log(`服务器模式已开启：数据目录 ${path.resolve(process.env.JARVIS_DATA)}，同时最多做 ${process.env.JARVIS_MAX_TASKS || 1} 个任务`);
    const keys = Object.entries(ENV_KEYS).filter(([, env]) => process.env[env]).map(([id]) => providerById(id)?.name ?? id);
    if (keys.length) console.log(`网关已配置密钥：${keys.join('、')}`);
    console.log(process.env.ANTHROPIC_API_KEY ? `对话后端: Claude (${process.env.JARVIS_MODEL || 'claude-opus-5-5'})` : '对话后端: 本地演示智能体（设置 ANTHROPIC_API_KEY 以接入 Claude）');
  });
}
