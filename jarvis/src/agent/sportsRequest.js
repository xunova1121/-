import { withWebDeadline } from './lookup/request.js';
import { throwControl, httpError } from '../core/networkRequest.js';
import { retryAfterMs, retryWait, sleep } from '../llm/openai.js';

// 两个来源及唯一一次重试共用14秒，外层留1秒记录/交接，继续使用原40秒查询总时钟。
export const SPORTS_FETCH_MS = 14000;
export const SPORTS_OPERATION_MS = SPORTS_FETCH_MS + 1000;
export const SPORTS_SOURCES = { scores: '直播吧比分接口', schedule: '直播吧赛程页' };
const STAGES = ['request', 'body', 'parse', 'scope'];
const CODES = /^(?:HTTP_ERROR|RATE_LIMITED|BAD_FORMAT|SPORTS_PAGE_EMPTY|SPORTS_RANGE_EMPTY|SPORTS_TIMEOUT|SPORTS_NETWORK|SPORTS_READ_FAILED|PRIVATE_NETWORK_BLOCKED|REDIRECT_BLOCKED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

/** 只传固定来源、阶段、数值和已知错误码，不带URL、密钥、请求头或上游错误正文。 */
export function sportsDiagnostics(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && Object.values(SPORTS_SOURCES).includes(row.source) && CODES.test(row.code)).slice(-4).map(row => ({
    source: row.source, code: row.code,
    ...(STAGES.includes(row.stage) && { stage: row.stage }),
    ...(Number.isFinite(row.elapsedMs) && { elapsedMs: Math.max(0, Math.min(SPORTS_FETCH_MS, Math.round(row.elapsedMs))) }),
    ...(Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 && { status: row.status }),
    ...(typeof row.connected === 'boolean' && { connected: row.connected })
  }));
}

export function sportsFailureText(rows) {
  const stages = { request: '请求', body: '读取正文', parse: '解析', scope: '匹配范围' };
  return sportsDiagnostics(rows).map(row => `${row.source}：${stages[row.stage] || '读取'}${row.status && row.status >= 400 ? ` HTTP ${row.status}` : ` ${row.code}`}${row.elapsedMs != null ? `（${row.elapsedMs}毫秒）` : ''}`).join('；');
}

const transient = error => error.status != null ? error.status === 408 || error.status >= 500 && error.status <= 599
  : ['timeout', 'network'].includes(error.kind) || ['TimeoutError', 'NetworkError'].includes(error.name)
    || /^(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(error.code || error.cause?.code || '');

export function sportsHttpError(response, source) {
  return Object.assign(httpError(response.status, '', source), { retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after')) });
}

/** 每次实际出站前扣读取额度；备用源预留5秒，短暂故障全链最多重试一次。 */
export function createSportsRequests({ signal, retrieval, progress } = {}) {
  const started = performance.now();
  const failures = [];
  let retried = false;
  const left = () => Math.max(0, Math.min(SPORTS_FETCH_MS - (performance.now() - started), retrieval?.remaining ?? Infinity));
  const check = () => {
    throwControl(null, signal);
    if (retrieval?.remaining <= 0) throw Object.assign(new Error('本轮查询时间已用完'), { code: 'RETRIEVAL_BUDGET' });
  };
  function record(source, error, stage, elapsedMs, status) {
    const rawCode = error.code || error.cause?.code;
    const code = CODES.test(rawCode) ? rawCode : error.name === 'TimeoutError' ? 'SPORTS_TIMEOUT'
      : stage === 'parse' ? 'BAD_FORMAT' : transient(error) ? 'SPORTS_NETWORK' : 'SPORTS_READ_FAILED';
    const row = { source: SPORTS_SOURCES[source], code, stage, elapsedMs, status: error.status ?? status, connected: status >= 200 && status < 300 };
    failures.push(row);
    progress?.(sportsFailureText([row]));
  }
  return {
    failures,
    scope(source) { record(source, { code: 'SPORTS_RANGE_EMPTY' }, 'scope', 0, 200); },
    async read(source, work) {
      const reserve = source === 'scores' ? Math.min(5000, left() / 2) : 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        check();
        const timeoutMs = Math.min(source === 'scores' ? 8000 : 5000, left() - reserve);
        let stage = 'request', status;
        const at = performance.now();
        try {
          if (timeoutMs <= 0) throw Object.assign(new Error('赛程来源读取时间已用完'), { name: 'TimeoutError' });
          retrieval?.consume('read');
          const value = await withWebDeadline(s => work(s, (next, responseStatus) => {
            throwControl(null, s);
            stage = next;
            if (responseStatus != null) status = responseStatus;
          }), { signal, timeoutMs });
          check();
          return value;
        } catch (error) {
          throwControl(error, signal);
          record(source, error, stage, performance.now() - at, status);
          // Retry-After超过剩余额度时直接换源，不能截短服务商要求后立刻重试。
          const delayMs = Math.max(Number(error.retryAfterMs) || 0, retryWait(300, error));
          // 裸TypeError也可能是程序错误，只有明确的网络类型/底层连接码才原源重试。
          if (attempt || retried || !transient(error) || left() - reserve - delayMs < 1000) throw error;
          retried = true;
          progress?.(`${SPORTS_SOURCES[source]}临时连接失败，正在进行本轮唯一一次重试`);
          await sleep(delayMs, signal);
        }
      }
    },
    unavailable() {
      const sourceFailures = sportsDiagnostics(failures);
      return Object.assign(new Error(`${sportsFailureText(sourceFailures)}；可用 web_search（已配置的搜索）继续查询所需赛程/比分。`), {
        code: 'SPORTS_UNAVAILABLE', kind: sourceFailures.some(row => row.connected) ? 'data' : 'api',
        connected: sourceFailures.some(row => row.connected), sourceFailures
      });
    }
  };
}
