/**
 * 模型配置（只存在这台电脑的浏览器 localStorage 里）与适配器工厂。
 * 有本机网关（完整版）时请求经网关转发：没有浏览器跨域限制，也可以用网关环境变量里的密钥。
 */
import { PROVIDERS, providerById, upstreamFor, customViaGateway } from '../../shared/providers.js';
import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createResponsesAdapter } from './responses.js';
import { createMockAdapter } from './mock.js';
import { selectVoiceEngine } from '../perception/voiceSelection.js';
import { GENTLE_VOICES } from '../perception/voiceProfile.js';

const KEY = 'jarvis.llm.v1';
const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();

/** 语音：engine 为 auto 时按已有密钥自动挑最自然的云端声音，都没有就用浏览器自带 */
export const DEFAULT_VOICE = { engine: 'auto', voices: GENTLE_VOICES, profile: 'gentle-child', fx: 'gentle', cues: true, browserVoice: '', customURL: '', customModel: '', customVoice: '', azureRegion: '', qwenRegion: 'beijing', providerModel: 'gpt-4o-mini-tts' };
export const DEFAULT_STT = { engine: 'auto', customURL: '', customModel: '' };
export const DEFAULT_CONFIG = { provider: 'mock', models: {}, keys: {}, baseURLs: {}, claudeWebSearch: true, tavilyKey: '', bochaKey: '', deepseekSearchEnabled: false, deepseekSearchKey: '', falKey: '', voice: DEFAULT_VOICE, stt: DEFAULT_STT };

export function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try { Object.assign(cfg, JSON.parse(store?.getItem(KEY) || '{}')); } catch { /* 损坏时用默认 */ }
  // 旧版单文件版只存了一个 Claude 密钥：迁移过来
  try {
    const old = store?.getItem('jarvis.claudeKey');
    if (old && !cfg.keys.anthropic) {
      cfg.keys = { ...cfg.keys, anthropic: old };
      if (cfg.provider === 'mock') cfg.provider = 'anthropic';
      store.removeItem('jarvis.claudeKey');
      saveConfig(cfg);
    }
  } catch { /* ignore */ }
  if (!providerById(cfg.provider)) cfg.provider = 'mock';
  const oldVoice = cfg.voice || {};
  const wasDefault = !oldVoice.profile && !oldVoice.browserVoice && !Object.keys(oldVoice.voices || {}).length;
  cfg.voice = { ...DEFAULT_VOICE, ...oldVoice, ...(wasDefault && oldVoice.fx === 'jarvis' ? { fx: 'gentle' } : {}), voices: { ...GENTLE_VOICES, ...(oldVoice.voices || {}) } };
  if (oldVoice.profile === 'gentle-child' && oldVoice.voices?.openai === 'nova') cfg.voice.voices.openai = GENTLE_VOICES.openai;
  if (oldVoice.profile === 'gentle-child' && oldVoice.voices?.edge === 'zh-CN-YunxiaNeural') cfg.voice.voices.edge = GENTLE_VOICES.edge;
  cfg.stt = { ...DEFAULT_STT, ...(cfg.stt || {}) };
  return cfg;
}

/** 保存；记下修改时间，多设备同步时用来判断哪边更新（同步写回时沿用对方的时间） */
export function saveConfig(cfg, { fromSync = false } = {}) {
  if (!fromSync) cfg.updatedAt = Date.now();
  try { store?.setItem(KEY, JSON.stringify(cfg)); } catch { /* 存储不可用：本次会话有效 */ }
}

export const modelOf = (cfg, id = cfg.provider) => cfg.models[id] || providerById(id)?.models[0] || '';

export function displayName(cfg) {
  const p = providerById(cfg.provider);
  return p.kind === 'mock' ? '内置演示' : `${cfg.providerNames?.[p.id] || p.name.replace(/（.*?）/g, '')} · ${modelOf(cfg)}`;
}

/**
 * @param {object} cfg
 * @param {{ gateway: { origin: string, keys: string[] } | null }} env
 * @returns {{ adapter, model, problem?: string }}
 */
