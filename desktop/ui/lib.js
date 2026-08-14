/** 前端小工具集：DOM 构建、接口调用、NDJSON 流读取。零依赖，够用就行。 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * 安全追加：跳过 null / undefined / false。
 *
 * 原生 Element.append() 会把非节点参数**转成字符串**，所以
 * `el.append(cond ? node : null)` 会在界面上真的印出一个 "null"。
 * h() 早就处理了这种情况，但直接 append 的地方没有 —— 用这个。
 */
export function add(el, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// ───────────────────────── 接口 ─────────────────────────

/**
 * 配对码。
 *
 * 本机打开时是空的 —— 127.0.0.1 上不需要，谁能打开这个端口谁本来就已经坐在这台机器前。
 * 手机从局域网连过来时才有：那条口子后面是你的 API 密钥和额度，
 * 同一个 Wi-Fi 下的人不该随手就能驱动它。见 core/server.js 里的 guard。
 */
let authKey = '';

export function setAuthKey(key) {
  authKey = key || '';
}

export function getAuthKey() {
  return authKey;
}

function authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (authKey) h['X-FD-Key'] = authKey;
  return Object.keys(h).length ? h : undefined;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: authHeaders(body ? { 'Content-Type': 'application/json' } : null),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回的不是 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * 读 NDJSON 流。后端把进度一行一个事件推过来，这里逐行回调。
 * 关键是要处理"一个 chunk 里可能有半行"的情况 —— 不留缓冲会把 JSON 切断。
 */
export async function stream(path, body, onEvent, { signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
    signal
  });
  if (!res.ok && res.headers.get('content-type')?.includes('json')) {
    throw new Error((await res.json()).error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* 半截行，忽略 */
      }
    }
  }
  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer.trim()));
    } catch {
      /* 收尾残渣 */
    }
  }
}

// ───────────────────────── 展示 ─────────────────────────

export function toast(message, kind = '') {
  const stack = $('#toasts');
  const el = h('div', { class: `toast ${kind}` }, message);
  stack.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 7000 : 3500);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c]);

/** 极简 JSON 高亮。够看清结构就行，不值得为它引一个 highlight 库。 */
export function highlightJSON(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return escapeHtml(text).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'n';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'k' : 's';
      else if (/true|false|null/.test(match)) cls = 'b';
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function statusBadge(status) {
  if (!status) return h('span', { class: 'badge err' }, '失败');
  const cls = status < 300 ? 'ok' : status < 400 ? 'warn' : 'err';
  return h('span', { class: `badge ${cls}` }, String(status));
}

/** 媒体文件走后端的 /media 通道（限制在数据目录内），不能直接用 file:// */
export function mediaUrl(localPath) {
  // <img src> / <video src> 没法带自定义头，所以配对码只能挂在查询串上
  const key = authKey ? `&k=${encodeURIComponent(authKey)}` : '';
  return `/media?p=${encodeURIComponent(localPath)}${key}`;
}
