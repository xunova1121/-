/**
 * 用量账本：这个项目到底发出去了多少东西。
 *
 * ══════════ 只存用量，不存钱 ══════════
 *
 * 落盘的是「几张图、多少 token、多少秒」，**不是**「花了多少钱」。
 * 钱在读的时候按当前单价现算。这一条决定了两件事：
 *
 *   · 今天没填单价、下个月才填的人，**过去的账会自动亮起来** ——
 *     用量一直在那儿，缺的只是一个乘数。要是当初按"未知=0"存成了钱，
 *     那些记录就永远是 0，而且再也补不回来了。
 *   · 换了供应商、谈下了新价钱，历史也跟着按新价重算。
 *     存成钱的话，一份账里会混着好几个时代的价格，谁也说不清哪条是哪个。
 *
 * ══════════ 为什么按 (厂商, 模型, 口径) 聚合，而不是流水账 ══════════
 *
 * 流水账会无限长，而这是个跑着跑着就几百上千次调用的应用 ——
 * 一个项目做完，光出图重试就可能上百条。聚合之后每个项目只占几行，
 * 可以**永不淘汰**。另外留一小段 recent 流水，是为了"刚才那一下花了什么"
 * 这种当场要看的问题；它可以淘汰，因为总数不靠它。
 *
 * ══════════ 异步任务（出视频）的账怎么记 ══════════
 *
 * 只在**真的拿到片子**之后记，按回来的秒数记。
 *
 * 曾经想过"下单就记，失败再冲账"，好处是轮询那几分钟界面上就有数了。
 * 放弃了：那套要在账本里挂一份 taskId → 待定笔数的表，而"结局永远不来"
 * 的任务（进程被关、轮询超时）会让那笔账永远挂着，最后账本里全是
 * **看不出真假的虚账**。为几分钟的即时反馈换一个会慢慢烂掉的账本，不值。
 *
 * 代价是轮询期间账上还没有这一笔 —— 那几分钟由**预估**去回答
 * （见 pricing.estimate 那条路），预估本来就是干这个的。
 * 拿不到结果的那些次记成"漏账"（addUnmetered），不猜数也不装没发生。
 */
import fs from 'node:fs';
import { DATA_DIR } from './paths.js';
import path from 'node:path';
import * as pricing from './pricing.js';

const LEDGER_FILE = path.join(DATA_DIR, 'spend.json');
/** 流水只留这么多条。总数不靠它，淘汰了也不丢账。 */
const MAX_RECENT = 400;

const EMPTY = { version: 1, projects: {}, recent: [] };

let book = null;
let seq = 0;

function load() {
  if (book) return book;
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    book = {
      version: 1,
      projects: parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
      recent: Array.isArray(parsed?.recent) ? parsed.recent.slice(-MAX_RECENT) : []
    };
  } catch {
    book = { ...EMPTY, projects: {}, recent: [] };
  }
  return book;
}

let timer = null;
function schedulePersist() {
  if (timer) return;
  // 和 logbus 一样攒一下再写：出图那一步会连着记几十条
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${LEDGER_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(book), 'utf8');
      fs.renameSync(tmp, LEDGER_FILE);
    } catch {
      /* 记账写不进去不该带崩正在跑的片子 */
    }
  }, 600);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 测试用：立刻落盘，不等攒批 */
export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!book) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${LEDGER_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(book), 'utf8');
    fs.renameSync(tmp, LEDGER_FILE);
  } catch {
    /* 同上 */
  }
}

function bucketOf(projectId, key, seed) {
  const b = load();
  const pid = projectId || '(未归属)';
  const proj = (b.projects[pid] ||= { usage: {}, calls: 0, unmetered: 0, firstAt: new Date().toISOString(), lastAt: null });
  const cell = (proj.usage[key] ||= {
    provider: seed.provider,
    model: seed.model,
    kind: seed.kind,
    units: pricing.KINDS[seed.kind]?.pair ? { in: 0, out: 0 } : 0,
    calls: 0
  });
  return { proj, cell };
}

function addUnits(cell, kind, units, sign = 1) {
  if (pricing.KINDS[kind]?.pair) {
    cell.units.in = Math.max(0, cell.units.in + sign * (Number(units?.in) || 0));
    cell.units.out = Math.max(0, cell.units.out + sign * (Number(units?.out) || 0));
  } else {
    cell.units = Math.max(0, cell.units + sign * (Number(units) || 0));
  }
}

/**
 * 记一笔。
 *
 * units 必须是**从响应里读出来的**，不是下单时的打算 —— 这是整个功能的地基。
 * 读不出来就别记（返回 null），记一个猜的数比不记坏：不记的时候用量表上
 * 少一条，明显；记错的时候用量表上多一条**看起来正常的假数**。
 */
