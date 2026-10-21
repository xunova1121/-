/**
 * 联网证据单独存放（查证、读网页时读到的原文片段），不放进对话记录：
 * 打开对话、同步到手机都不带这些正文；模型只看到编号，要细节时用 read_evidence 按编号取回，不用重新联网。
 *
 * - 按对话隔离：一段对话一条记录（kv 里的 evidence:<对话 id>），取的时候必须带对话 id，A 对话读不到 B 对话的
 * - 有上限：每段对话最多 12 篇、每篇 6000 字；只保留最近 24 小时用过的 30 段对话，多了删最旧的；内存里也只留这 30 段
 * - 少写盘：1 秒内的多次写入合并成一次（查证时每读完一页都会存一下）
 */
import { collection } from './store.js';

export const EVIDENCE_LIMITS = { perSession: 12, chars: 6000, sessions: 30, ttlMs: 24 * 3600_000, flushMs: 1000 };
const INDEX = 'evidence:index';
const recId = (sid) => `evidence:${sid}`;

/** 网址 → 短编号（同一网址同一编号，# 后面的不算） */
export function evidenceId(url) {
  let h = 0x811c9dc5;
  for (const ch of String(url).replace(/#.*$/, '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `e${h.toString(36)}`;
}

export function createEvidenceStore({ store = collection('kv'), now = Date.now, limits = EVIDENCE_LIMITS } = {}) {
  const cache = new Map(); // 对话 id → Promise<{ items }>，按最近使用排序
  const dirty = new Set(); // 改过、还没落盘的对话
  let timer = null;
  let writing = Promise.resolve();

  const alive = (items) => items.filter((x) => now() - x.at < limits.ttlMs);
  function load(sid) {
    let p = cache.get(sid);
    if (p) cache.delete(sid);
    else p = store.get(recId(sid)).then((r) => ({ items: Array.isArray(r?.items) ? r.items : [] })).catch(() => ({ items: [] }));
    cache.set(sid, p); // 排到最后 = 最近用过
    // 内存里只留最近的几段；还没落盘的先不丢
    for (const old of cache.keys()) {
      if (cache.size <= limits.sessions) break;
      if (old !== sid && !dirty.has(old)) cache.delete(old);
    }
    return p;
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, limits.flushMs);
    timer.unref?.();
  }
  /** 把改过的对话写到存储里，顺便清掉过期和超出数量的对话 */
  function flush() {
    clearTimeout(timer); timer = null;
    const sids = [...dirty]; dirty.clear();
    if (!sids.length) return writing;
    writing = writing.then(async () => {
      for (const sid of sids) {
        const rec = await cache.get(sid);
        if (rec) await store.put({ id: recId(sid), items: rec.items, at: now() }).catch(() => {});
      }
      const idx = await store.get(INDEX).catch(() => null);
      let list = (idx?.list || []).filter((x) => x && !sids.includes(x.sid));
      list.push(...sids.map((sid) => ({ sid, at: now() })));
      list.sort((a, b) => a.at - b.at);
      const gone = list.filter((x, i) => now() - x.at >= limits.ttlMs || i < list.length - limits.sessions);
      for (const x of gone) { cache.delete(x.sid); await store.delete(recId(x.sid)).catch(() => {}); }
      list = list.filter((x) => !gone.includes(x));
      await store.put({ id: INDEX, list }).catch(() => {});
    });
    return writing;
  }

  return {
    /** 存一批来源（{ url, title, text }），返回各自的编号；key 是查证时的问题，savedAt 用来判断证据新不新 */
    async put(sid, { key = '', savedAt, sources = [] } = {}) {
      if (!sid) return [];
      const rec = await load(sid);
      const ids = [];
      for (const s of sources.slice(0, limits.perSession)) {
        if (!s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) continue;
        const id = evidenceId(s.url);
        const old = rec.items.find((x) => x.id === id);
        rec.items = rec.items.filter((x) => x.id !== id);
        rec.items.push({ id, key: String(key).slice(0, 2000), url: s.url.slice(0, 2000), title: String(s.title || '').slice(0, 300), text: String(s.text || '').slice(0, limits.chars), original: s.original === true, savedAt: Math.min(now(), Number(savedAt) || (old?.key === key && old.savedAt) || now()), at: now() });
        ids.push(id);
      }
      rec.items = alive(rec.items).slice(-limits.perSession);
      dirty.add(sid);
      schedule();
      return ids;
    },
    /** 按编号取回原文；别的对话的编号取不到 */
    async get(sid, id) {
      if (!sid) return null;
      return alive((await load(sid)).items).find((x) => x.id === id) ?? null;
    },
    /** 只有编号、标题、网址（给模型看的索引） */
    async index(sid) {
      if (!sid) return [];
      return alive((await load(sid)).items).map(({ id, url, title, at }) => ({ id, url, title, at }));
    },
    /** 按查证问题分组（factCheck 用来复用刚查过的证据） */
    async records(sid) {
      if (!sid) return [];
      const groups = new Map();
      for (const x of alive((await load(sid)).items)) {
        if (!x.key) continue;
        const g = groups.get(x.key) ?? { key: x.key, savedAt: x.savedAt, sources: [] };
        g.savedAt = Math.min(g.savedAt, x.savedAt);
        g.sources.push({ url: x.url, title: x.title, text: x.text, original: x.original === true });
        groups.set(x.key, g);
      }
      return [...groups.values()];
    },
    /** 对话删了：证据一起删 */
    async drop(sid) {
      if (!sid) return;
      cache.delete(sid); dirty.delete(sid);
      writing = writing.then(async () => {
        await store.delete(recId(sid)).catch(() => {});
        const idx = await store.get(INDEX).catch(() => null);
        if (idx?.list?.some((x) => x.sid === sid)) await store.put({ id: INDEX, list: idx.list.filter((x) => x.sid !== sid) }).catch(() => {});
      });
      return writing;
    },
    flush,
    /** 测试用：内存里现在有几段对话 */
    get cached() { return cache.size; }
  };
}

/** 全局共用一个（服务器上所有任务、本机所有对话都用它，靠对话 id 隔离） */
export const evidence = createEvidenceStore();
