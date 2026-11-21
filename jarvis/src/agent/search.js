/**
 * 轻量检索：中英文混合分词 + BM25。纯本地、不需要向量模型，离线可用。
 *   - 拉丁字母 / 数字：按词切分并转小写；
 *   - 中文：单字 + 相邻二元组（bigram），兼顾召回与精度。
 */
const STOP = new Set(['的', '了', '是', '在', '和', '与', '我', '你', '他', '她', '它', '吗', '呢', '吧', '啊', 'the', 'a', 'an', 'of', 'to', 'and', 'is', 'in', 'on', 'for']);

export function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[a-z0-9_]+|[㐀-鿿]+/g)) {
    const w = m[0];
    if (/^[a-z0-9_]+$/.test(w)) {
      if (!STOP.has(w) && w.length > 1) out.push(w);
    } else {
      for (let i = 0; i < w.length; i++) {
        if (!STOP.has(w[i])) out.push(w[i]);
        if (i + 1 < w.length) out.push(w.slice(i, i + 2));
      }
    }
  }
  return out;
}

/**
 * @param {Array<{id: string, text: string}>} docs
 * @returns {(query: string, k?: number) => Array<{id, score}>}
 */
export function buildIndex(docs, { k1 = 1.4, b = 0.75 } = {}) {
  const N = docs.length;
  const tf = docs.map((d) => {
    const m = new Map();
    for (const t of tokenize(d.text)) m.set(t, (m.get(t) || 0) + 1);
    return m;
  });
  const len = tf.map((m) => [...m.values()].reduce((a, v) => a + v, 0));
  const avg = len.reduce((a, v) => a + v, 0) / Math.max(1, N);
  const df = new Map();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);

  return (query, k = 5) => {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !N) return [];
    const scores = [];
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const t of q) {
        const f = tf[i].get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len[i]) / (avg || 1)));
      }
      if (s > 0) scores.push({ id: docs[i].id, score: s });
    }
    return scores.sort((a, b2) => b2.score - a.score).slice(0, k);
  };
}

/** 文本切块：按段落聚合到约 size 字，块之间重叠 overlap 字，保留上下文 */
export function chunkText(text, { size = 600, overlap = 80 } = {}) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); };
  for (const p of paras) {
    if (p.length > size) {
      flush();
      cur = '';
      for (let i = 0; i < p.length; i += size - overlap) chunks.push(p.slice(i, i + size));
      continue;
    }
    if ((cur + '\n\n' + p).length > size) {
      flush();
      cur = cur.slice(-overlap) + '\n\n' + p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return chunks;
}
