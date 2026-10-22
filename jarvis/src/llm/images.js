/**
 * 画图：调用模型服务商（如中转平台）OpenAI 兼容的 /images/generations。
 * 画图模型和聊天模型分开：gpt-image-2 这类只能画图，不能用来对话。
 */
import { providerById, upstreamFor, customViaGateway } from '../../shared/providers.js';
import { abilityLines, cfgForLine } from './abilities.js';

/** 按名字判断模型用途：chat 对话 / image 画图 / video 视频 / audio 语音 / embed 向量、重排 */
export function modelKind(id) {
  const s = String(id).toLowerCase();
  if (/embed|rerank|bge-|moderation/.test(s)) return 'embed';
  if (/tts|whisper|transcribe|realtime|audio|speech/.test(s)) return 'audio';
  if (/sora|veo|kling|hailuo|seedance|video|runway|vidu|pika/.test(s)) return 'video';
  if (/gpt-image|dall-?e|flux|stable-?diffusion|sdxl|sd3|midjourney|\bmj\b|imagen|seedream|cogview|kolors|wanx|wan2\.\d-t2i|jimeng|ideogram|recraft|image-gen|t2i|-image$|qwen-image|hunyuan-image|nano-banana/.test(s)) return 'image';
  return 'chat';
}

/** 当前服务商的接口地址和请求头（有本机网关时经网关转发） */
export function providerEndpoint(cfg, gateway = null) {
  const p = providerById(cfg.provider);
  if (!p || (p.kind !== 'openai' && p.kind !== 'multi')) throw new Error('画图和生成视频需要 OpenAI 兼容的服务商（如中转平台）');
  const key = cfg.keys?.[p.id] || '';
  // 多协议中转填的是根地址：OpenAI 格式的接口在 /v1 下面
  const own = p.kind === 'multi' ? String(cfg.baseURLs?.[p.id] || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '') : cfg.baseURLs?.[p.id];
  const viaGw = p.custom ? customViaGateway(gateway, own) : Boolean(gateway && upstreamFor(p.id));
  let base = viaGw ? `${gateway.origin}/api/llm/${p.id}` : String(p.custom ? own || '' : p.baseURL).replace(/\/$/, '');
  if (p.kind === 'multi') base += '/v1';
  const headers = {};
  if (key || viaGw) headers.Authorization = `Bearer ${key || 'use-gateway-key'}`;
  if (viaGw && p.custom) headers['x-jarvis-upstream'] = String(own).trim();
  return { base, headers };
}

/** 用哪个画图模型：用户选过的 → 模型列表里的画图模型 → gpt-image-1 */
export function imageModelOf(cfg) {
  if (cfg.imageModel) return cfg.imageModel;
  const lists = Object.values(cfg.modelLists || {}).flatMap((l) => l.ids || []);
  const imgs = lists.filter((id) => modelKind(id) === 'image');
  return imgs.find((id) => /gpt-image/.test(id)) || imgs[0] || 'gpt-image-1';
}

/**
 * 画图用谁：能力表里“画图”的常用 → 备用（见 abilities.js）；常用出错（断网、额度、模型不在）换备用再画一次。
 * 能力表里一个能画图的都没有时，照旧用当前服务商 + imageModelOf（老配置）。
 * @returns {Promise<{ blob: Blob, model: string, revised?: string }>}
 */
export async function generateImage(cfg, options = {}) {
  const { main, backup } = abilityLines(cfg, 'image');
  const lines = main ? [main, backup].filter(Boolean) : [{ provider: cfg.provider, model: imageModelOf(cfg) }];
  let failure;
  for (const line of lines) {
    try {
      return await drawWith(cfgForLine(cfg, line), line.model, options);
    } catch (e) {
      if (options.signal?.aborted || e.name === 'AbortError') throw e;
      failure = failure ?? e;
    }
  }
  throw failure;
}

async function drawWith(cfg, model, { prompt, size = '1024x1024', gateway = null, fetchImpl = globalThis.fetch, signal } = {}) {
  const { base, headers } = providerEndpoint(cfg, gateway);
  const res = await fetchImpl(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, prompt, size, n: 1 }),
    signal
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(`画图失败（${model}，HTTP ${res.status}）：${String(j.error?.message || j.message || text).slice(0, 200)}`);
  const d = j.data?.[0];
  if (d?.b64_json) return { blob: new Blob([Uint8Array.from(atob(d.b64_json), (c) => c.charCodeAt(0))], { type: 'image/png' }), model, revised: d.revised_prompt };
  if (d?.url) {
    const r = await fetchImpl(d.url, { signal });
    if (!r.ok) throw new Error(`下载生成的图片失败（HTTP ${r.status}）`);
    return { blob: await r.blob(), model, revised: d.revised_prompt };
  }
  throw new Error(`画图失败：服务商没有返回图片（${model}）`);
}
