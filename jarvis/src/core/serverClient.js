/**
 * 服务器模式的客户端：手机 / 电脑把任务交给自己的云服务器做（服务器端见 server/serverMode.mjs）。
 *
 *   createServerClient({ base, token })  登录后的各种请求
 *   runRemote(client, o)                 和 runAgent 一样的用法：发任务、把服务器的进度事件交给 emit，做完返回结果。
 *                                        网络断了自动重连，从断开的地方接着收；用户叫停时让服务器也停下
 *   remoteSessions(client)               对话的读写交给服务器（sessions.useRemote 用）
 */
const KEY = 'jarvis.server.v1';

/** 设置：{ url, token, enabled }（令牌由密码算出，不存密码本身） */
export function loadServerSettings(storage = globalThis.localStorage) {
  try { return { url: '', token: '', enabled: false, ...JSON.parse(storage?.getItem(KEY) || '{}') }; } catch { return { url: '', token: '', enabled: false }; }
}
export function saveServerSettings(s, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify({ url: s.url || '', token: s.token || '', enabled: Boolean(s.enabled) })); } catch { /* 存不了就算了 */ }
}
/** 网址整理成 https://域名（去掉结尾的 /） */
export const normalizeUrl = (u) => {
  const t = String(u || '').trim().replace(/\/+$/, '');
  return !t ? '' : /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

/** 把 SSE 文本切成事件：返回解析出的事件和没收完的剩余部分 */
export function parseSse(buf) {
  const events = [];
  const blocks = buf.split('\n\n');
  const rest = blocks.pop();
  for (const b of blocks) {
    const line = b.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* 不完整或心跳 */ }
  }
  return { events, rest };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

/**
 * @param {{ base: string, token?: string, fetchImpl?: typeof fetch }} o
 */
export function createServerClient({ base, token = '', fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const root = normalizeUrl(base);
  async function req(path, { method = 'GET', body, raw = false, signal, headers = {} } = {}) {
    const res = await fetchImpl(`${root}${path}`, {
      method, signal,
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && !(body instanceof Blob) && { 'Content-Type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: body instanceof Blob ? body : JSON.stringify(body) })
    });
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(res.status === 401 ? '服务器登录已失效，请到 设置 → 服务器模式 重新登录' : data.error || `服务器返回 ${res.status}`), { status: res.status });
    return data;
  }
  return {
    base: root,
    /** @returns {Promise<string>} 令牌 */
    async login(password) { return (await req('/api/server/login', { method: 'POST', body: { password } })).token; },
    health: () => req('/api/health'),
    status: () => req('/api/server/status'),
    getConfig: () => req('/api/server/config'),
    putConfig: (cfg) => req('/api/server/config', { method: 'PUT', body: cfg }),
    startTask: (o) => req('/api/tasks', { method: 'POST', body: o }),
    getTask: (id) => req(`/api/tasks/${id}`),
    stopTask: (id) => req(`/api/tasks/${id}/stop`, { method: 'POST' }),
    events: (id, after, signal) => req(`/api/tasks/${id}/events?after=${after}`, { raw: true, signal }),
    listSessions: () => req('/api/sessions'),
    getSession: (id) => req(`/api/sessions/${encodeURIComponent(id)}`).catch((e) => { if (e.status === 404) return null; throw e; }),
    patchSession: (id, patch) => req(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    deleteSession: (id) => req(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    listFiles: () => req('/api/files'),
    async download(path) {
      const res = await req(`/api/files/raw?path=${encodeURIComponent(path)}`, { raw: true });
      if (!res.ok) throw new Error(`下载 ${path} 失败（${res.status}）`);
      return res.blob();
    },
    upload: (path, blob) => req(`/api/files/raw?path=${encodeURIComponent(path)}`, { method: 'PUT', body: blob })
  };
}

/**
 * 收一个任务的进度：断线自动重连（从收到的最后一个序号接着收），直到任务结束
 * @returns {Promise<object>} 结束时的 task_state 事件
 */
export async function followTask(client, id, { onEvent, signal, after = 0, retryMs = [1000, 2000, 4000, 8000] } = {}) {
  let last = after;
  let failures = 0;
  for (;;) {
    try {
      const res = await client.events(id, last, signal);
      if (res.status === 404) throw Object.assign(new Error('服务器上找不到这个任务了（可能服务器重启过），结果请看对话记录'), { final: true });
      if (!res.ok || !res.body) throw new Error(`服务器返回 ${res.status}`);
      const reader = res.body.getReader();
      // 叫停时立刻结束等待（服务器那边一直没新数据时，读取会一直挂着）
      const cancel = () => reader.cancel().catch(() => {});
      signal?.addEventListener('abort', cancel, { once: true });
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().finally(() => { if (signal?.aborted) signal.removeEventListener('abort', cancel); });
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (done) break;
        failures = 0;
        const { events, rest } = parseSse(buf + dec.decode(value, { stream: true }));
        buf = rest;
        for (const ev of events) {
          if (ev.seq <= last) continue;
          last = ev.seq;
          onEvent?.(ev);
          if (ev.type === 'task_state' && ['done', 'error', 'stopped'].includes(ev.status)) return ev;
        }
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (e.final || e.status === 401) throw e;
    }
    // 连接断了（手机切网络、锁屏）：等一下再连，从断开的地方接着收；任务本身在服务器上照常做
    await sleep(retryMs[Math.min(failures++, retryMs.length - 1)], signal);
  }
}

/**
 * 和 runAgent 一样的用法：服务器做，进度事件原样交给 emit（文字、工具卡片、任务清单都和本机一样显示）
 * @param {object} client  createServerClient 的结果
 * @param {{ sessionId: string, userText: string, emit: (e: object) => void, signal?: AbortSignal, onFile?: (path: string) => void, onStarted?: (task: { id: string }) => void, taskId?: string }} o
 * @returns {Promise<{ text: string, toolCalls: number, steps: number }>}
 */
export async function runRemote(client, { sessionId, userText, emit, signal, onFile, onStarted, taskId = null }) {
  const task = taskId ? { id: taskId } : await client.startTask({ sessionId, text: userText });
  onStarted?.(task);
  const stop = () => client.stopTask(task.id).catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const end = await followTask(client, task.id, {
      signal,
      onEvent: (ev) => {
        if (ev.type === 'file') onFile?.(ev.path);
        else if (ev.type === 'task_state') { if (ev.status === 'queued' && ev.position) emit({ type: 'tool_progress', id: 'queue', text: `排队中，前面还有 ${ev.position} 个任务` }); }
        else if (ev.type !== 'user_note') emit(ev);
      }
    });
    if (end.status === 'error') throw new Error(end.error || '服务器上的任务出错了');
    if (end.status === 'stopped') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { text: end.text ?? '', toolCalls: end.toolCalls ?? 0, steps: 1 };
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

/** 对话的读写交给服务器：标题、钉住、删除改服务器上的；消息由服务器自己记，这里保存是空操作 */
export function remoteSessions(client) {
  return {
    list: () => client.listSessions().then((rows) => rows.map((s) => ({ ...s, messages: [] }))),
    get: (id) => client.getSession(id),
    save: async (s) => s,
    rename: (id, title) => client.patchSession(id, { title }),
    setPinned: (id, pinned) => client.patchSession(id, { pinned }),
    remove: (id) => client.deleteSession(id),
    async search(query) {
      const q = String(query || '').trim().toLowerCase();
      const all = await this.list();
      return q ? all.filter((s) => String(s.title).toLowerCase().includes(q)) : all;
    }
  };
}
