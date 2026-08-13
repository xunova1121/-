/**
 * 出站请求执行器 —— 联调台和所有模型适配器共用这一条通道。
 *
 * 统一在这里做四件事：占位符展开、超时、计时（TTFB / 总耗时）、脱敏留痕。
 * 好处是联调台里看到的请求，和 Studio 流水线真正发出去的请求，
 * 是同一段代码发的 —— "联调时能通，跑起来不通"这种事从结构上就少一半。
 */
import { expandSecrets } from './vault.js';
import * as logbus from './logbus.js';

export const DEFAULT_TIMEOUT_MS = 120000;

export class HttpError extends Error {
  constructor(message, { status, bodyText, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = bodyText;
    this.url = url;
  }
}

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

function looksLikeSSE(contentType, explicit) {
  const ct = contentType || '';
  if (/text\/event-stream/i.test(ct)) return true;
  if (explicit === false) return false;
  // 勾了"流式"但服务端明确回了 JSON（通常是报错响应），按 JSON 读，别硬当 SSE 解
  return explicit === true && !/application\/json/i.test(ct);
}

/**
 * 增量式 SSE 解析。不能简单按 \n\n 切整份文本 —— 流式响应本来就是一段段到的，
 * 必须留住半截事件等下一个 chunk 补齐。
 */
export function createSSEParser(onEvent) {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      const sep = /\r?\n\r?\n/g;
      let m;
      sep.lastIndex = 0;
      while ((m = sep.exec(buffer)) !== null) {
        const rawEvent = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        sep.lastIndex = 0;
        const ev = { event: 'message', data: '', id: null };
        const dataLines = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue; // 注释行 / 心跳
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') dataLines.push(value);
          else if (field === 'event') ev.event = value;
          else if (field === 'id') ev.id = value;
        }
        ev.data = dataLines.join('\n');
        if (ev.data !== '' || ev.event !== 'message') onEvent(ev);
      }
    },
    flush() {
      if (buffer.trim()) {
        onEvent({ event: 'message', data: buffer.trim(), id: null, partial: true });
        buffer = '';
      }
    }
  };
}

/**
 * 从 OpenAI 兼容的流式分片里抠出正文增量。
 * DashScope 兼容模式、MuleRun 走的都是这个结构。
 */
export function extractDelta(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return '';
  return choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
}

/**
 * 执行一次请求。
 *
 * @param {object} spec
 * @param {string} spec.url
 * @param {string} [spec.method='GET']
 * @param {object} [spec.headers]
 * @param {string|object} [spec.body]
 * @param {boolean} [spec.stream]        强制按 SSE 解析（不传则看 Content-Type）
 * @param {number}  [spec.timeoutMs]
 * @param {string}  [spec.provider]      仅用于日志分组
 * @param {string}  [spec.label]         仅用于日志展示
 * @param {(ev:object)=>void} [onEvent]  流式回调：{type:'meta'|'sse'|'text'|'done'}
 */
