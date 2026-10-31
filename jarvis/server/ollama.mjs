/**
 * 本机模型（Ollama）管理：检测、启动、下载（带进度）、删除。
 *
 *   网关接口（只允许本机未央页面调用，和 MCP 一样的同源校验）：
 *     GET    /api/ollama/status          { running, version, host, models, binary, ram, platform }
 *     POST   /api/ollama/start           找到 ollama 程序并在后台启动 `ollama serve`
 *     POST   /api/ollama/pull  {model}   逐行回传下载进度（NDJSON：{ status, total, completed }）
 *     DELETE /api/ollama/models/<名字>    删除本机模型
 *
 * 地址取 OLLAMA_HOST（默认 127.0.0.1:11434）。用 127.0.0.1 而不是 localhost：
 * Windows 上 localhost 可能先解析成 ::1，而 Ollama 默认只监听 IPv4。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MODEL_NAME = /^[\w][\w.\-/:]{0,99}$/;

export function ollamaHost(env = process.env) {
  let h = String(env.OLLAMA_HOST || '127.0.0.1:11434').trim();
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  try {
    const u = new URL(h);
    if (u.hostname === '0.0.0.0' || u.hostname === 'localhost') u.hostname = '127.0.0.1';
    if (!u.port) u.port = '11434';
    return u.origin;
  } catch {
    return 'http://127.0.0.1:11434';
  }
}

/** 常见安装位置 + PATH 里找 ollama 程序 */
export function findOllamaBinary(env = process.env, platform = process.platform, exists = fs.existsSync) {
  const exe = platform === 'win32' ? 'ollama.exe' : 'ollama';
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = dirs.map((d) => path.join(d, exe));
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', exe));
  if (platform === 'darwin') candidates.push('/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama');
  if (platform === 'linux') candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  return candidates.find((p) => { try { return exists(p); } catch { return false; } }) ?? null;
}

export function createOllama({ host = ollamaHost(), fetchImpl = globalThis.fetch, findBinary = findOllamaBinary, spawnImpl = spawn } = {}) {
  async function get(p, timeout = 1500) {
    const r = await fetchImpl(`${host}${p}`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`Ollama 返回 ${r.status}`);
    return r.json();
  }

  async function status() {
    const base = { host, binary: findBinary(), ram: os.totalmem(), platform: process.platform };
    try {
      const { version } = await get('/api/version');
      const { models = [] } = await get('/api/tags', 4000);
      return {
        ...base,
        running: true,
        version,
        models: models.map((m) => ({
          name: m.name,
          size: m.size,
          modified: m.modified_at,
          family: m.details?.family ?? '',
          params: m.details?.parameter_size ?? '',
          quant: m.details?.quantization_level ?? ''
        }))
      };
    } catch {
      return { ...base, running: false, version: null, models: [] };
    }
  }

  async function start() {
    const s = await status();
    if (s.running) return { ok: true, already: true };
    if (!s.binary) return { ok: false, error: '没有找到 Ollama，请先安装（ollama.com/download）' };
    const child = spawnImpl(s.binary, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await status()).running) return { ok: true };
    }
    return { ok: false, error: 'Ollama 启动超时，请手动打开 Ollama 应用' };
  }

  /** 返回 Ollama 的 NDJSON 进度流（Response），调用方逐行转发 */
  async function pull(model, signal) {
    if (!MODEL_NAME.test(model)) throw Object.assign(new Error('模型名不合法'), { status: 400 });
    const r = await fetchImpl(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal
    });
    if (!r.ok || !r.body) throw Object.assign(new Error(`Ollama 返回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 200)}`), { status: 502 });
    return r;
  }

  async function remove(model) {
    if (!MODEL_NAME.test(model)) throw Object.assign(new Error('模型名不合法'), { status: 400 });
    const r = await fetchImpl(`${host}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!r.ok) throw Object.assign(new Error(`删除失败（${r.status}）`), { status: 502 });
    return { ok: true };
  }

  return { host, status, start, pull, remove };
}
