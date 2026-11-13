/**
 * MCP（Model Context Protocol）客户端管理：连接用户配置的 MCP 服务，把它们的工具提供给智能体。
 *
 *   stdio  本机命令启动的服务（如 npx -y @modelcontextprotocol/server-filesystem D:\资料）
 *   http   远程服务（Streamable HTTP，连不上时退回旧版 SSE）
 *
 * 配置保存在 JSON 文件里（完整版：~/.jarvis/mcp.json；桌面版：应用数据目录），密钥只在这台电脑上。
 */
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { readJsonSafe, writeJsonAtomic } from './safeJson.mjs';

export const defaultConfigPath = () => path.join(process.env.JARVIS_HOME || path.join(os.homedir(), '.jarvis'), 'mcp.json');

const CONNECT_TIMEOUT = 60_000; // npx 首次运行要下载包，给足时间
const CALL_TIMEOUT = 120_000;
const MAX_RESULT = 100_000;
// 连接意外断开后自动重连：依次等这么久；连续失败这么多次就停下（熔断），等用户点“重连”
export const RECONNECT_DELAYS = [2_000, 5_000, 15_000];
const STABLE_MS = 60_000; // 连上后稳定这么久，失败计数清零

/** 服务 id：小写字母数字和连字符 */
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';