export function createAdapter(cfg, { gateway = null } = {}) {
  const p = providerById(cfg.provider);
  const model = modelOf(cfg);
  if (p.kind === 'mock') return { adapter: createMockAdapter(), model };
  const key = cfg.keys[p.id] || '';
  const viaGateway = gateway && upstreamFor(p.id);
  const gatewayHasKey = gateway?.keys?.includes(p.id);
  if (p.needsKey !== false && !key && !gatewayHasKey) return { problem: `请先在“模型”面板填写 ${p.name} 的 API Key` };
  if (!model) return { problem: '请填写模型型号' };
  if (p.custom && !cfg.baseURLs?.[p.id]?.trim()) return { problem: '请填写接口地址' };
  if (p.kind === 'multi') return { model, adapter: multiAdapter(p, cfg, model, key, gateway) };
  if (p.kind === 'anthropic') {
    // 中转站：地址写成 https://xxx.com 或 https://xxx.com/v1 都行（SDK 自己会加 /v1/messages）
    const relay = p.custom ? cfg.baseURLs[p.id].trim().replace(/\/+$/, '').replace(/\/v1$/, '') : '';
    const relayViaGw = p.custom && customViaGateway(gateway, relay);
    return {
      model,
      adapter: createAnthropicAdapter({
        apiKey: key,
        baseURL: viaGateway ? `${gateway.origin}/api/llm/anthropic` : relayViaGw ? `${gateway.origin}/api/llm/${p.id}` : relay || undefined,
        // 中转站有的认 x-api-key，有的认 Authorization：两个都带上
        headers: p.custom ? { ...(relayViaGw && { 'x-jarvis-upstream': relay }), ...(key && { Authorization: `Bearer ${key}` }) } : undefined,
        webSearch: cfg.claudeWebSearch,
        compat: p.custom
      })
    };
  }
  // 自定义接口在完整版里也经网关转发（绕开跨域限制），目标地址放在请求头里
  const viaGw = viaGateway || (p.custom && customViaGateway(gateway, cfg.baseURLs[p.id]));
  const baseURL = viaGw ? `${gateway.origin}/api/llm/${p.id}` : (p.custom ? cfg.baseURLs[p.id] : p.baseURL);
  const headers = p.id === 'openrouter' ? { 'HTTP-Referer': 'https://jarvis.local', 'X-Title': 'Jarvis' } : {};
  if (viaGw && p.custom) headers['x-jarvis-upstream'] = cfg.baseURLs[p.id].trim();
  return { model, adapter: createOpenAIAdapter({ baseURL, apiKey: key || (viaGw ? 'use-gateway-key' : ''), headers }) };
}

/** 中转地址的根（去掉结尾的 / 和 /v1） */
const rootOf = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');

/** 按模型名选协议：Claude 用 Anthropic 原生、GPT 用 Responses（都带模型自带的联网搜索），其他用 Chat Completions */
export function protocolFor(model) {
  if (/claude/i.test(model)) return 'anthropic';
  if (/^(openai\/)?(gpt|o\d|chatgpt|codex)/i.test(model)) return 'responses';
  return 'chat';
}

function multiAdapter(p, cfg, model, key, gateway) {
  const root = rootOf(cfg.baseURLs[p.id]);
  const viaGw = customViaGateway(gateway, root);
  const base = viaGw ? `${gateway.origin}/api/llm/${p.id}` : root;
  const up = viaGw ? { 'x-jarvis-upstream': root } : {};
  const search = cfg.claudeWebSearch !== false;
  const proto = protocolFor(model);
  if (proto === 'anthropic') return createAnthropicAdapter({ apiKey: key, baseURL: base, headers: { ...up, ...(key && { Authorization: `Bearer ${key}` }) }, webSearch: search, compat: true });
  if (proto === 'responses') return createResponsesAdapter({ baseURL: `${base}/v1`, apiKey: key, headers: up, webSearch: search });
  return createOpenAIAdapter({ baseURL: `${base}/v1`, apiKey: key, headers: up });
}

/** 实际使用的语音引擎（解析 auto） */
export function resolveVoice(cfg, gateway = null) {
  const v = cfg.voice || DEFAULT_VOICE;
  return { ...v, engine:selectVoiceEngine({...cfg,voice:v},gateway) };
}

export { PROVIDERS, providerById };

/**
 * 读取服务商提供的模型列表（OpenAI 兼容的 GET /models）。失败时返回该服务商预置的几个型号。
 * @returns {Promise<string[]>}
 */
export async function listModels(cfg, { gateway = null } = {}) {
  const p = providerById(cfg.provider);
  const fallback = p.models.filter(Boolean);
  if (p.kind !== 'openai' && p.kind !== 'multi') return fallback;
  const key = cfg.keys[p.id] || '';
  const multi = p.kind === 'multi';
  const own = multi ? rootOf(cfg.baseURLs[p.id]) : cfg.baseURLs[p.id];
  const viaGateway = gateway && upstreamFor(p.id);
  const viaGw = viaGateway || (p.custom && customViaGateway(gateway, own));
  let base = viaGw ? `${gateway.origin}/api/llm/${p.id}` : (p.custom ? own : p.baseURL);
  if (!base) return fallback;
  if (multi) base = `${base.replace(/\/$/, '')}/v1`;
  const headers = { ...(key || viaGw ? { Authorization: `Bearer ${key || 'use-gateway-key'}` } : {}) };
  if (viaGw && p.custom) headers['x-jarvis-upstream'] = String(own).trim();
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout?.(10000) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const ids = (j.data ?? j.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
    return ids.length ? [...new Set(ids)].sort() : fallback;
  } catch {
    return fallback;
  }
}
