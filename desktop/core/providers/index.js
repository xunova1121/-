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

/** 取一个域名的可注册主域：files.metaso.cn → metaso.cn */
function registrableDomain(host) {
  const parts = String(host || '').split('.');
  // 够用就行：cn / com.cn 这种两段后缀也能覆盖，不引第三方公共后缀表
  const twoPart = ['com', 'net', 'org', 'gov', 'edu', 'co'];
  if (parts.length >= 3 && twoPart.includes(parts[parts.length - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/**
 * 这个下载地址属于哪一家？属于的话，就该带上它的密钥。
 *
 * 起因是秘塔：它给的视频地址在 files.metaso.cn 上，而且**取文件也要鉴权** ——
 * 不带密钥会拿到 {"errCode":401,…}，然后被当成 mp4 存下来。
 * 多数厂商给的是公网直链，所以不能无脑带；按主域匹配，
 * 只在"同一家的地址"上带，不会把密钥发给不相干的域名。
 */
export function providerForUrl(url) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  // IP 地址不做主域匹配：127.0.0.1:11434 和 127.0.0.1:8080 是两个不相干的服务，
  // 按"同主域"算会把密钥发给隔壁端口。IP 要求连端口一起完全一致。
  const isIp = /^\[?[0-9a-f:.]+\]?(:\d+)?$/i.test(host) && !/[a-z]/i.test(host.replace(/^\[|\]$/g, '').split(':')[0]);
  const domain = registrableDomain(host);

  return (
    PROVIDERS.find((p) => {
      const base = baseUrlOf(p);
      if (!base) return false;
      try {
        const baseHost = new URL(base).host;
        return isIp ? baseHost === host : registrableDomain(baseHost) === domain;
      } catch {
        return false;
      }
    }) || null
  );
}

/**
 * 指名道姓拿某一家的鉴权头。
 *
 * 比 authHeadersForUrl 靠谱：那一个是**从地址反推**是哪家，
 * 而调用方其实早就知道是哪家了。反推在两种情况下会错 ——
 * 几家共用一个网关地址（自检里就是这样），或者用了中转域名。
 * 猜错的后果是把头发错、或者干脆不发，而表现都是 401：
 * 一个让人去反复重建密钥的、最浪费时间的错。
 */
export function authHeadersFor(providerId) {
  const provider = getProvider(providerId);
  if (!provider) return {};
  try {
    return buildAuthHeaders(provider);
  } catch {
    return {};
  }
}

/** 下载这个地址时该带的鉴权头。不属于任何已配置的服务商就返回空。 */
export function authHeadersForUrl(url) {
  const provider = providerForUrl(url);
  if (!provider) return {};
  try {
    return buildAuthHeaders(provider);
  } catch {
    // 密钥没配齐就别硬塞一个半成品头过去
    return {};
  }
}

/**
 * 把异步任务的失败原因捞出来。
 *
 * 各家把它塞在不同地方，而且经常在对象**末尾** —— 直接截断 JSON 会正好切掉它。
 * 百炼：output.code / output.message；方舟：error.message；别家五花八门。
 */
export function failureReasonForTest(json) {
  return failureReason(json);
}

function failureReason(json) {
  const out = json?.output || json?.data || json || {};
  const code = out.code || json?.code || json?.error?.code || '';
  const message =
    out.message ||
    json?.message ||
    json?.error?.message ||
    out.task_status_msg ||
    '';
  if (!code && !message) return '';
  return [code, message].filter(Boolean).join(' — ');
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
        // 原因要排在最前面。
        // 早期版本直接甩 JSON.stringify(...).slice(0, 300)，而百炼把 code / message
        // 放在对象末尾 —— 一截就正好把最关键的那句话切掉，用户看到的是
        // 「…"message":"Field re」，等于什么都没说。
        const why = failureReason(res.json);
        throw new HttpError(
          `任务失败（${state}）${why ? `：${why}` : ''}\n完整响应：${JSON.stringify(res.json).slice(0, 600)}`
        );
      }
      return { done: false, value: res.json };
    },
    {
      intervalMs: settings.get('pollIntervalMs'),
      timeoutMs: settings.get('pollTimeoutMs'),
      // 取消时停轮询，但把任务号带出去 —— 它已经计费了，丢了号就白花
      signal: spec.pollSignal || null,
      taskId
    }
  );

  onEvent?.({ type: 'note', message: '任务完成' });
  return { submitted, polled: final, task: { id: taskId, url: pollUrl } };
}

/**
 * 自检请求体：把示例里的 model 换成用户实际路由到这家的模型。
 *
 * 关键是**只能换同一类的**。自检打的是哪个接口，就只认那一类的路由：
 * 绝大多数自检打的是对话接口，这时候只能替换对话/视觉模型。
 *
 * 早期版本把出图和视频的路由也算进来，于是出现这种事：
 * 百炼只被用来出图（比如 wanx2.1-i2v-turbo），自检却把这个模型名塞进
 * compatible-mode 的 chat 接口 —— 百炼当然回错，自检红了，
 * 可用户的配置一点毛病没有。猜错的自检比不自检更坏。
 *
 * 少数自检打的是别的接口（秘塔打的是视频提交），那种在目录里用
 * probe.capability 标出来，按对应的路由替换。
 */