export function add({ projectId = null, stage = '', provider, model, kind, units, note = '' } = {}) {
  if (!pricing.isKind(kind)) return null;
  if (!provider) return null;
  const hasUnits = pricing.KINDS[kind].pair
    ? Number.isFinite(Number(units?.in)) || Number.isFinite(Number(units?.out))
    : Number.isFinite(Number(units)) && Number(units) > 0;
  if (!hasUnits) return null;

  const b = load();
  const key = pricing.rateKey(provider, model, kind);
  const { proj, cell } = bucketOf(projectId, key, { provider, model, kind });
  addUnits(cell, kind, units, 1);
  cell.calls += 1;
  proj.calls += 1;
  proj.lastAt = new Date().toISOString();

  const entry = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    at: proj.lastAt,
    projectId: projectId || null,
    stage,
    provider,
    model,
    kind,
    units: pricing.KINDS[kind].pair ? { in: Number(units?.in) || 0, out: Number(units?.out) || 0 } : Number(units),
    note
  };
  b.recent.push(entry);
  if (b.recent.length > MAX_RECENT) b.recent = b.recent.slice(-MAX_RECENT);

  schedulePersist();
  return entry;
}

/**
 * 这一次没能记上账。
 *
 * 厂商没回用量（少数家的 usage 字段是空的）、或者只回了个 total_tokens
 * 拆不开进出 —— 这时候**什么都不记，但要记住"漏了一次"**。
 *
 * 为什么不估一个数填进去：估出来的用量在账本里和真的长得一模一样，
 * 而它会让总数偏离真值，还没人看得出来。宁可界面上写着
 * "另有 3 次调用厂商没回用量"—— 那是一句难看但正确的话。
 */
export function addUnmetered({ projectId = null, provider = '', model = '', kind = '', why = '' } = {}) {
  const b = load();
  const pid = projectId || '(未归属)';
  const proj = (b.projects[pid] ||= { usage: {}, calls: 0, unmetered: 0, firstAt: new Date().toISOString(), lastAt: null });
  proj.unmetered = (proj.unmetered || 0) + 1;
  proj.lastAt = new Date().toISOString();
  /**
   * 记下**是谁**没回用量，不只是"漏了几次"。
   * "有 12 次没记上"没法处理；"豆包 seedream 那家从来不回用量"可以 ——
   * 那是一条能拿去问厂商、或者换一家的线索。
   */
  const blind = (proj.blind ||= {});
  const key = pricing.rateKey(provider, model, kind);
  blind[key] = { provider, model, kind, hits: (blind[key]?.hits || 0) + 1, why: why || blind[key]?.why || '' };
  schedulePersist();
  return proj.unmetered;
}

function itemsOf(proj) {
  return Object.values(proj?.usage || {}).map((c) => ({ ...c, calls: c.calls }));
}

/** 一个项目的账。rates 变了这里立刻跟着变 —— 因为钱是现算的。 */
export function forProject(projectId, rates = {}) {
  const b = load();
  const proj = b.projects[projectId || '(未归属)'];
  if (!proj) {
    return { projectId, calls: 0, unmetered: 0, blind: [], total: pricing.sum([], rates), items: [], firstAt: null, lastAt: null };
  }
  const items = itemsOf(proj);
  return {
    projectId,
    calls: proj.calls || 0,
    /** 漏记的次数一定要跟着总数一起走出去，不然界面没法说那句"另有 N 次没记上" */
    unmetered: proj.unmetered || 0,
    blind: Object.values(proj.blind || {}).sort((a, b2) => b2.hits - a.hits),
    firstAt: proj.firstAt || null,
    lastAt: proj.lastAt || null,
    total: pricing.sum(items, rates),
    items
  };
}

/** 全部项目合起来 */
export function overall(rates = {}) {
  const b = load();
  const items = [];
  let unmetered = 0;
  for (const proj of Object.values(b.projects)) {
    items.push(...itemsOf(proj));
    unmetered += proj.unmetered || 0;
  }
  return {
    projects: Object.keys(b.projects).length,
    unmetered,
    total: pricing.sum(items, rates),
    byProject: Object.entries(b.projects)
      .map(([id, proj]) => ({
        projectId: id,
        calls: proj.calls || 0,
        unmetered: proj.unmetered || 0,
        total: pricing.sum(itemsOf(proj), rates),
        lastAt: proj.lastAt || null
      }))
      .sort((a, b2) => String(b2.lastAt || '').localeCompare(String(a.lastAt || '')))
  };
}

export function recent({ projectId = null, limit = 60 } = {}) {
  const b = load();
  let out = b.recent;
  if (projectId) out = out.filter((e) => e.projectId === projectId);
  return out.slice(-limit).reverse();
}

export function clearProject(projectId) {
  const b = load();
  const pid = projectId || '(未归属)';
  if (!b.projects[pid]) return false;
  delete b.projects[pid];
  b.recent = b.recent.filter((e) => (e.projectId || '(未归属)') !== pid);
  schedulePersist();
  return true;
}

/** 测试用：把内存里那份丢掉，下次从盘上重读 */
export function reset({ wipe = false } = {}) {
  book = null;
  if (wipe) {
    try {
      fs.unlinkSync(LEDGER_FILE);
    } catch {
      /* 本来就没有 */
    }
  }
}

export { LEDGER_FILE };