/** 把 MCP 工具结果转成给模型看的文本 */
export function resultToText(result) {
  const parts = [];
  for (const c of result?.content ?? []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[图片 ${c.mimeType}，约 ${Math.round((c.data?.length ?? 0) * 0.75 / 1024)} KB]`);
    else if (c.type === 'audio') parts.push(`[音频 ${c.mimeType}]`);
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[资源 ${c.resource?.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[资源链接 ${c.name ?? ''} ${c.uri}]`);
  }
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const text = parts.join('\n') || '（无输出）';
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n…（已截断，共 ${text.length} 字）` : text;
}

function validate(s) {
  const out = {
    id: slug(s.id || s.name),
    name: String(s.name || s.id || '').trim().slice(0, 40),
    type: s.type === 'http' ? 'http' : 'stdio',
    enabled: s.enabled !== false,
    autoApprove: Boolean(s.autoApprove)
  };
  if (!out.name) throw Object.assign(new Error('请填写名称'), { status: 400 });
  if (out.type === 'stdio') {
    out.command = String(s.command || '').trim();
    if (!out.command) throw Object.assign(new Error('请填写启动命令'), { status: 400 });
    out.args = Array.isArray(s.args) ? s.args.map(String) : [];
    out.env = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [String(k), String(v)]));
    if (s.cwd) out.cwd = String(s.cwd);
  } else {
    try { out.url = new URL(String(s.url)).href; } catch { throw Object.assign(new Error('服务地址无效'), { status: 400 }); }
    out.headers = Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [String(k), String(v)]));
  }
  return out;
}

/**
 * @param {{ configPath?: string, log?: (msg: string) => void, extraPath?: string }} o
 */
export function createMcpManager({ configPath = defaultConfigPath(), log = () => {}, extraPath = '', reconnectDelays = RECONNECT_DELAYS, stableMs = STABLE_MS } = {}) {
  /** @type {Map<string, { client?: Client, transport?: any, status: string, error?: string, tools: any[], stderr: string[] }>} */
  const conns = new Map();
  /** 自动重连状态：连续失败次数、等待中的定时器 */
  const retry = new Map();
  let servers = [];

  function load() {
    const { data, restored, broken } = readJsonSafe(configPath, { servers: [] });
    if (broken) log(restored ? `MCP 配置文件损坏，已从上次的备份恢复（坏文件留在 ${path.basename(broken)}）` : `MCP 配置文件损坏且没有备份，坏文件已改名为 ${path.basename(broken)}`);
    servers = (Array.isArray(data?.servers) ? data.servers : []).map((s) => { try { return validate(s); } catch { return null; } }).filter(Boolean);
  }
  function save() {
    writeJsonAtomic(configPath, { servers }, { mode: 0o600 });
  }

  const clearRetry = (id) => { clearTimeout(retry.get(id)?.timer); retry.delete(id); };

  /** 意外断开 / 自动重连失败：按间隔再试，连续失败太多次就停 */
  function scheduleReconnect(s, conn) {
    const r = retry.get(s.id) || { fails: 0 };
    clearTimeout(r.timer);
    if (r.fails >= reconnectDelays.length) {
      Object.assign(conn, { status: 'error', error: `${conn.error || '连接已断开'}（自动重连 ${r.fails} 次都失败，已暂停；检查后点“重连”）` });
      log(`MCP「${s.name}」自动重连连续失败，已暂停`);
      retry.set(s.id, r);
      return;
    }
    const wait = reconnectDelays[r.fails];
    r.fails += 1;
    Object.assign(conn, { status: 'error', error: `${conn.error || '连接已断开'}，${Math.round(wait / 1000)} 秒后自动重连（第 ${r.fails} 次）` });
    r.timer = setTimeout(() => {
      if (conns.get(s.id) !== conn) return; // 期间被用户修改 / 删除 / 手动重连
      const cur = servers.find((x) => x.id === s.id);
      if (cur?.enabled) connect(cur, { auto: true }).catch(() => {});
    }, wait);
    r.timer.unref?.();
    retry.set(s.id, r);
  }

  async function connect(s, { auto = false } = {}) {
    if (!auto) clearRetry(s.id); // 用户操作：重新开始计数
    else clearTimeout(retry.get(s.id)?.timer);
    await disconnect(s.id, { keepRetry: auto });
    const conn = { status: 'connecting', tools: [], stderr: [] };
    conns.set(s.id, conn);
    let client = new Client({ name: 'jarvis', version: '1.0.0' });
    try {
      let transport;
      if (s.type === 'stdio') {
        const env = { ...s.env };
        if (extraPath) env.PATH = [s.env?.PATH || process.env.PATH, extraPath].filter(Boolean).join(path.delimiter);
        transport = new StdioClientTransport({ command: s.command, args: s.args, env, cwd: s.cwd, stderr: 'pipe' });
        transport.stderr?.on('data', (d) => {
          conn.stderr.push(String(d));
          if (conn.stderr.length > 40) conn.stderr.shift();
        });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT, '启动超时');
      } else {
        const url = new URL(s.url);
        const requestInit = { headers: s.headers };
        try {
          transport = new StreamableHTTPClientTransport(url, { requestInit });
          await withTimeout(client.connect(transport), CONNECT_TIMEOUT, '连接超时');
        } catch (err) {
          // 旧版服务只支持 SSE（换一个新的 Client 重连）
          try { await client.close(); } catch { /* ignore */ }
          client = new Client({ name: 'jarvis', version: '1.0.0' });
          transport = new SSEClientTransport(url, { requestInit });
          await withTimeout(client.connect(transport), CONNECT_TIMEOUT, `连接失败：${err.message}`);
        }
      }
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      Object.assign(conn, { client, transport, status: 'ready', tools, error: undefined });
      client.onclose = () => {
        if (conns.get(s.id) !== conn || conn.status !== 'ready') return; // 我们自己断开的不算
        clearTimeout(conn.stableTimer);
        Object.assign(conn, { status: 'error', error: '连接已断开' });
        log(`MCP「${s.name}」连接意外断开`);
        scheduleReconnect(s, conn);
      };
      // 稳定运行一段时间后失败计数清零
      conn.stableTimer = setTimeout(() => { if (conns.get(s.id) === conn && conn.status === 'ready') clearRetry(s.id); }, stableMs);
      conn.stableTimer.unref?.();
      log(`MCP「${s.name}」已连接，${tools.length} 个工具`);
    } catch (err) {
      const tail = conn.stderr.join('').trim().split('\n').slice(-3).join(' ').slice(0, 300);
      Object.assign(conn, { status: 'error', error: `${err.message}${tail ? `｜${tail}` : ''}` });
      try { await client.close(); } catch { /* ignore */ }
      log(`MCP「${s.name}」连接失败：${conn.error}`);
      if (auto && conns.get(s.id) === conn) scheduleReconnect(s, conn);
    }
    return conn;
  }

  async function disconnect(id, { keepRetry = false } = {}) {
    const c = conns.get(id);
    conns.delete(id);
    if (!keepRetry) clearRetry(id);
    if (c) clearTimeout(c.stableTimer);
    if (c?.client) { try { await c.client.close(); } catch { /* ignore */ } }
  }

  load();

  return {
    configPath,
    /** 启动时连接所有已启用的服务（并行，不阻塞） */
    startAll() { return Promise.allSettled(servers.filter((s) => s.enabled).map(connect)); },
    async closeAll() { await Promise.allSettled([...conns.keys()].map(disconnect)); },
    list() {
      return servers.map((s) => {
        const c = conns.get(s.id);
        return {
          ...s,
          status: s.enabled ? (c?.status ?? 'off') : 'off',
          error: c?.error,
          tools: (c?.status === 'ready' ? c.tools : []).map((t) => ({ name: t.name, title: t.title, description: t.description ?? '', inputSchema: t.inputSchema }))
        };
      });
    },
    /** 新增或修改（id 相同即修改），然后按启用状态连接 / 断开 */
    async upsert(raw) {
      const s = validate(raw);
      const i = servers.findIndex((x) => x.id === s.id);
      if (i >= 0) servers[i] = s; else servers.push(s);
      save();
      if (s.enabled) await connect(s); else await disconnect(s.id);
      return this.list().find((x) => x.id === s.id);
    },
    async remove(id) {
      servers = servers.filter((s) => s.id !== id);
      save();
      await disconnect(id);
    },
    async restart(id) {
      const s = servers.find((x) => x.id === id);
      if (!s) throw Object.assign(new Error('没有这个服务'), { status: 404 });
      await connect(s);
      return this.list().find((x) => x.id === id);
    },
    async call(id, name, args = {}) {
      const c = conns.get(id);
      if (!c || c.status !== 'ready') throw Object.assign(new Error(`MCP 服务「${id}」未连接${c?.error ? `：${c.error}` : ''}`), { status: 409 });
      const result = await c.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT });
      return { isError: Boolean(result.isError), text: resultToText(result) };
    }
  };
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
