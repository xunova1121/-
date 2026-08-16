/**
 * 出站请求执行器 —— 联调台和所有模型适配器共用这一条通道。
 *
 * 统一在这里做四件事：占位符展开、超时、计时（TTFB / 总耗时）、脱敏留痕。
 * 好处是联调台里看到的请求，和 Studio 流水线真正发出去的请求，
 * 是同一段代码发的 —— "联调时能通，跑起来不通"这种事从结构上就少一半。
 */
import { expandSecrets } from './vault.js';
import * as logbus from './logbus.js';
import * as settings from './settings.js';

/**
 * Electron 的 net.fetch 走的是 Chromium 的网络栈，**会读 Windows 的系统代理设置**；
 * Node 自带的 fetch 不读，一律直连。公司网络必须走代理时，直连就是连不上
 * （报 UND_ERR_CONNECT_TIMEOUT），而这跟密钥、模型一点关系都没有。
 *
 * 桌面版启动时会把它注进来，但**默认不用** —— 换网络栈是件有风险的事，
 * 只在「设置 → 使用系统代理」打开时才切过去。命令行模式下没有它，保持直连。
 */
let electronFetch = null;
export function attachElectronFetch(fn) {
  if (typeof fn === 'function') electronFetch = fn;
}
export function fetchImpl() {
  return settings.get('useSystemProxy') && electronFetch ? electronFetch : globalThis.fetch;
}
export function systemProxyAvailable() {
  return Boolean(electronFetch);
}

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

/**
 * 网络层错误翻译成人话。
 *
 * 这一层的报错和"接口报错"完全是两回事：连都没连上，密钥、模型、参数一个都不沾边。
 * 光甩一句 `连接失败：UND_ERR_CONNECT_TIMEOUT` 等于什么都没说 ——
 * 用户会去翻密钥、换模型，全是白费。
 */
export function explainNetworkError(err, url = '') {
  const code = err?.cause?.code || err?.code || '';
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* url 本身就不合法的话，下面照样有话说 */
  }
  const where = host ? `「${host}」` : '这个地址';

  switch (code) {
    case 'UND_ERR_CONNECT_TIMEOUT':
      return (
        `连不上${where}（TCP 连接超时）。和密钥、模型都没关系 —— 请求根本没发出去。\n` +
        `依次试：① 浏览器打开 https://${host || '该域名'} 看看通不通；` +
        `② 通但应用连不上，多半是公司网络要走代理，Windows 上给启动脚本设 HTTPS_PROXY 环境变量；` +
        `③ 浏览器也不通，就是这台机器到这个域名的网络被挡了，换网络或改用同一家的其他接入点。`
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `域名解析不了${where}。检查网线/WiFi、DNS，以及接口根地址有没有写错（多打一个空格、少个字母都会这样）。`;
    case 'ECONNREFUSED':
      return `${where} 拒绝连接。地址或端口写错的可能性最大；如果是本地模型（Ollama/LM Studio），先确认它已经起来了。`;
    case 'ECONNRESET':
      return `连接被对方掐断（${where}）。常见于代理/防火墙中途拦截，或对方限流。重试一次看看是不是偶发。`;
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `HTTPS 证书验证不过（${code}）。多半是公司网络在做流量审计，需要把它的根证书装进系统信任库。`;
    default:
      return `连接失败：${code || err?.message || '未知网络错误'}${host ? `（${host}）` : ''}`;
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
  /**
   * 超时要**跟着请求体大小走**。
   *
   * 固定 60 秒对一个 2KB 的 JSON 是宽松的，对一个 40MB 的请求体是荒谬的 ——
   * 后者光上传就不止 60 秒。而失败的样子是"请求超时（60000ms 未返回）"，
   * 完全看不出是**体积**问题：人会去查网络、查厂商、查模型，
   * 而真正该做的是别把九张图内联成 base64 发出去。
   *
   * 这个坑是自己挖的：参考图上限从 3 张提到 9 张之后，一旦那些图走的是
   * 内联 base64（没配对象存储时的兜底），请求体直接涨三倍。
   *
   * 按 100KB/s 这个很保守的有效上行估算给额外时间，最多加到 5 分钟 ——
   * 再长就不是"慢"而是"卡死"了，该让它失败。
   */
  const bodyBytes = bodyText ? Buffer.byteLength(bodyText) : 0;
  const baseTimeout = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(300000, baseTimeout + Math.round(bodyBytes / 100));
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
    response = await fetchImpl()(url, {
      method,
      headers: sentHeaders,
      body: bodyText,
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === 'AbortError';
    /**
     * 超时报错必须带上**发了多大**。
     *
     * "请求超时（60000ms 未返回）"这句话对排错毫无帮助 —— 它没说是网络慢、
     * 厂商卡住、还是我们自己塞了 40MB 过去。把体积印出来，第三种情况
     * 一眼就认得出（而它恰恰是最常见、也最容易改的那一种）。
     */
    const mb = bodyBytes / 1048576;
    const sizeHint = bodyBytes > 2 * 1048576
      ? `。这次发了 ${mb.toFixed(1)}MB —— 多半是参考图被内联成 base64 了。` +
        `去「设置 → 对象存储」配一个，图就会以地址的形式发出去，请求体只有几 KB`
      : '';
    const message = aborted
      ? `请求超时（${timeoutMs}ms 未返回）${sizeHint}`
      : explainNetworkError(err, url);
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
