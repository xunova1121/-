/**
 * 本地知识库：导入文档 → 解析成文本 → 切块 → 检索（BM25）。回答时引用来源。
 */
import { collection, uid } from './store.js';
import { buildIndex, chunkText } from './search.js';

const docs = collection('kbdocs');
const chunks = collection('kbchunks');
let cache = null; // { search, byId }

export async function addDocument({ name, text, source = 'upload' }) {
  text = String(text || '').trim();
  if (!text) throw new Error(`「${name}」没有可读取的文字内容`);
  const id = uid('d');
  const parts = chunkText(text);
  for (const [i, c] of parts.entries()) await chunks.put({ id: `${id}:${i}`, docId: id, name, text: c, n: i });
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

export async function search(query, k = 4, minScore = 1.2) {
  if (!cache) {
    const all = await chunks.all();
    cache = { search: buildIndex(all.map((c) => ({ id: c.id, text: `${c.name}\n${c.text}` }))), byId: new Map(all.map((c) => [c.id, c])) };
  }
  return cache.search(query, k).filter((h) => h.score >= minScore).map((h) => ({ ...cache.byId.get(h.id), score: h.score }));
}
