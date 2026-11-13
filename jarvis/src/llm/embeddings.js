/**
 * 语义向量（可选）：记忆检索在 BM25 之外再按“意思”匹配（“我在魔都上班”能找到“用户在上海工作”）。
 * 按能力表的“记忆向量”自动启用（智谱、百炼、硅基流动、OpenAI……填了哪家用哪家）；都没有时只用本地 BM25，照样能用。
 */
import { providerById } from '../../shared/providers.js';
import { abilityLines, cfgForLine } from './abilities.js';
import { providerEndpoint } from './images.js';
export const EMBEDDING_ENGINES = [
  { id: 'siliconflow', name: '硅基流动 BGE-M3（中文效果好）', keyFrom: 'siliconflow', model: 'BAAI/bge-m3', base: 'https://api.siliconflow.cn/v1', browser: false },
  { id: 'openai', name: 'OpenAI text-embedding-3-small', keyFrom: 'openai', model: 'text-embedding-3-small', base: 'https://api.openai.com/v1', browser: true },
  // 完全本机：在“模型 → 本机模型”里下载 bge-m3 后点“用于按意思检索”启用（不参与 auto）
  { id: 'ollama', name: 'Ollama 本机向量（bge-m3）', local: true, model: 'bge-m3', base: 'http://127.0.0.1:11434/v1', browser: false }
];

/**
 * auto：按能力表“记忆向量”那一项（见 abilities.js：设过的，或按填了 Key 的服务商自动挑）；返回 null 表示只用本地检索
 * 指定了引擎（off / ollama / siliconflow / openai）的老配置照旧
 */
export function resolveEmbedding(cfg, gateway = null, { direct = false } = {}) {
  const want = cfg.embedding?.engine || 'auto';
  if (want === 'off') return null;
  const has = (id) => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  if (want === 'ollama') return gateway ? { ...EMBEDDING_ENGINES.find((e) => e.id === 'ollama'), model: cfg.embedding?.model || 'bge-m3' } : null;
  if (want === 'auto') {
    const line = abilityLines(cfg, 'embed').main;
    const p = line && providerById(line.provider);
    // 网页直连有跨域限制：这家不支持网页直连、又没有网关时不用（手机 App 和服务器没有这个限制：direct）
    if (!p || (p.kind !== 'openai' && p.kind !== 'multi') || !(p.browser !== false || gateway || direct)) return null;
    return { id: line.provider, keyFrom: line.provider, model: line.model, line };
  }
  return EMBEDDING_ENGINES.filter((e) => e.id === want).find((e) => has(e.keyFrom) && (e.browser || gateway)) ?? null;
}

/**
 * @param {{ gateway?: object, fetchImpl?: Function, direct?: boolean }} [o]  direct：没有跨域限制（手机 App、服务器）
 * @returns {{ model: string, embed: (texts: string[]) => Promise<number[][]> } | null}
 */
export function createEmbedder(cfg, { gateway = null, fetchImpl = globalThis.fetch, direct = false } = {}) {
  const e = resolveEmbedding(cfg, gateway, { direct });
  if (!e) return null;
  // 能力表挑出来的：用那家服务商的接口地址（有网关时经网关），和画图同一套
  const ep = e.line ? providerEndpoint(cfgForLine(cfg, e.line), gateway) : null;
  const key = e.local ? 'ollama' : cfg.keys?.[e.keyFrom] || '';
  const base = ep ? ep.base : gateway ? `${gateway.origin}/api/llm/${e.id}` : e.base;
  // 检索时（一次只算一句话）：同一句话 5 分钟内复用结果；向量服务 1.2 秒没回就先不等它（这一轮只用关键词检索）。
  // 以前等 2.5 秒，评测里很多轮都正好等满，每次对话先白等两三秒
  const cache = new Map();
  const QUERY_TIMEOUT = 1200;
  const raw = async (texts) => {
    const res = await fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ep ? ep.headers : { authorization: `Bearer ${key || 'use-gateway-key'}` }) },
      body: JSON.stringify({ model: e.model, input: texts.map((t) => String(t).slice(0, 2000)) })
    });
    if (!res.ok) throw new Error(`向量服务返回 ${res.status}`);
    const j = await res.json();
    return (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
  return {
    model: `${e.id}:${e.model}`,
    async embed(texts) {
      if (texts.length !== 1) return raw(texts);
      const key = String(texts[0]);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.t < 300_000) return [await hit.p];
      const p = raw([key]).then((v) => v[0]);
      cache.set(key, { p, t: Date.now() });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      p.catch(() => cache.delete(key));
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('向量服务超时')), QUERY_TIMEOUT); });
      try { return [await Promise.race([p, timeout])]; } finally { clearTimeout(timer); }
    }
  };
}

