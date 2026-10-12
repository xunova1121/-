/**
 * 同步的数据来源：把本机各处的数据整理成“id → 记录”，以及把合并结果写回去。
 */
import { collection } from '../agent/store.js';
import { stubForSync, keepLocalBinaries } from '../agent/skillPacks.js';

const MEMORY_COLLECTIONS = ['memories', 'lessons', 'skills', 'packs', 'episodes'];
const MEMORY_KV = ['core', 'habits'];

/** 记忆一组：几个集合 + kv 里的核心记忆和习惯统计，id 写成 “集合:原 id” */
export function memorySource({ coll = collection } = {}) {
  const kv = coll('kv');
  return {
    async read() {
      const out = {};
      // 技能的二进制附件（模板、图片）不同步内容，只同步占位
      for (const c of MEMORY_COLLECTIONS) for (const r of await coll(c).all()) out[`${c}:${r.id}`] = c === 'packs' ? stubForSync(r) : r;
      for (const id of MEMORY_KV) { const r = await kv.get(id); if (r) out[`kv:${id}`] = r; }
      return out;
    },
    async write(put, del) {
      const split = (key) => { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; };
      const allowed = (c, id) => (c === 'kv' ? MEMORY_KV.includes(id) : MEMORY_COLLECTIONS.includes(c));
      for (const key of del) { const [c, id] = split(key); if (allowed(c, id)) await coll(c).delete(id); }
      for (const { key, rec } of put) {
        const [c, id] = split(key);
        if (!allowed(c, id) || rec?.id !== id) continue;
        await coll(c).put(c === 'packs' ? keepLocalBinaries(rec, await coll(c).get(id)) : rec);
      }
    }
  };
}

/** 对话历史 */
export function sessionsSource({ coll = collection } = {}) {
  const s = coll('sessions');
  return {
    async read() { return Object.fromEntries((await s.all()).map((r) => [r.id, r])); },
    async write(put, del) {
      for (const id of del) await s.delete(id);
      for (const { key, rec } of put) if (rec?.id === key) await s.put(rec);
    }
  };
}

/** 只属于这台设备的设置：不同步 */
const DEVICE_ONLY = (cfg) => ({ browserVoice: cfg?.voice?.browserVoice ?? '' });

/** 模型设置和 API 密钥（localStorage 里的一份配置） */
export function configSource({ load, save }) {
  return {
    async read() {
      const cfg = load();
      if (!cfg || cfg.provider === 'mock' && !Object.keys(cfg.keys || {}).length && !cfg.updatedAt) return {}; // 没配置过：不要用默认值盖掉别的设备
      const { voice, ...rest } = cfg;
      return { config: { id: 'config', ...rest, voice: { ...voice, browserVoice: undefined } } };
    },
    async write(put, del) {
      if (del.length || !put.length) return;
      const { id, ...remote } = put[0].rec;
      const mine = DEVICE_ONLY(load());
      save({ ...remote, voice: { ...(remote.voice || {}), browserVoice: mine.browserVoice } }, { fromSync: true });
    }
  };
}
