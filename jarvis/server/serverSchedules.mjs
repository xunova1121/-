/**
 * 服务器上的定时任务 / 提醒：手机关着、电脑关机也照样到点执行（以前定时任务只在手机 / 电脑本机跑）。
 *
 *   - 存在服务器数据目录里（scheduler.js 的 kv），服务重启后接着按时执行；错过 12 小时内的补跑一次
 *   - 开始执行前先 claim（排好下一次）：做到一半服务重启，不会把同一次再跑一遍
 *   - 到点交给任务执行器（taskRunner）新开一段“⏰ 任务名”对话来做，结果就是那段对话
 *   - 做完记一条通知（notices）：手机 / 电脑开着（含后台待机）时取走并弹系统通知；
 *     App 被彻底关掉时收不到即时推送（没有接厂商推送），下次打开再补弹
 *   - 时间一律按北京时间（server.mjs 启动时把时区设为 Asia/Shanghai）
 */
import * as scheduler from '../src/agent/scheduler.js';
import { scheduledPrompt, parseReply, notificationFor } from '../src/agent/scheduledRun.js';
import * as sessions from '../src/agent/sessions.js';
import { collection } from '../src/agent/store.js';

const kv = collection('kv');
const NOTICES = 'scheduleNotices';
/** 最多留多少条通知（手机长时间没连上也只补最近这些） */
export const MAX_NOTICES = 50;
/** 一个定时任务最多等多久（任务执行器自己有“10 分钟没进展就中断”，这里只是兜底） */
const WAIT_MAX_MS = 60 * 60_000;

export async function notices(after = 0) {
  return ((await kv.get(NOTICES))?.items ?? []).filter((n) => n.at > after);
}
async function addNotice(n) {
  const items = [...((await kv.get(NOTICES))?.items ?? []), n].slice(-MAX_NOTICES);
  await kv.put({ id: NOTICES, items });
}

/**
 * @param {{ runner: object, tickMs?: number, now?: () => number, pollMs?: number }} o
 */
export function createServerSchedules({ runner, tickMs = 30_000, now = Date.now, pollMs = 1000 }) {
  let busy = false;
  let timer = null;

  /** 等任务执行器把这一次做完：返回 { ok, text, note } */
  async function waitTask(id) {
    const start = now();
    for (;;) {
      const t = runner.get(id);
      if (!t) return { ok: false, text: '', note: '任务记录丢失（服务器可能重启过）' };
      if (t.status === 'done') {
        const last = runner.events(id, 0)?.findLast((e) => e.type === 'task_state' && e.status === 'done');
        return { ok: true, text: String(last?.text ?? ''), note: '' };
      }
      if (t.status === 'error' || t.status === 'stopped') return { ok: false, text: '', note: t.error || (t.status === 'stopped' ? '被停止' : '执行出错') };
      if (now() - start > WAIT_MAX_MS) return { ok: false, text: '', note: '超过 1 小时没做完' };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** 执行一个定时任务（到点或用户点“立即运行”）：新开一段对话交给任务执行器 */
  async function runOne(s) {
    const sess = sessions.create();
    let res;
    try {
      const started = await runner.start({ sessionId: sess.id, text: scheduledPrompt(s, scheduler.describe(s)) });
      // 空对话不落盘，对话由任务执行器建好后再改标题（不然标题会是那句长长的任务说明）
      await runner.edit(sess.id, async (one) => {
        if (!one) return;
        Object.assign(one, { title: `⏰ ${s.title}`, titleSet: true });
        await sessions.save(one);
      });
      const done = await waitTask(started.id);
      const reply = parseReply(done.text);
      res = { ok: done.ok && Boolean(reply.text || reply.quiet), quiet: reply.quiet, text: reply.text, note: done.ok && !reply.text && !reply.quiet ? '没有得到结果' : done.note };
    } catch (e) {
      res = { ok: false, quiet: false, text: '', note: e?.message || String(e) };
    }
    const rec = await scheduler.recordRun(s.id, { ok: res.ok, quiet: res.quiet, session: sess.id, note: res.note, at: now() });
    const n = notificationFor(s, res, rec); // 【无需通知】时为 null
    if (n) await addNotice({ id: `${s.id}-${now()}`, at: now(), scheduleId: s.id, sessionId: sess.id, title: n.title, body: n.body.slice(0, 300) });
    return { sessionId: sess.id, ok: res.ok };
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const s of await scheduler.due(now())) {
        await scheduler.claim(s.id, now()); // 先排好下一次再执行：中途重启不会重复执行
        await runOne(s);
      }
    } catch (e) {
      console.warn('[定时任务]', e?.message || e);
    } finally {
      busy = false;
    }
  }

  /** 用户点“立即运行”：后台去做，马上返回；已有定时任务在跑时返回 false */
  function runNow(s) {
    if (busy) return false;
    busy = true;
    runOne(s)
      .catch((e) => console.warn('[定时任务]', e?.message || e))
      .finally(() => { busy = false; });
    return true;
  }

  return {
    tick,
    runOne,
    runNow,
    start() {
      if (timer) return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
      setTimeout(tick, 5000).unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    get busy() {
      return busy;
    }
  };
}
