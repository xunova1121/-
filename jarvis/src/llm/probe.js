/**
 * 连接诊断：先请求服务商的 /models（不生成内容，几秒就有结果），把“网络不通 / 地址不对 / 密钥不对 / 型号不存在”分开说清楚，
 * 再由调用方做一次真正的对话测试。
 */

/** 按型号名找相近的几个（同前缀、去掉横杠后包含） */
export function similarModels(ids, model, k = 5) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const m = norm(model);
  const head = m.slice(0, Math.max(3, Math.min(6, m.length)));
  return ids.filter((id) => norm(id).includes(head) || m.includes(norm(id))).slice(0, k);
}

/**
 * @param {{ baseURL: string, apiKey?: string, model?: string, headers?: object, fetchImpl?: typeof fetch, timeoutMs?: number }} o
 * @returns {Promise<{ ok: boolean, step: 'network'|'url'|'key'|'model'|'http'|'done', status?: number, message: string, ms: number, models?: string[] }>}
 */
export async function probeEndpoint({ baseURL, apiKey = '', model = '', headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 15000, now = () => Date.now() }) {
  const t0 = now();
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  const done = (r) => ({ ...r, ms: now() - t0 });
  if (!/^https?:\/\//i.test(base)) return done({ ok: false, step: 'url', message: `接口地址要以 http:// 或 https:// 开头：${base || '（空）'}` });
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    res = await fetchImpl(`${base}/models`, { headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, signal: ctrl.signal });
  } catch (e) {
    const timeout = e?.name === 'AbortError';
    return done({ ok: false, step: 'network', message: timeout ? `连接接口地址 ${timeoutMs / 1000} 秒没有响应（网络不通，或服务商暂时不可用）` : `连不上接口地址（网络不通或地址写错）：${e?.message || e}` });
  } finally { clearTimeout(timer); }
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) return done({ ok: false, step: 'key', status: res.status, message: `API Key 不对或没有权限（HTTP ${res.status}）${brief(text)}` });
  if (res.status === 404) return done({ ok: false, step: 'url', status: 404, message: `接口地址不对：${base}/models 不存在（多数服务商的地址以 /v1 结尾）` });
  if (!res.ok) return done({ ok: false, step: 'http', status: res.status, message: `服务商返回 HTTP ${res.status}${brief(text)}` });
  let ids = [];
  try { ids = (JSON.parse(text).data || []).map((m) => m.id).filter(Boolean); } catch { /* 有的服务商不提供列表 */ }
  if (model && ids.length && !ids.includes(model)) {
    const near = similarModels(ids, model);
    return done({ ok: false, step: 'model', status: 200, models: ids, message: `接口和密钥都正常，但服务商的模型列表里没有“${model}”${near.length ? `，相近的有：${near.join('、')}` : `（共 ${ids.length} 个模型，可点“读取模型列表并推荐”查看）`}` });
  }
  return done({ ok: true, step: 'done', status: res.status, models: ids, message: ids.length ? `接口、密钥正常（${ids.length} 个可用模型）` : '接口、密钥正常' });
}

const brief = (t) => {
  let msg = '';
  try { const j = JSON.parse(t); msg = j.error?.message || j.message || j.error || ''; } catch { msg = String(t || '').replace(/<[^>]+>/g, ' ').trim(); }
  msg = String(msg).replace(/\s+/g, ' ').slice(0, 120);
  return msg ? `：${msg}` : '';
};
