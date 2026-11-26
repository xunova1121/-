/**
 * 服务器任务一步建流：发消息时直接在同一条 POST 连接上收 SSE 进度和首字，省去第二趟 GET 往返。
 * 旧服务器返回普通 JSON、中途断网或回到前台时，无缝交回原有的按序号续接逻辑（followTask），不丢进度、不重复提交。
 */
import { onServerResume } from './serverResume.js';

const abortedError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** 当前运行环境能否对 POST 响应边收边读（旧安卓壳无 NativeStream 插件时仍走两步） */
export function canStreamTaskStart(g = globalThis) {
  if (g.Capacitor?.isNativePlatform?.() && !g.Capacitor?.isPluginAvailable?.('NativeStream')) return false;
  return true;
}

async function readInitialTaskStream(res, { client, parseSse, firstMs, attempt, closeStream, signal, onStarted, onEvent, state }) {
  const reader = res.body.getReader();
  state.reader = reader;
  const firstTimer = setTimeout(() => {
    if (!state.gotFrame) {
      client.streamFailed?.();
      closeStream();
    }
  }, firstMs);
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (attempt.signal.aborted || done) break;
      const input = buf + dec.decode(value, { stream: true });
      const { events, rest } = parseSse(input);
      buf = rest;
      if (events.length || /(?:^|\n):[^\n]*\n/.test(input)) {
        state.gotFrame = true;
        clearTimeout(firstTimer);
      }
      for (const ev of events) {
        if (ev.type === 'task_created' && ev.id) {
          state.task = { id: ev.id, sessionId: ev.sessionId };
          if (signal?.aborted) {
            await client.stopTask(state.task.id).catch(() => {});
            throw abortedError();
          }
          if (!state.startedNotified) {
            state.startedNotified = true;
            await onStarted?.(state.task);
          }
          if (signal?.aborted) {
            await client.stopTask(state.task.id).catch(() => {});
            throw abortedError();
          }
          continue;
        }
        if (!Number.isFinite(ev.seq) || ev.seq <= state.last) continue;
        state.last = ev.seq;
        onEvent?.(ev);
        if (ev.type === 'task_state' && ['done', 'error', 'stopped'].includes(ev.status)) {
          return { mode: 'done', task: state.task, end: ev };
        }
      }
    }
    return null;
  } finally {
    clearTimeout(firstTimer);
    reader.cancel().catch(() => {});
  }
}

/**
 * @returns {Promise<{ mode: 'done', task: object, end: object } | { mode: 'follow', task: object, after: number, startedNotified?: boolean }>}
 */
export async function startAndStreamTask(client, body, { parseSse, firstMs, signal, onStarted, onEvent, subscribeResume = onServerResume }) {
  if (signal?.aborted) throw abortedError();
  const attempt = new AbortController();
  const state = { reader: null, task: null, last: 0, gotFrame: false, startedNotified: false };
  const closeStream = () => {
    attempt.abort();
    state.reader?.cancel().catch(() => {});
  };
  const onAbort = () => {
    if (!state.task?.id) return; // 尚未拿到任务编号时不提前掐断响应头，拿到编号后立刻通知服务器停止
    client.stopTask(state.task.id).catch(() => {});
    closeStream();
  };
  signal?.addEventListener('abort', onAbort);
  const unwatchResume = subscribeResume(() => {
    if (state.task?.id) closeStream();
  });
  let opened;
  try {
    opened = await client.startTaskStream(body, attempt.signal);
  } catch (err) {
    signal?.removeEventListener('abort', onAbort);
    unwatchResume?.();
    if (signal?.aborted) throw abortedError();
    if (err?.status) throw err;
    // 首包超时或连接未建立：仅当服务器支持按 requestId 去重时才重发，旧服务器绝不重复提交
    const fallbackTask = await client.retryStartTask(err?.taskPayload || body, err);
    return { mode: 'follow', task: fallbackTask, after: 0 };
  }
  const { res, payload } = opened;
  try {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(
        new Error(res.status === 401 ? '服务器登录已失效，请到 设置 → 服务器模式 重新登录' : data.error || `服务器返回 ${res.status}`),
        { status: res.status, ...(data.code && { code: data.code }), ...(data.kind && { kind: data.kind }), ...(data.upstreamStatus && { upstreamStatus: data.upstreamStatus }) }
      );
    }
    const contentType = String(res.headers?.get?.('content-type') || '');
    if (!/text\/event-stream/i.test(contentType) || !res.body) {
      state.task = await res.json();
      return { mode: 'follow', task: state.task, after: 0 };
    }
    const done = await readInitialTaskStream(res, { client, parseSse, firstMs, attempt, closeStream, signal, onStarted, onEvent, state });
    if (done) return done;
  } catch (err) {
    if (signal?.aborted) {
      if (state.task?.id) await client.stopTask(state.task.id).catch(() => {});
      throw abortedError();
    }
    if (err?.status) throw err;
    if (!state.gotFrame) client.streamFailed?.();
  } finally {
    unwatchResume?.();
    signal?.removeEventListener('abort', onAbort);
    attempt.abort();
  }
  if (signal?.aborted) {
    if (state.task?.id) await client.stopTask(state.task.id).catch(() => {});
    throw abortedError();
  }
  if (state.task?.id) return { mode: 'follow', task: state.task, after: state.last, startedNotified: state.startedNotified };
  const fallbackTask = await client.retryStartTask(payload, new TypeError('任务流未返回任务编号'));
  return { mode: 'follow', task: fallbackTask, after: 0 };
}
