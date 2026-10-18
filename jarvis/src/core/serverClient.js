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

/** Blob → Base64（分段转换，大文件也不会超出调用栈） */
export async function toBase64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

/**
 * @param {{ base: string, token?: string, fetchImpl?: typeof fetch }} o
 */
export function createServerClient({ base, token = '', fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 20000 }) {
  const root = normalizeUrl(base);
  /** 最近几次请求花了多久、走的哪种网络（设置 → 服务器模式里显示，查“为什么慢”用） */
  const timings = [];
  let taskProtocol = null;
  const requestId = () => globalThis.crypto?.randomUUID?.() || 'r_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
  async function taskWrite(path, body) {
    // 只有服务器明确支持请求去重时才重试写请求；旧服务器保持不自动重发。
    const payload={...body,requestId:body.requestId||requestId()};
    try{return await req(path,{method:'POST',body:payload});}
    catch(e){
      if(e.status||e.name==='AbortError'&&!e.timeout)throw e;
      taskProtocol ??= req('/api/server/status',{}).then(x=>Boolean(x.features?.taskRequestIds)).catch(()=>false);
      if(!await taskProtocol)throw e;
      return req(path,{method:'POST',body:payload});
    }
  }
  const note = (path, t0, ok) => {
    const via = globalThis.__jarvisNetVia?.(`${root}${path}`);
    timings.unshift({ path: path.split('?')[0], ms: Date.now() - t0, ok, ...(via && { via }), at: Date.now() });
    timings.length = Math.min(timings.length, 8);
  };
  async function send(path, { method, body, signal, headers, binary, timeout }) {
    // 超时：网络卡住时不一直等，报错让上层重试或提示（事件流不设，它本来就一直开着）
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = timeout ? setTimeout(() => { ctrl.timedOut = true; ctrl.abort(); }, timeout) : 0;
    const t0 = Date.now();
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method, signal: ctrl.signal,
        // 手机 App 退到原生网络时：binary 让它按原始字节读（不然 Word、图片这类文件会被当成文字读坏）
        ...(binary && { binary: true }),
        headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && !(body instanceof Blob) && { 'Content-Type': 'application/json' }), ...headers },
        ...(body !== undefined && { body: body instanceof Blob ? body : JSON.stringify(body) })
      });
      note(path, t0, res.ok);
      return res;
    } catch (e) {
      note(path, t0, false);
      if (ctrl.timedOut && !signal?.aborted) throw Object.assign(new Error(`连服务器超时（${Math.round(timeout / 1000)} 秒没有回应）`), { timeout: true });
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
  async function req(path, { method = 'GET', body, raw = false, signal, headers = {}, binary = false, timeout = raw ? 0 : timeoutMs } = {}) {
    let res;
    try {
      res = await send(path, { method, body, signal, headers, binary, timeout });
    } catch (e) {
      // 读数据的请求网络一抖就失败：再试一次（写数据的不重试，免得做两遍）
      if (method !== 'GET' || signal?.aborted || (e?.name === 'AbortError' && !e.timeout)) throw e;
      res = await send(path, { method, body, signal, headers, binary, timeout });
    }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(res.status === 401 ? '服务器登录已失效，请到 设置 → 服务器模式 重新登录' : data.error || `服务器返回 ${res.status}`), { status: res.status });
    return data;
  }
  return {
    base: root,
    timings,
    /** @returns {Promise<string>} 令牌 */
    async login(password) { return (await req('/api/server/login', { method: 'POST', body: { password } })).token; },
    health: () => req('/api/health'),
    status: () => req('/api/server/status'),
    getConfig: () => req('/api/server/config'),
    putConfig: (cfg) => req('/api/server/config', { method: 'PUT', body: cfg }),
    updateInfo: () => req('/api/server/update'),
    requestUpdate: () => req('/api/server/update', { method: 'POST' }),
    startTask: (o) => taskWrite('/api/tasks',o),
    appendTaskNote: (id,text) => taskWrite(`/api/tasks/${encodeURIComponent(id)}/notes`,{text}),
    getTask: (id) => req(`/api/tasks/${id}`),
    stopTask: (id) => req(`/api/tasks/${id}/stop`, { method: 'POST' }),
    // 要求事件流：手机 App 退到原生网络时也边收边显示（见 mobile/nativeFetch.js 的 wantsStream）
    events: (id, after, signal) => req(`/api/tasks/${id}/events?after=${after}`, { raw: true, signal, headers: { Accept: 'text/event-stream' } }),
    listSessions: () => req('/api/sessions'),
    getSession: (id) => req(`/api/sessions/${encodeURIComponent(id)}`).catch((e) => { if (e.status === 404) return null; throw e; }),
    patchSession: (id, patch) => req(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    deleteSession: (id) => req(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    importSession: (session) => req('/api/sessions/import', { method: 'POST', body: session }),
    truncateSession: (id, keep) => req(`/api/sessions/${encodeURIComponent(id)}/truncate`, { method: 'POST', body: { keep } }),
    appendSession: (id, messages) => req(`/api/sessions/${encodeURIComponent(id)}/append`, { method: 'POST', body: { messages } }),
    searchSessions: (q) => req(`/api/sessions/search?q=${encodeURIComponent(q)}`),
    listFiles: () => req('/api/files'),
    async download(path) {
      const res = await req(`/api/files/raw?path=${encodeURIComponent(path)}`, { raw: true, binary: true, timeout: 120000 });
      if (!res.ok) throw new Error(`下载 ${path} 失败（${res.status}）`);
      return res.blob();
    },
    // 上传用 Base64 包在 JSON 里：手机 App 退到原生网络时，原始字节会被当成文字传坏
    upload: async (path, blob) => req(`/api/files/raw?path=${encodeURIComponent(path)}&encoding=base64`, { method: 'PUT', body: { data: await toBase64(blob) }, timeout: 120000 })
  };
}

/**
 * 收一个任务的进度：断线自动重连（从收到的最后一个序号接着收），直到任务结束
 * @returns {Promise<object>} 结束时的 task_state 事件
 */
export async function followTask(client, id, { onEvent, signal, after = 0, retryMs = [1000, 2000, 4000, 8000], checkMs = 10000 } = {}) {
  let last = after;
  let failures = 0;
  let reader = null;
  // 保底：每隔一会儿问一下服务器任务做完没有。做完了却还没收到“完成”（中间的网络把最后一段卡住了）
  // 就断开重连，服务器会把漏掉的进度连同“完成”一起补发
  const watch = setInterval(async () => {
    try {
      const t = await client.getTask(id);
      if (['done', 'error', 'stopped'].includes(t?.status) && t.seq > last) reader?.cancel().catch(() => {});
    } catch { /* 问不到就下次再问 */ }
  }, checkMs);
  try {
    return await follow();
  } finally {
    clearInterval(watch);
  }
  async function follow() {
    for (;;) {
      try {
        const res = await client.events(id, last, signal);
        if (res.status === 404) throw Object.assign(new Error('服务器上找不到这个任务了（可能服务器重启过），结果请看对话记录'), { final: true });
        if (!res.ok || !res.body) throw new Error(`服务器返回 ${res.status}`);
        reader = res.body.getReader();
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
}

  /**
   * 和 runAgent 一样的用法：服务器做，进度事件原样交给 emit（文字、工具卡片、任务清单都和本机一样显示）
   * @param {object} client  createServerClient 的结果
   * @param {{ sessionId: string, userText: string, images?: Array<{ mime: string, data: string }>, emit: (e: object) => void, signal?: AbortSignal, onFile?: (path: string) => void, onStarted?: (task: { id: string }) => void, taskId?: string }} o
   * @returns {Promise<{ text: string, toolCalls: number, steps: number }>}
   */
  export async function runRemote(client, { sessionId, userText, images = [], voice = false, emit, signal, onFile, onStarted, taskId = null }) {
    const task = taskId ? { id: taskId } : await client.startTask({ sessionId, text: userText, ...(images.length && { images }), ...(voice && { voice: true }) });
    await onStarted?.(task);
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

/** 手机 / 电脑上留一份服务器对话的副本：打开 App、切换对话时先显示它，再从服务器取最新的 */
const CACHE_KEY = 'jarvis.server.cache.v1';
/** 副本里最多留几段对话、每段最多几条消息（太大存不下） */
const CACHE_SESSIONS = 12;
const CACHE_MESSAGES = 80;

/** 对话的读写交给服务器：标题、钉住、删除改服务器上的；消息由服务器自己记，这里保存是空操作 */
export function remoteSessions(client, { storage = globalThis.localStorage } = {}) {
  let cache = { list: null, sessions: {} };
  try { cache = { list: null, sessions: {}, ...JSON.parse(storage?.getItem(CACHE_KEY) || '{}') }; } catch { /* 坏了就从空的开始 */ }
  // 写副本合并成一次（切换对话、刷新时会连着改好几次）：少做大块的存储读写，手机上更稳
  let saveTimer = 0;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 800); };
  const writeNow = () => {
    // 存不下（手机存储满）就少存几段再试
    for (let n = CACHE_SESSIONS; n >= 0; n -= 4) {
      try {
        const keep = Object.entries(cache.sessions).sort((a, b) => (b[1].cachedAt ?? 0) - (a[1].cachedAt ?? 0)).slice(0, n);
        cache.sessions = Object.fromEntries(keep);
        storage?.setItem(CACHE_KEY, JSON.stringify(cache));
        return;
      } catch { /* 再少存一点 */ }
    }
  };
  const remember = (s) => {
    if (!s?.id) return s;
    const { taskId, taskReceipts, recoveryCheckpoints, ...rest } = s;
    cache.sessions[s.id] = { ...rest, messages: (s.messages ?? []).slice(-CACHE_MESSAGES), cachedAt: Date.now() };
    persist();
    return s;
  };
  // 切到后台（可能被系统杀掉）前把没写的副本写掉
  globalThis.addEventListener?.('pagehide', () => { clearTimeout(saveTimer); writeNow(); });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (globalThis.document.hidden) { clearTimeout(saveTimer); writeNow(); } });
  let listing = null; // 同时有好几处要列表（启动、抽屉、对话面板）：共用一次请求
  return {
    list() {
      listing ??= client.listSessions().then((rows) => {
        cache.list = rows.map(({ taskId, ...x }) => x);
        persist();
        return rows.map((x) => ({ ...x, messages: [] }));
      }).finally(() => { setTimeout(() => { listing = null; }, 1500); });
      return listing;
    },
    get: (id) => client.getSession(id).then((s) => (s ? remember(s) : (delete cache.sessions[id], persist(), s))),
    /** 副本里的列表 / 某段对话（没有就是 null），马上能拿到 */
    cachedList: () => cache.list?.map((x) => ({ ...x, messages: [] })) ?? null,
    cachedGet: (id) => (cache.sessions[id] ? { ...cache.sessions[id], cached: true } : null),
    /** 马上把副本写进存储（App 切到后台前用；平时攒一下再写） */
    flush: () => { clearTimeout(saveTimer); writeNow(); },
    save: async (s) => s,
    rename: (id, title) => client.patchSession(id, { title }).then((r) => { if (cache.sessions[id]) cache.sessions[id].title = title; listing = null; return r; }),
    setPinned: (id, pinned) => client.patchSession(id, { pinned }).then((r) => { listing = null; return r; }),
    remove: (id) => client.deleteSession(id).then((r) => { delete cache.sessions[id]; cache.list = cache.list?.filter((x) => x.id !== id) ?? null; persist(); listing = null; return r; }),
    searchContent: (q) => client.searchSessions(q),
    async search(query) {
      const q = String(query || '').trim().toLowerCase();
      const all = await this.list();
      return q ? all.filter((s) => String(s.title).toLowerCase().includes(q)) : all;
    }
  };
}
