/**
 * 语义向量（可选）：记忆检索在 BM25 之外再按“意思”匹配（“我在魔都上班”能找到“用户在上海工作”）。
 * 填了 OpenAI 或硅基流动的密钥就自动启用；都没有时只用本地 BM25，照样能用。
 */
export const EMBEDDING_ENGINES = [
  { id: 'siliconflow', name: '硅基流动 BGE-M3（中文效果好）', keyFrom: 'siliconflow', model: 'BAAI/bge-m3', base: 'https://api.siliconflow.cn/v1', browser: false },
  { id: 'openai', name: 'OpenAI text-embedding-3-small', keyFrom: 'openai', model: 'text-embedding-3-small', base: 'https://api.openai.com/v1', browser: true }
];

/** auto：按已有密钥选；返回 null 表示只用本地检索 */
export function resolveEmbedding(cfg, gateway = null) {
  const want = cfg.embedding?.engine || 'auto';
  if (want === 'off') return null;
  const has = (id) => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  const list = want === 'auto' ? EMBEDDING_ENGINES : EMBEDDING_ENGINES.filter((e) => e.id === want);
  return list.find((e) => has(e.keyFrom) && (e.browser || gateway)) ?? null;
}

/**
 * @returns {{ model: string, embed: (texts: string[]) => Promise<number[][]> } | null}
 */
export function createEmbedder(cfg, { gateway = null, fetchImpl = globalThis.fetch } = {}) {
  const e = resolveEmbedding(cfg, gateway);
  if (!e) return null;
  const key = cfg.keys?.[e.keyFrom] || '';
  const base = gateway ? `${gateway.origin}/api/llm/${e.id}` : e.base;
  return {
    model: `${e.id}:${e.model}`,
    async embed(texts) {
      const res = await fetchImpl(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key || 'use-gateway-key'}` },
        body: JSON.stringify({ model: e.model, input: texts.map((t) => String(t).slice(0, 2000)) })
      });
      if (!res.ok) throw new Error(`向量服务返回 ${res.status}`);
      const j = await res.json();
      return (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
  };
}

