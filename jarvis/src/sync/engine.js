/**
 * 多设备同步（电脑 ↔ 手机）：数据在本机加密后放到用户自己的阿里云 OSS。
 *
 *   云端文件（都在 jarvis-sync/ 下）：
 *     salt          随机盐（不保密，用来从同步密码算出密钥）
 *     memory.enc    记忆、教训、技能、安装的技能包、对话摘要、核心记忆、操作习惯
 *     sessions.enc  对话历史
 *     config.enc    模型设置和 API 密钥
 *   知识库不同步（文件大，而且通常只在电脑上用）。
 *
 * 合并按“条”进行（三方合并）：记住上次同步时每条数据的指纹（base），
 *   只有一边改了 → 用改了的那边；两边都改了 → 用更新时间较新的；
 *   一边删了、另一边没动 → 删除；一边删了、另一边改了 → 保留改过的。
 * 向量、使用次数等每台设备自己算的字段不参与同步。
 */
import { deriveKey, seal, open, randomBytes } from './crypto.js';

export const GROUPS = {
  memory: '记忆、习惯、技能、教训',
  sessions: '对话历史',
  config: '模型设置和 API 密钥'
};

/** 每台设备自己算 / 自己记的字段：不上传、不参与比较，合并时保留本机的值 */
export const LOCAL_FIELDS = ['embedding', 'embModel', 'uses', 'lastUsed', 'relevance'];

const strip = (rec) => {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  for (const f of LOCAL_FIELDS) delete out[f];
  return out;
};

/** 键排序后的 JSON，保证同样的内容得到同样的指纹 */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** 内容指纹（FNV-1a 两路，够用来判断“变没变”） */
export function hashOf(rec) {
  const s = stableJson(strip(rec));
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

const stampOf = (r) => Number(r?.updatedAt ?? r?.ts ?? r?.createdAt ?? 0);

/**
 * 纯函数：三方合并
 * @param {Record<string, object>} local  本机：id → 记录
 * @param {Record<string, object>} remote 云端：id → 记录（已去掉本机字段）
 * @param {Record<string, string>} base   上次同步时的指纹：id → hash
 * @returns {{ result: Record<string, object>, put: { key: string, rec: object }[], del: string[], pushed: number, pulled: number, uploadNeeded: boolean, base: Record<string, string> }}
 */
export function merge(local, remote, base = {}) {
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const result = {};
  const put = [];
  const del = [];
  let pushed = 0, pulled = 0;
  for (const id of ids) {
    const L = local[id], R = remote[id];
    const hl = L ? hashOf(L) : null, hr = R ? hashOf(R) : null, hb = base[id] ?? null;
    let take; // 'local' | 'remote' | 'none'
    if (hl === hr) take = L ? 'local' : 'none';
    else if (hl === hb) take = R ? 'remote' : 'none'; // 只有云端改了（或删了）
    else if (hr === hb) take = L ? 'local' : 'none'; // 只有本机改了（或删了）
    else if (!L) take = 'remote'; // 本机删了、云端改了：保留改过的
    else if (!R) take = 'local';
    else take = stampOf(R) > stampOf(L) ? 'remote' : 'local';

    if (take === 'local') {
      result[id] = strip(L);
      if (hl !== hr) pushed++;
    } else if (take === 'remote') {
      result[id] = R;
      if (hl !== hr) {
        pulled++;
        // 内容换成云端的；本机的使用次数等保留，向量作废（之后会按新内容重新计算）
        const keep = L ? Object.fromEntries(['uses', 'lastUsed', 'relevance'].filter((f) => L[f] !== undefined).map((f) => [f, L[f]])) : {};
        put.push({ key: id, rec: { ...R, ...keep } });
      }
    } else {
      if (L) { del.push(id); pulled++; }
      if (R) pushed++;
    }
  }
  const uploadNeeded = Object.keys(result).length !== Object.keys(remote).length || Object.entries(result).some(([id, r]) => !remote[id] || hashOf(remote[id]) !== hashOf(r));
  return { result, put, del, pushed, pulled, uploadNeeded, base: Object.fromEntries(Object.entries(result).map(([id, r]) => [id, hashOf(r)])) };
}

/**
 * @param {{
 *   oss: { get(name): Promise<{ body: Uint8Array } | null>, put(name, bytes): Promise<unknown> },
 *   passphrase: string,
 *   sources: Record<string, { read(): Promise<Record<string, object>>, write(put: { key: string, rec: object }[], del: string[]): Promise<void> }>,
 *   baseStore: { get(): Promise<object>, set(v: object): Promise<void> }
 * }} d
 */
export function createSync({ oss, passphrase, sources, baseStore }) {
  let keyPromise = null;
  let running = null;

  async function key() {
    keyPromise ??= (async () => {
      let salt = (await oss.get('salt'))?.body;
      if (!salt || salt.length !== 16) {
        await oss.put('salt', randomBytes(16));
        salt = (await oss.get('salt')).body; // 两台设备同时第一次同步时，以云端最后留下的为准
      }
      return deriveKey(passphrase, salt);
    })();
    try { return await keyPromise; } catch (e) { keyPromise = null; throw e; }
  }

  async function syncGroup(name, k, bases) {
    const src = sources[name];
    const file = `${name}.enc`;
    const [got, local] = await Promise.all([oss.get(file), src.read()]);
    let remote = {};
    if (got) {
      const data = await open(k, got.body);
      if (data?.group !== name || typeof data.records !== 'object') throw new Error('同步数据格式不对');
      remote = data.records;
    }
    const m = merge(local, remote, bases[name] ?? {});
    if (m.put.length || m.del.length) await src.write(m.put, m.del);
    if (m.uploadNeeded) await oss.put(file, await seal(k, { v: 1, group: name, at: Date.now(), records: m.result }));
    bases[name] = m.base;
    return { pushed: m.pushed, pulled: m.pulled, total: Object.keys(m.result).length, changedLocal: m.put.length + m.del.length > 0 };
  }

  /** 同步指定的几组；同一时间只跑一次 */
  async function run(groups = Object.keys(sources)) {
    if (running) return running;
    running = (async () => {
      const k = await key();
      const bases = (await baseStore.get()) ?? {};
      const out = {};
      try {
        for (const g of groups) if (sources[g]) out[g] = await syncGroup(g, k, bases);
      } finally {
        await baseStore.set(bases); // 已成功的组记住指纹，失败的组下次重来
      }
      return out;
    })();
    try { return await running; } finally { running = null; }
  }

  return { run, get busy() { return Boolean(running); } };
}
