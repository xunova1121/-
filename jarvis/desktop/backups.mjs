/**
 * 改文件前自动备份（桌面版，电脑上的文件）。思路参考开源的 Hermes Agent（tools/checkpoint_manager.py，MIT 许可）：
 * 改之前自动留一份、可以回滚、定期清理旧的。它用隐藏的 git 仓库给整个文件夹拍快照；
 * 未央的用户电脑上不一定有 git，所以按单个文件备份，只用 Node 自带的功能。
 *
 *   overwrite  覆盖写文件：旧文件复制进备份 → 恢复时写回
 *   create     新建文件：只记一笔 → 恢复时移到回收站
 *   move       移动 / 改名：只记从哪到哪 → 恢复时移回去（原位置被占用就不动）
 *   copy       复制：只记一笔 → 恢复时把复制出来的那份移到回收站
 *   delete     移到回收站：先复制一份进备份 → 恢复时复制回原位置（回收站清空了也能恢复）
 *
 * 恢复前会先把当前内容再备份一份，所以恢复本身也能撤销。
 * 存放：<数据目录>/backups/index.json + files/<id>；超过天数、总大小、单个文件份数的从最旧的开始删。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const LIMITS = {
  days: 30,
  totalBytes: 500 * 1024 * 1024,
  maxFile: 100 * 1024 * 1024, // 单个文件 / 文件夹超过这个大小不备份（会如实告诉用户）
  perPath: 20
};
const DAY = 86400_000;
const OP_NAMES = { overwrite: '覆盖', create: '新建', move: '移动', copy: '复制', delete: '删除' };

async function stat(p) {
  try { return await fs.stat(p); } catch { return null; }
}
/** 文件或整个文件夹的大小；超过 cap 就提前停（不必算完） */
async function sizeOf(p, cap = Infinity) {
  const st = await stat(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const d of await fs.readdir(p, { withFileTypes: true })) {
    total += await sizeOf(path.join(p, d.name), cap - total);
    if (total > cap) break;
  }
  return total;
}
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * @param {{ dir: string, limits?: Partial<typeof LIMITS>, now?: () => number, trash?: (p: string) => Promise<void> }} o
 *   trash：恢复“新建 / 复制”时把文件移到回收站（Electron 的 shell.trashItem）
 */
