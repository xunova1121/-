/**
 * 模型配置（只存在这台电脑的浏览器 localStorage 里）与适配器工厂。
 * 有本机网关（完整版）时请求经网关转发：没有浏览器跨域限制，也可以用网关环境变量里的密钥。
 */
import { PROVIDERS, providerById, upstreamFor, customViaGateway } from '../../shared/providers.js';
import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createMockAdapter } from './mock.js';

const KEY = 'jarvis.llm.v1';
const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();

/** 语音：engine 为 auto 时按已有密钥自动挑最自然的云端声音，都没有就用浏览器自带 */
export const DEFAULT_VOICE = { engine: 'auto', voices: {}, fx: 'jarvis', cues: true, browserVoice: '', customURL: '', customModel: '', customVoice: '' };
export const DEFAULT_STT = { engine: 'auto', customURL: '', customModel: '' };
export const DEFAULT_CONFIG = { provider: 'mock', models: {}, keys: {}, baseURLs: {}, claudeWebSearch: true, tavilyKey: '', voice: DEFAULT_VOICE, stt: DEFAULT_STT };

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
  cfg.voice = { ...DEFAULT_VOICE, ...(cfg.voice || {}), voices: { ...(cfg.voice?.voices || {}) } };
  cfg.stt = { ...DEFAULT_STT, ...(cfg.stt || {}) };
  return cfg;
}

export function saveConfig(cfg) {
  try { store?.setItem(KEY, JSON.stringify(cfg)); } catch { /* 存储不可用：本次会话有效 */ }
}

export const modelOf = (cfg, id = cfg.provider) => cfg.models[id] || providerById(id)?.models[0] || '';

export function displayName(cfg) {
  const p = providerById(cfg.provider);
  return p.kind === 'mock' ? '内置演示' : `${p.name.replace(/（.*?）/g, '')} · ${modelOf(cfg)}`;
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
  if (p.kind === 'anthropic') {
    return {
      model,
      adapter: createAnthropicAdapter({
        apiKey: key,
        baseURL: viaGateway ? `${gateway.origin}/api/llm/anthropic` : undefined,
        webSearch: cfg.claudeWebSearch
      })
    };
  }
  if (p.custom && !cfg.baseURLs.custom) return { problem: '请填写接口地址' };
  // 自定义接口在完整版里也经网关转发（绕开跨域限制），目标地址放在请求头里
  const viaGw = viaGateway || (p.custom && customViaGateway(gateway, cfg.baseURLs.custom));
  const baseURL = viaGw ? `${gateway.origin}/api/llm/${p.id}` : (p.custom ? cfg.baseURLs.custom : p.baseURL);
  const headers = p.id === 'openrouter' ? { 'HTTP-Referer': 'https://jarvis.local', 'X-Title': 'Jarvis' } : {};
  if (viaGw && p.custom) headers['x-jarvis-upstream'] = cfg.baseURLs.custom.trim();
  return { model, adapter: createOpenAIAdapter({ baseURL, apiKey: key || (viaGw ? 'use-gateway-key' : ''), headers }) };
}

/** 实际使用的语音引擎（解析 auto） */
export function resolveVoice(cfg, gateway = null) {
  const v = cfg.voice || DEFAULT_VOICE;
  if (v.engine !== 'auto') return v;
  const has = (id) => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  const engine = has('elevenlabs') ? 'elevenlabs' : has('openai') ? 'openai' : gateway && has('siliconflow') ? 'siliconflow' : 'browser';
  return { ...v, engine };
}

export { PROVIDERS, providerById };
