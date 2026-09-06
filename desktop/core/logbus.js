/**
 * 联调台的"黑匣子"：每一次出站请求都在这里留一条记录。
 *
 * 记录进来之前一律脱敏 —— Authorization、api-key、cookie 这类头只留掩码，
 * body 里长得像密钥的字段也一并遮掉。历史记录会落盘，密钥不能跟着落。
 */
import fs from 'node:fs';
import { HISTORY_FILE, DATA_DIR } from './paths.js';
import { mask } from './vault.js';

const MAX_ENTRIES = 300;
const MAX_BODY_CHARS = 20000; // 单条留 20K，够看清结构，又不至于把历史撑爆

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-dashscope-api-key',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'proxy-authorization'
]);

const SENSITIVE_BODY_KEYS = /^(api[_-]?key|secret|secret[_-]?key|access[_-]?key|token|password|authorization)$/i;

let entries = [];
let listeners = new Set();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(parsed)) entries = parsed.slice(-MAX_ENTRIES);
  } catch {
    entries = [];
  }
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  // 攒 800ms 再写，避免轮询任务把磁盘打满
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries), 'utf8');
    } catch {
      /* 历史记录写不进去不该影响主流程 */
    }
  }, 800);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      const val = String(v);
      // Bearer sk-xxx → Bearer sk-abc***wxyz，保留 scheme 方便排查认证方式写错
      const m = val.match(/^(Bearer|Basic|Token)\s+(.*)$/i);
      out[k] = m ? `${m[1]} ${mask(m[2])}` : mask(val);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function redactBody(body) {
  if (body === null || body === undefined) return body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_CHARS) {
      return `${body.slice(0, MAX_BODY_CHARS)}\n…（已截断，共 ${body.length} 字符）`;
    }
    return body;
  }
  if (Array.isArray(body)) return body.map(redactBody);
  if (typeof body === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(body)) {
      out[k] = SENSITIVE_BODY_KEYS.test(k) && typeof v === 'string' ? mask(v) : redactBody(v);
    }
    return out;
  }
  return body;
}

let seq = 0;

export function record(entry) {
  load();
  const item = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    at: new Date().toISOString(),
    ...entry
  };
  entries.push(item);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  schedulePersist();
  for (const fn of listeners) {
    try {
      fn(item);
    } catch {
      /* 单个监听器炸了不影响别人 */
    }
  }
  return item;
}

export function list({ limit = 80, provider = null } = {}) {
  load();
  let out = entries;
  if (provider) out = out.filter((e) => e.provider === provider);
  return out.slice(-limit).reverse();
}

export function get(id) {
  load();
  return entries.find((e) => e.id === id) || null;
}

export function clear() {
  entries = [];
  schedulePersist();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 简单的健康度统计，联调台顶部那排数字用 */
export function stats() {
  load();
  const recent = entries.slice(-100);
  const ok = recent.filter((e) => e.status >= 200 && e.status < 300).length;
  const failed = recent.filter((e) => !e.status || e.status >= 400).length;
  const durations = recent.map((e) => e.totalMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  return {
    total: entries.length,
    sampled: recent.length,
    ok,
    failed,
    p50Ms: durations.length ? durations[Math.floor(durations.length * 0.5)] : null,
    p95Ms: durations.length ? durations[Math.floor(durations.length * 0.95)] : null
  };
}