export function createBackups({ dir, limits = {}, now: clock = Date.now, trash = null }) {
  const L = { ...LIMITS, ...limits };
  // 时间严格递增：同一毫秒里的几次改动也能排出先后
  let last = 0;
  const now = () => (last = Math.max(clock(), last + 1));
  const indexFile = path.join(dir, 'index.json');
  const stored = (id) => path.join(dir, 'files', id);
  let seq = 0;
  const uid = () => `${now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // 读写 index.json 串行进行，避免两次操作同时改清单
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  async function load() {
    try { return JSON.parse(await fs.readFile(indexFile, 'utf8')); } catch { return []; }
  }
  async function save(list) {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list));
    await fs.rename(tmp, indexFile); // 先写临时文件再改名：写到一半断电也不会把清单弄坏
  }
  const drop = (e) => (e.stored ? fs.rm(stored(e.id), { recursive: true, force: true }) : Promise.resolve());

  /** 清理：超过天数的、同一路径超过份数的、总大小超限时最旧的 */
  async function pruneList(list) {
    const at = now();
    const keep = [];
    const removed = [];
    const perPath = new Map();
    for (const e of [...list].sort((a, b) => b.ts - a.ts)) {
      const n = (perPath.get(key(e.path)) ?? 0) + 1;
      perPath.set(key(e.path), n);
      if (at - e.ts > L.days * DAY || n > L.perPath) removed.push(e); else keep.push(e);
    }
    let total = keep.reduce((s, e) => s + (e.stored ? e.size : 0), 0);
    for (let i = keep.length - 1; i >= 0 && total > L.totalBytes; i--) {
      if (!keep[i].stored) continue;
      total -= keep[i].size;
      removed.push(...keep.splice(i, 1));
    }
    for (const e of removed) await drop(e);
    return keep;
  }

  /** 把 src 复制进备份；太大就不复制。返回 { stored, size } */
  async function copyIn(id, src) {
    const size = await sizeOf(src, L.maxFile);
    if (size > L.maxFile) return { stored: false, size };
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });
    await fs.cp(src, stored(id), { recursive: true });
    return { stored: true, size };
  }

  async function add(entry) {
    const list = await load();
    list.push(entry);
    await save(await pruneList(list));
    return entry;
  }

  const api = {
    LIMITS: L,

    /** 写文件之前：目标已存在就备份旧内容（overwrite），不存在就记一笔（create） */
    beforeWrite: (f, { note = '' } = {}) => serial(async () => {
      const st = await stat(f);
      const id = uid();
      if (!st) return add({ id, op: 'create', path: f, ts: now(), size: 0, stored: false, note });
      if (st.isDirectory()) throw new Error(`${f} 是文件夹，不能当作文件写入`);
      return add({ id, op: 'overwrite', path: f, ts: now(), ...(await copyIn(id, f)), note });
    }),
    /** 写完之后记下文件的修改时间：之后用户自己又改过的话，恢复前会提醒 */
    afterWrite: (entry, f) => serial(async () => {
      const st = await stat(f);
      const list = await load();
      const e = list.find((x) => x.id === entry?.id);
      if (!e || !st) return;
      e.mtimeAfter = st.mtimeMs;
      await save(list);
    }),
    recordMove: (from, to) => serial(() => add({ id: uid(), op: 'move', path: from, to, ts: now(), size: 0, stored: false })),
    recordCopy: (to) => serial(async () => {
      const st = await stat(to);
      return add({ id: uid(), op: 'copy', path: to, ts: now(), size: 0, stored: false, mtimeAfter: st?.mtimeMs });
    }),
    /** 移到回收站之前：复制一份进备份（太大的只记一笔，恢复时请用户从回收站还原） */
    beforeTrash: (f) => serial(async () => {
      const st = await stat(f);
      if (!st) throw new Error(`不存在：${f}`);
      const id = uid();
      return add({ id, op: 'delete', path: f, ts: now(), isDir: st.isDirectory(), ...(await copyIn(id, f)) });
    }),

    /** 给界面看的列表（新的在前） */
    list: () => serial(async () => (await load()).sort((a, b) => b.ts - a.ts).map((e) => ({ ...e, opName: OP_NAMES[e.op] ?? e.op }))),

    /** 恢复前检查：能不能恢复、有没有要提醒用户的 */
    check: ({ id }) => serial(async () => {
      const e = (await load()).find((x) => x.id === id);
      if (!e) throw new Error('找不到这条备份，可能已经过期被清理');
      return inspect(e);
    }),

    restore: ({ id }) => serial(async () => {
      const list = await load();
      const e = list.find((x) => x.id === id);
      if (!e) throw new Error('找不到这条备份，可能已经过期被清理');
      const why = await inspect(e);
      if (!why.ok) throw new Error(why.problem);
      const extra = [];
      const backupCurrent = async (p, note) => {
        const id2 = uid();
        const st = await stat(p);
        if (!st) return;
        // 恢复本身也能撤销：先把当前内容存一份
        list.push(st.isDirectory()
          ? { id: id2, op: 'delete', path: p, ts: now(), isDir: true, ...(await copyIn(id2, p)), note }
          : { id: id2, op: 'overwrite', path: p, ts: now(), ...(await copyIn(id2, p)), note });
        extra.push(id2);
      };
      if (e.op === 'overwrite' || e.op === 'delete') {
        await backupCurrent(e.path, '恢复前的内容');
        await fs.rm(e.path, { recursive: true, force: true });
        await fs.mkdir(path.dirname(e.path), { recursive: true });
        await fs.cp(stored(e.id), e.path, { recursive: true });
      } else if (e.op === 'create' || e.op === 'copy') {
        if (await stat(e.path)) {
          await backupCurrent(e.path, '撤销新建前的内容');
          if (!trash) throw new Error('无法移到回收站');
          await trash(e.path);
        }
      } else if (e.op === 'move') {
        await fs.mkdir(path.dirname(e.path), { recursive: true });
        await fs.rename(e.to, e.path);
      }
      e.restoredAt = now();
      await save(await pruneList(list));
      return { path: e.path, op: e.op };
    }),

    /** 清空全部备份 */
    clear: () => serial(async () => {
      await fs.rm(path.join(dir, 'files'), { recursive: true, force: true });
      await save([]);
    }),

    /** 占用空间 */
    usage: () => serial(async () => {
      const list = await load();
      return { count: list.length, bytes: list.reduce((s, e) => s + (e.stored ? e.size : 0), 0), limit: L.totalBytes };
    }),

    /** 启动时清理一次 */
    prune: () => serial(async () => save(await pruneList(await load())))
  };

  /** @returns {Promise<{ ok: boolean, problem?: string, warning?: string }>} */
  async function inspect(e) {
    const cur = await stat(e.path);
    const changed = cur && e.mtimeAfter && Math.abs(cur.mtimeMs - e.mtimeAfter) > 1;
    const warnChanged = changed ? '这个文件在未央改过之后又被改过，恢复会覆盖这些改动（当前内容会先备份）' : '';
    switch (e.op) {
      case 'overwrite':
      case 'delete':
        if (!e.stored) return { ok: false, problem: e.op === 'delete' ? `删除时文件太大，没有备份。请从回收站还原：${e.path}` : `覆盖时文件太大，没有备份旧内容：${e.path}` };
        if (!(await stat(stored(e.id)))) return { ok: false, problem: '备份文件不见了，无法恢复' };
        if (e.op === 'delete' && cur?.isDirectory()) return { ok: false, problem: `原位置已经有同名文件夹，为避免覆盖没有恢复：${e.path}` };
        return { ok: true, warning: warnChanged };
      case 'create':
      case 'copy':
        if (!cur) return { ok: false, problem: `文件已经不在了，不需要撤销：${e.path}` };
        return { ok: true, warning: changed ? '这个文件在未央建好之后又被改过，撤销会把它移到回收站（当前内容会先备份）' : '' };
      case 'move':
        if (cur) return { ok: false, problem: `原位置已经有同名文件，为避免覆盖没有移回：${e.path}` };
        if (!(await stat(e.to))) return { ok: false, problem: `找不到 ${e.to}，可能已经被移走或删除` };
        return { ok: true, warning: '' };
      default:
        return { ok: false, problem: '不认识的记录' };
    }
  }

  return api;
}
