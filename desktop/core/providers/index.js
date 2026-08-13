/**
 * 服务商运行时：解析模板 → 补鉴权 → 发请求 →（异步任务的话）轮询到终态。
 */
import { PROVIDERS, getProvider, publicCatalog, CAPABILITIES } from './catalog.js';
import { buildAuthHeaders, credentialStatus, AuthError } from './auth.js';
import { getSecret } from '../vault.js';
import { execute, poll, HttpError } from '../http-client.js';
import * as settings from '../settings.js';

export { PROVIDERS, getProvider, CAPABILITIES, AuthError, credentialStatus };

export function baseUrlOf(provider) {
  const override = settings.get('baseUrls')?.[provider.id];
  return (override || provider.baseUrl || '').replace(/\/+$/, '');
}

/** 目录 + 每家的凭据配齐状态，一次给前端 */
export function catalogForUI() {
  const overrides = {};
  for (const p of PROVIDERS) overrides[p.id] = { baseUrl: baseUrlOf(p) };
  return publicCatalog(overrides).map((p) => ({
    ...p,
    credentials: credentialStatus(getProvider(p.id))
  }));
}

/** 把 {{baseUrl}} 之类的结构占位符展开（密钥占位符留给发送时展开） */
export function interpolate(text, provider, vars = {}) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{\s*baseUrl\s*\}\}/g, baseUrlOf(provider)).replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
    (whole, name) => (name in vars ? String(vars[name]) : whole)
  );
}

/**
 * 生成一份可以直接丢进联调台编辑器的请求草稿。
 * 鉴权头用占位符形式，界面上看得见"这里会带什么"，但看不到密钥本身。
 */
export function draftFromTemplate(providerId, templateId, vars = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  const tpl = (provider.templates || []).find((t) => t.id === templateId) || provider.templates?.[0];
  if (!tpl) throw new Error(`${provider.name} 没有可用模板`);

  return {
    provider: provider.id,
    label: tpl.label,
    method: tpl.method || 'POST',
    url: interpolate(tpl.url, provider, vars),
    headers: { ...buildAuthHeaders(provider, { placeholder: true }), ...(tpl.headers || {}) },
    body: tpl.body ? JSON.stringify(tpl.body, null, 2) : '',
    stream: Boolean(tpl.stream),
    async: Boolean(tpl.async),
    capability: tpl.capability || null
  };
}

/**
 * 发送一个联调台请求。
 *
 * headers 里如果已经带了 Authorization（用户手写或从模板带来的占位符），
 * 就按用户写的来 —— 占位符形式的会在这里换成真家伙。
 */
export async function send(spec, onEvent) {
  const provider = getProvider(spec.provider);
  const headers = { ...(spec.headers || {}) };

  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  const authValue = authKey ? String(headers[authKey]) : '';

  // 三种情况要区分清楚，早期版本把它们混成一种，导致手写的 {{占位符}} 被整个删掉：
  //   {{NAME}}  用户/模板写的密钥占位符 → 原样留着，发送时由保险箱展开
  //   <...>     我们自己塞的说明性占位（如"本地签发的 JWT"）→ 现算替换
  //   空        没写鉴权头 → 按服务商规则补上
  const secretRefs = [...authValue.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]);
  const isGeneratedHint = /<[^>]+>/.test(authValue);

  if (provider && (!authValue || isGeneratedHint)) {
    if (authKey) delete headers[authKey];
    Object.assign(headers, buildAuthHeaders(provider));
  } else if (secretRefs.length) {
    // 占位符指向的密钥没配的话，与其让服务端回一个语焉不详的 401，不如当场说清楚
    const missing = secretRefs.filter((name) => !getSecret(name));
    if (missing.length) {
      throw new AuthError(`缺少凭据：${missing.join('、')}，请到「服务商与密钥」里填好`, missing);
    }
  }

  const timeoutMs = Number(spec.timeoutMs) || settings.get('requestTimeoutMs');
  return execute(
    {
      provider: spec.provider || 'custom',
      label: spec.label || '',
      method: spec.method,
      url: provider ? interpolate(spec.url, provider) : spec.url,
      headers,
      body: spec.body,
      stream: spec.stream,
      timeoutMs
    },
    onEvent
  );
}

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * 提交异步任务并轮询到终态。
 * 国内这几家视频模型全是这个套路，差别只在字段名，所以字段名写在 catalog 里。
 */
export async function sendAsync(spec, onEvent) {
  const provider = getProvider(spec.provider);
  const cfg = provider?.taskPoll;
  const submitted = await send(spec, onEvent);

  if (!cfg || !submitted.ok) return { submitted, polled: null, task: null };

  const taskId = getByPath(submitted.json, cfg.idPath);
  if (!taskId) {
    onEvent?.({ type: 'note', message: `响应里没找到任务 ID（期望路径 ${cfg.idPath}），不再轮询` });
    return { submitted, polled: null, task: null };
  }

  onEvent?.({ type: 'note', message: `任务已提交：${taskId}，开始轮询…` });

  const pollUrl = interpolate(cfg.url, provider).replace('{taskId}', encodeURIComponent(taskId));
  const success = new Set((cfg.successStates || []).map((s) => s.toLowerCase()));
  const failure = new Set((cfg.failureStates || []).map((s) => s.toLowerCase()));

  const final = await poll(
    async (attempt) => {
      const res = await send(
        { provider: spec.provider, method: cfg.method || 'GET', url: pollUrl, label: `轮询 #${attempt}` },
        null
      );
      const state = String(getByPath(res.json, cfg.statusPath) ?? '').toLowerCase();
      onEvent?.({ type: 'poll', attempt, state, status: res.status });
      if (success.has(state)) return { done: true, value: res };
      if (failure.has(state)) {
        throw new HttpError(`任务失败：${state} — ${JSON.stringify(res.json).slice(0, 300)}`);
      }
      return { done: false, value: res.json };
    },
    {
      intervalMs: settings.get('pollIntervalMs'),
      timeoutMs: settings.get('pollTimeoutMs')
    }
  );

  onEvent?.({ type: 'note', message: '任务完成' });
  return { submitted, polled: final, task: { id: taskId, url: pollUrl } };
}

