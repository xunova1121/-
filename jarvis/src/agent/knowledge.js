/**
 * 本地知识库：导入文档 → 解析成文本 → 切块 → 检索。回答时引用来源。
 *
 * 检索：
 *   - 关键词：BM25（中文按单字 + 二元组），离线可用
 *   - 语义：配置了向量服务（OpenAI / 硅基流动 BGE-M3）时，每个切块存一份向量，按“意思”匹配
 *     （问“出差能报多少钱”能找到“差旅补贴标准”）
 *   - 两路结果用倒数排名融合（RRF）合并排序
 */
import { collection, uid } from './store.js';
import { buildIndex, chunkText } from './search.js';

const docs = collection('kbdocs');
const chunks = collection('kbchunks');
let cache = null; // { search, byId, all }
let embedder = null; // { model, embed(texts) }
const BATCH = 16;
const RRF_K = 60;

export function configureKnowledge({ embedder: e = null } = {}) {
  if (e?.model !== embedder?.model) cache = null;
  embedder = e;
}
export const knowledgeEngine = () => ({ embeddings: embedder?.model ?? null });

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function embedAll(texts, onProgress) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await embedder.embed(texts.slice(i, i + BATCH))));
    onProgress?.(Math.min(texts.length, i + BATCH), texts.length);
  }
  return out;
}

export async function addDocument({ name, text, source = 'upload' }, { onProgress } = {}) {
  text = String(text || '').trim();
  if (!text) throw new Error(`「${name}」没有可读取的文字内容`);
  const id = uid('d');
  const parts = chunkText(text);
  let vecs = null;
  if (embedder) {
    try { vecs = await embedAll(parts.map((c) => `${name}\n${c}`), onProgress); } catch { vecs = null; /* 向量服务出错：先只用关键词，之后可补算 */ }
  }
  for (const [i, c] of parts.entries()) {
    await chunks.put({ id: `${id}:${i}`, docId: id, name, text: c, n: i, ...(vecs?.[i] && { embedding: vecs[i], embModel: embedder.model }) });
  }
  const doc = { id, name, source, chars: text.length, chunks: parts.length, ts: Date.now() };
  await docs.put(doc);
  cache = null;
  return doc;
}

export async function listDocuments() {
  return (await docs.all()).sort((a, b) => b.ts - a.ts);
}

export async function removeDocument(id) {
  for (const c of await chunks.all()) if (c.docId === id) await chunks.delete(c.id);
  await docs.delete(id);
  cache = null;
}

/** 还没有当前模型向量的切块数 */
export async function pendingEmbeddings() {
  if (!embedder) return 0;
  return (await chunks.all()).filter((c) => c.embModel !== embedder.model).length;
}

/** 给旧文档补算向量（换了向量模型或之前没配置时） */
export async function reindex({ onProgress } = {}) {
  if (!embedder) throw new Error('没有配置向量服务');
  const todo = (await chunks.all()).filter((c) => c.embModel !== embedder.model);
  const vecs = await embedAll(todo.map((c) => `${c.name}\n${c.text}`), onProgress);
  for (const [i, c] of todo.entries()) await chunks.put({ ...c, embedding: vecs[i], embModel: embedder.model });
  cache = null;
  return todo.length;
}

/**
 * @param {string} query
 * @param {number} k
 * @param {number} minScore 关键词检索的最低 BM25 分（纯关键词模式下的门槛）
 * @returns {Promise<Array<{ id, docId, name, text, score, via: string[] }>>}
 */
export async function search(query, k = 4, minScore = 1.2) {
  if (!cache) {
    const all = await chunks.all();
    cache = { all, search: buildIndex(all.map((c) => ({ id: c.id, text: `${c.name}\n${c.text}` }))), byId: new Map(all.map((c) => [c.id, c])) };
  }
  const kw = cache.search(query, Math.max(k * 3, 12)).filter((h) => h.score >= minScore);
  let sem = [];
  const model = embedder?.model;
  if (model && cache.all.some((c) => c.embModel === model)) {
    try {
      const [q] = await embedder.embed([query]);
      sem = cache.all.filter((c) => c.embModel === model)
        .map((c) => ({ id: c.id, score: cosine(q, c.embedding) }))
        .filter((h) => h.score >= 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(k * 3, 12));
    } catch { sem = []; }
  }
  if (!sem.length) return kw.slice(0, k).map((h) => ({ ...cache.byId.get(h.id), embedding: undefined, score: h.score, via: ['关键词'] }));
  // 倒数排名融合：两路各自的名次越靠前，合并后的分越高
  const fused = new Map();
  kw.forEach((h, r) => fused.set(h.id, { score: 1 / (RRF_K + r + 1), via: ['关键词'] }));
  sem.forEach((h, r) => {
    const f = fused.get(h.id) ?? { score: 0, via: [] };
    f.score += 1 / (RRF_K + r + 1);
    f.via.push('语义');
    fused.set(h.id, f);
  });
  return [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k)
    .map(([id, f]) => ({ ...cache.byId.get(id), embedding: undefined, score: f.score * 100, via: f.via }));
}
