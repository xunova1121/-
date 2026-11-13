/**
 * 服务器版的存储：把未央的对话、记忆、知识库、工作区文件存到硬盘上的一个文件夹（代替浏览器里的 IndexedDB）。
 *
 *   <数据目录>/<集合名>/<id 的哈希>.json      一条记录
 *   <数据目录>/<集合名>/<id 的哈希>.<字段>.bin  记录里的文件内容（Blob / 二进制），用到时才从硬盘读
 *
 * 每个集合第一次用到时整个读进内存（只读 JSON，不读文件内容）；写入先写临时文件再改名，断电也不会写坏一半。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const keyOf = (id) => createHash('sha1').update(String(id)).digest('hex');
const isBinary = (v) => v instanceof Blob || v instanceof ArrayBuffer || ArrayBuffer.isView(v);

async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/**
 * @param {string} dir  数据目录（不存在会自动创建，权限只给运行未央的系统账号）
 */
export function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caches = new Map(); // 集合名 → Promise<Map<id, 记录（文件内容只留标记）>>
  const queues = new Map(); // 同一条记录的写入排队，后写的不会被先写的覆盖

  const folder = (name) => path.join(dir, name.replace(/[^\w.-]/g, '_'));

  function load(name) {
    if (!caches.has(name)) caches.set(name, (async () => {
      const map = new Map();
      await fsp.mkdir(folder(name), { recursive: true, mode: 0o700 });
      for (const f of await fsp.readdir(folder(name))) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(await fsp.readFile(path.join(folder(name), f), 'utf8'));
          map.set(rec.id, rec);
        } catch { /* 写坏或不认识的文件：跳过，不影响其他记录 */ }
      }
      return map;
    })());
    return caches.get(name);
  }

  /** 记录 → 给调用方的对象：文件内容标记换成按需从硬盘读的 Blob */
  function hydrate(name, rec) {
    if (!rec) return rec;
    const out = { ...rec };
    for (const [k, v] of Object.entries(rec)) {
      if (v && typeof v === 'object' && v.$file) out[k] = fs.openAsBlob(path.join(folder(name), v.$file), { type: v.type || '' });
    }
    return out;
  }
  // openAsBlob 是异步的：整条记录等它们都打开
  async function hydrateAsync(name, rec) {
    const out = hydrate(name, rec);
    if (!out) return out;
    await Promise.all(Object.entries(out).map(async ([k, v]) => { if (v instanceof Promise) out[k] = await v.catch(() => new Blob([])); }));
    return out;
  }

  function queue(name, id, job) {
    const k = `${name}/${id}`;
    const next = (queues.get(k) ?? Promise.resolve()).catch(() => {}).then(job);
    queues.set(k, next);
    next.finally(() => { if (queues.get(k) === next) queues.delete(k); }).catch(() => {});
    return next;
  }

  return {
    dir,
    async all(name) {
      const map = await load(name);
      return Promise.all([...map.values()].map((r) => hydrateAsync(name, r)));
    },
    async get(name, id) {
      const map = await load(name);
      return hydrateAsync(name, map.get(id));
    },
    async put(name, obj) {
      const map = await load(name);
      const key = keyOf(obj.id);
      const rec = {};
      const blobs = [];
      for (const [k, v] of Object.entries(obj)) {
        if (isBinary(v)) {
          const file = `${key}.${k.replace(/[^\w]/g, '_')}.bin`;
          rec[k] = { $file: file, type: v instanceof Blob ? v.type : '' };
          blobs.push([file, v]);
        } else rec[k] = v;
      }
      map.set(obj.id, rec);
      await queue(name, obj.id, async () => {
        for (const [file, v] of blobs) {
          const buf = v instanceof Blob ? Buffer.from(await v.arrayBuffer()) : Buffer.from(v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          await atomicWrite(path.join(folder(name), file), buf);
        }
        await atomicWrite(path.join(folder(name), `${key}.json`), JSON.stringify(rec));
      });
    },
    async delete(name, id) {
      const map = await load(name);
      const rec = map.get(id);
      map.delete(id);
      await queue(name, id, async () => {
        const key = keyOf(id);
        await fsp.rm(path.join(folder(name), `${key}.json`), { force: true });
        for (const v of Object.values(rec ?? {})) if (v && typeof v === 'object' && v.$file) await fsp.rm(path.join(folder(name), v.$file), { force: true });
      });
    },
    async clear(name) {
      const map = await load(name);
      const ids = [...map.keys()];
      await Promise.all(ids.map((id) => this.delete(name, id)));
    }
  };
}
