/**
 * 语义向量（可选）：记忆检索在 BM25 之外再按“意思”匹配（“我在魔都上班”能找到“用户在上海工作”）。
 * 填了 OpenAI 或硅基流动的密钥就自动启用；都没有时只用本地 BM25，照样能用。
 */
export const EMBEDDING_ENGINES = [
  { id: 'siliconflow', name: '硅基流动 BGE-M3（中文效果好）', keyFrom: 'siliconflow', model: 'BAAI/bge-m3', base: 'https://api.siliconflow.cn/v1', browser: false },
  { id: 'openai', name: 'OpenAI text-embedding-3-small', keyFrom: 'openai', model: 'text-embedding-3-small', base: 'https://api.openai.com/v1', browser: true },
  // 完全本机：在“模型 → 本机模型”里下载 bge-m3 后点“用于按意思检索”启用（不参与 auto）
  { id: 'ollama', name: 'Ollama 本机向量（bge-m3）', local: true, model: 'bge-m3', base: 'http://127.0.0.1:11434/v1', browser: false }
];

/** auto：按已有密钥选；返回 null 表示只用本地检索 */
export function resolveEmbedding(cfg, gateway = null) {
  const want = cfg.embedding?.engine || 'auto';
  if (want === 'off') return null;
  const has = (id) => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  if (want === 'ollama') return gateway ? { ...EMBEDDING_ENGINES.find((e) => e.id === 'ollama'), model: cfg.embedding?.model || 'bge-m3' } : null;
  const list = want === 'auto' ? EMBEDDING_ENGINES.filter((e) => !e.local) : EMBEDDING_ENGINES.filter((e) => e.id === want);
  return list.find((e) => has(e.keyFrom) && (e.browser || gateway)) ?? null;
}

/**
 * @returns {{ model: string, embed: (texts: string[]) => Promise<number[][]> } | null}
 */
export function createEmbedder(cfg, { gateway = null, fetchImpl = globalThis.fetch } = {}) {
  const e = resolveEmbedding(cfg, gateway);
  if (!e) return null;
  const key = e.local ? 'ollama' : cfg.keys?.[e.keyFrom] || '';
  const base = gateway ? `${gateway.origin}/api/llm/${e.id}` : e.base;
  // 检索时（一次只算一句话）：同一句话 5 分钟内复用结果；向量服务 2.5 秒没回就先不等它（这一轮只用关键词检索）
  const cache = new Map();
  const QUERY_TIMEOUT = 2500;
  const raw = async (texts) => {
    const res = await fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key || 'use-gateway-key'}` },
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