export async function execute(spec, onEvent) {
  const method = (spec.method || 'GET').toUpperCase();
  const url = expandSecrets(spec.url);
  const rawHeaders = spec.headers || {};

  const sentHeaders = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === null || v === undefined || v === '') continue;
    sentHeaders[k] = expandSecrets(String(v));
  }

  let bodyText;
  if (spec.body !== null && spec.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    bodyText = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body, null, 2);
    bodyText = expandSecrets(bodyText);
    if (!Object.keys(sentHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      sentHeaders['Content-Type'] = 'application/json';
    }
  }

  const controller = new AbortController();
  const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (spec.signal) {
    if (spec.signal.aborted) controller.abort();
    else spec.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const startedAt = Date.now();
  // 留痕用的是原始 spec（占位符没展开）+ 脱敏后的头，明文密钥不进历史
  const logDraft = {
    provider: spec.provider || 'custom',
    label: spec.label || '',
    method,
    url: spec.url,
    requestHeaders: logbus.redactHeaders(rawHeaders),
    requestBody: logbus.redactBody(spec.body ?? null)
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: sentHeaders,
      body: bodyText,
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === 'AbortError';
    const message = aborted
      ? `请求超时（${timeoutMs}ms 未返回）`
      : `连接失败：${err.cause?.code || err.message}`;
    const entry = logbus.record({
      ...logDraft,
      status: 0,
      ok: false,
      error: message,
      totalMs: Date.now() - startedAt
    });
    onEvent?.({ type: 'error', message, logId: entry.id });
    throw new HttpError(message, { url });
  }

  const ttfbMs = Date.now() - startedAt;
  const responseHeaders = headersToObject(response.headers);
  const contentType = responseHeaders['content-type'] || '';
  onEvent?.({
    type: 'meta',
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    ttfbMs
  });

  const isSSE = looksLikeSSE(contentType, spec.stream);
  const events = [];
  let raw = '';
  let assembled = '';
  let bytes = 0;

  try {
    if (response.body) {
      const decoder = new TextDecoder('utf-8');
      const parser = isSSE
        ? createSSEParser((ev) => {
            events.push(ev);
            let delta = '';
            if (ev.data && ev.data !== '[DONE]') {
              try {
                delta = extractDelta(JSON.parse(ev.data));
              } catch {
                delta = ''; // 不是 JSON 就当纯事件，原样留在 events 里
              }
            }
            if (delta) assembled += delta;
            onEvent?.({ type: 'sse', event: ev.event, data: ev.data, delta });
          })
        : null;

      for await (const chunk of response.body) {
        bytes += chunk.length ?? chunk.byteLength ?? 0;
        const text = decoder.decode(chunk, { stream: true });
        raw += text;
        if (parser) parser.push(text);
        else onEvent?.({ type: 'text', text });
      }
      const tail = decoder.decode();
      if (tail) {
        raw += tail;
        if (parser) parser.push(tail);
        else onEvent?.({ type: 'text', text: tail });
      }
      parser?.flush();
    }
  } catch (err) {
    clearTimeout(timer);
    const message =
      err.name === 'AbortError' ? `响应读取超时（${timeoutMs}ms）` : `响应读取中断：${err.message}`;
    const entry = logbus.record({
      ...logDraft,
      status: response.status,
      ok: false,
      error: message,
      ttfbMs,
      totalMs: Date.now() - startedAt,
      responseHeaders,
      responseBody: logbus.redactBody(raw)
    });
    onEvent?.({ type: 'error', message, logId: entry.id });
    throw new HttpError(message, { status: response.status, bodyText: raw, url });
  }
  clearTimeout(timer);

  const totalMs = Date.now() - startedAt;
  let json = null;
  if (!isSSE && raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null; // 非 JSON（HTML 错误页、纯文本）保持 null，raw 里看得到
    }
  }

  const entry = logbus.record({
    ...logDraft,
    status: response.status,
    ok: response.ok,
    ttfbMs,
    totalMs,
    bytes,
    stream: isSSE,
    responseHeaders,
    responseBody: logbus.redactBody(isSSE ? assembled || raw : json ?? raw)
  });

  const result = {
    logId: entry.id,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    raw,
    json,
    text: isSSE ? assembled : raw,
    events,
    stream: isSSE,
    ttfbMs,
    totalMs,
    bytes
  };
  onEvent?.({ type: 'done', ...result, raw: undefined, events: undefined });
  return result;
}

/** 适配器里用：非 2xx 直接抛，省得每个调用点都写一遍 if (!ok) */
export async function executeJSON(spec) {
  const res = await execute(spec);
  if (!res.ok) {
    const detail =
      res.json?.message || res.json?.error?.message || res.json?.msg || res.raw?.slice(0, 400) || '';
    throw new HttpError(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, {
      status: res.status,
      bodyText: res.raw,
      url: spec.url
    });
  }
  return res.json ?? res.raw;
}

/** 轮询直到任务终态。国内这几家视频模型清一色是"提交 → 轮询"，抽出来复用。 */
export async function poll(fn, { intervalMs = 3000, timeoutMs = 600000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const { done, value } = await fn(attempt);
    if (done) return value;
    onTick?.({ attempt, value, elapsedMs: timeoutMs - (deadline - Date.now()) });
    if (Date.now() >= deadline) {
      throw new HttpError(`任务轮询超时（${Math.round(timeoutMs / 1000)}s），最后状态：${JSON.stringify(value).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