/**
 * 自检请求体：把示例里的 model 换成用户实际路由到这家的模型。
 * 一家可能承担多种能力（剧本 + 出图 + 视频），优先用对话类的，
 * 因为自检发的就是一次最小对话。
 */
function probeBody(provider) {
  const body = provider.probe?.body;
  if (!body || !body.model) return body;

  const s = settings.all();
  const preferred = [
    [s.chatProvider, s.chatModel],
    [s.visionProvider, s.visionModel],
    [s.imageProvider, s.imageModel],
    [s.videoProvider, s.videoModel]
  ].find(([id, model]) => id === provider.id && model);

  return preferred ? { ...body, model: preferred[1] } : body;
}

/** 一键自检：这家配通了没 */
export async function probe(providerId) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  if (!provider.probe) return { skipped: true, reason: '该服务商未定义自检请求' };

  const cred = credentialStatus(provider);
  if (!cred.ready) {
    return { ok: false, reason: `缺少凭据：${cred.missing.join('、')}`, missing: cred.missing };
  }

  // 自检要测"你真正会用到的那个模型"，而不是目录里写死的示例。
  // 否则会出现"自检不过但其实能用"，或者更糟的"自检过了但生产用的模型根本不存在"。
  const body = probeBody(provider);

  const started = Date.now();
  try {
    const res = await send(
      {
        provider: provider.id,
        label: '连通性自检',
        method: provider.probe.method,
        url: interpolate(provider.probe.url, provider),
        body,
        timeoutMs: 20000
      },
      null
    );
    // 有些服务商没有便宜的接口可探，自检就故意发一个缺参数的请求。
    // 这种情况下 400/422 恰恰说明"鉴权过了、路径对了"，只是参数不全 ——
    // 判成失败会让用户白白去查一个根本不存在的问题。
    const paramErrorOk =
      provider.probe.paramErrorMeansOk && (res.status === 400 || res.status === 422);
    const ok = res.ok || paramErrorOk;

    return {
      ok,
      status: res.status,
      model: body?.model || null,
      latencyMs: Date.now() - started,
      logId: res.logId,
      note: paramErrorOk
        ? `鉴权与路径都正常（服务端只是在挑参数：${
            res.json?.base_resp?.status_msg || res.json?.message || res.json?.error?.message || `HTTP ${res.status}`
          }）`
        : '',
      reason: ok ? '' : diagnose(res)
    };
  } catch (err) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, reason: err.message };
  }
}

/**
 * 把常见的失败翻译成人话。联调最费时间的从来不是发请求，是看懂为什么不通。
 */
export function diagnose(res) {
  const body = res.json ? JSON.stringify(res.json) : String(res.raw || '');
  const code = res.json?.code || res.json?.error?.code || '';
  // 服务端自己说的话永远比我们的猜测准，务必带上。
  // 早期版本把 404 一律解释成"baseUrl 少了 /v1"，结果火山方舟"模型不存在"也回 404，
  // 用户照着提示去改 baseUrl，越改越错 —— 猜错的提示比不提示更坏。
  const said =
    res.json?.error?.message || res.json?.message || res.json?.msg || body.slice(0, 240) || '';
  const tail = said ? `\n服务端原话：${said}` : '';

  switch (res.status) {
    case 401:
      return `API Key 无效或未生效（401）。检查密钥有没有复制到多余空格，以及是不是填到了别家服务商的卡片里。${tail}`;
    case 403:
      return `没有权限（403）。常见原因：模型未开通、账号欠费、或该地域不支持。${code ? `服务端码：${code}。` : ''}${tail}`;
    case 404:
      // 按可能性排序：模型 ID 写错远比 baseUrl 写错常见，尤其是方舟这种要填推理接入点的
      return /model|endpoint|ep-/i.test(said)
        ? `模型或推理接入点不存在（404）。到「设置 → 能力路由」把模型改成你控制台里真实存在的 ID —— 火山方舟通常是 ep- 开头的推理接入点，或带版本号的完整模型名。${tail}`
        : `路径不存在（404）。两种可能：① 模型 ID 在你账号下不存在；② baseUrl 末尾多了或少了 /v1。${tail}`;
    case 429:
      return `限流（429）。降低并发，或在「设置」里把轮询间隔调大。${tail}`;
    case 400:
      return `请求体不合法（400）。${tail}`;
    default:
      if (res.status >= 500) return `服务端错误（${res.status}），通常重试即可。${tail}`;
      return `HTTP ${res.status}。${tail}`;
  }
}