const PROBE_ROUTES = {
  chat: [['chatProvider', 'chatModel'], ['directorProvider', 'directorModel'], ['visionProvider', 'visionModel']],
  video: [['videoProvider', 'videoModel']],
  image: [['imageProvider', 'imageModel']],
  tts: [['ttsProvider', 'ttsModel']]
};

function probeBody(provider) {
  const body = provider.probe?.body;
  if (!body || !body.model) return body;

  const s = settings.all();
  const routes = PROBE_ROUTES[provider.probe.capability || 'chat'] || PROBE_ROUTES.chat;
  const preferred = routes
    .map(([pk, mk]) => [s[pk], s[mk]])
    .find(([id, model]) => id === provider.id && model);

  return preferred ? { ...body, model: preferred[1] } : body;
}

/**
 * 把当前路由到的**几家**一次性探一遍。
 *
 * 这条和「上线前体检」是两件事，别混：
 *   体检   会真的出一张图、出一段视频 —— 花钱、慢，所以必须由人点；
 *   这一条 只发各家最便宜的那个探针（列模型 / max_tokens=1 / 列任务），
 *          不产出任何媒体，所以可以在**打开应用时自动跑**。
 *
 * 为什么值得自动跑：配置坏了的代价不是"自检红一下"，而是你兴冲冲跑到第 04 步、
 * 等了两分钟、才被告知密钥没配。**问题应该在你下手之前就摆在眼前。**
 *
 * 同一家被多个能力用到时只探一次 —— 探五遍同一个端点既慢又没意义。
 */
export async function probeRouting() {
  const s = settings.all();
  const caps = {
    chat: s.chatProvider,
    // 调度可以单配一家（挑技法、绑说话人、分章走它）。没配就是跟着剧本模型，
    // 那一档下面会被去重掉，不会白探一次
    director: s.directorProvider || s.chatProvider,
    vision: s.visionProvider,
    image: s.imageProvider,
    video: s.videoProvider,
    tts: s.ttsProvider
  };

  const unique = [...new Set(Object.values(caps).filter(Boolean))];
  const results = new Map();
  await Promise.all(
    unique.map(async (id) => {
      try {
        results.set(id, await probe(id));
      } catch (err) {
        results.set(id, { ok: false, reason: err.message });
      }
    })
  );

  const out = {};
  for (const [cap, providerId] of Object.entries(caps)) {
    if (!providerId) {
      out[cap] = { provider: null, ok: false, reason: '这一项还没选服务商' };
      continue;
    }
    const provider = getProvider(providerId);
    const r = results.get(providerId) || {};
    out[cap] = {
      provider: providerId,
      providerName: provider?.name || providerId,
      // 没定义探针的那几家不算失败 —— 它们只是没有便宜的接口可探
      ok: r.skipped ? null : Boolean(r.ok),
      skipped: Boolean(r.skipped),
      reason: r.reason || r.note || '',
      latencyMs: r.latencyMs ?? null,
      missing: r.missing || null
    };
  }
  return { checkedAt: new Date().toISOString(), capabilities: out };
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
      /**
       * "下不到你给的那张图" 值得单独说。
       *
       * 厂商原话是 `cannot download media URL (2013)` —— 它在抱怨**它自己**
       * 取不到我们给的地址，和请求体的字段结构一点关系都没有。
       * 只回一句"请求体不合法"，人会去翻参数、翻模型 ID、翻文档，全是白费。
       *
       * ⚠ 这个 2013 一度被我们当成"图带多了"，于是自动减半重试 ——
       * 减到 1 张照样失败（地址还是取不到），然后把"最多 1 张"记了下来。
       * 一个指错方向的判断，会让后面每一个补救动作都做在错的地方。
       */
      if (/cannot\s+download|download\s+media|下载.*(失败|不了)|取不到/i.test(said)) {
        return (
          `厂商那边**下载不到我们给的图**（400）。这不是参数问题 —— 它在说它打不开那个地址。\n` +
          `按可能性排序：\n` +
          `① 地址不是公网可达的（本地文件、内网地址、需要登录才能打开）；\n` +
          `② 用的是对象存储的**限时**地址，而它过期了 —— 「设置 → 对象存储」里把有效期调长，或者把桶设成公共读；\n` +
          `③ 桶是私有的，签名地址这家取不到 —— 同上；\n` +
          `④ 图太大或格式这家不收。\n` +
          `想当场确认：把那个地址复制到浏览器无痕窗口里打开，打不开就是这条。${tail}`
        );
      }
      return `请求体不合法（400）。${tail}`;
    default:
      if (res.status >= 500) return `服务端错误（${res.status}），通常重试即可。${tail}`;
      return `HTTP ${res.status}。${tail}`;
  }
}
