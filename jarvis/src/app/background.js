/**
 * 后台的事：自动整理记忆、长对话压缩、回到电脑前主动问好、操作习惯学习（桌面版）、定时任务、系统通知。
 */
import { MOBILE } from '../config.js';
import { createAdapter } from '../llm/config.js';
import { runAgent } from '../agent/agent.js';
import * as agentMemory from '../agent/memory.js';
import * as compress from '../agent/compress.js';
import * as habits from '../agent/habits.js';
import * as scheduler from '../agent/scheduler.js';
import * as sessionsApi from '../agent/sessions.js';
import { executeScheduled, scheduledPrompt, notificationFor } from '../agent/scheduledRun.js';
import { preApproved } from '../agent/commandSafety.js';
import { composeGreeting, GREET_GAP_MS } from '../core/greeting.js';
import { initSchedulesPanel } from '../ui/schedulesPanel.js';
import { $, DESKTOP, toast, wp } from './env.js';

export function createBackground(app) {
  /** 自动整理记忆：对话停下来 30 秒后、切到别的对话或 App 退到后台时，把这段对话交给记忆整理（抽取事实、写摘要）。
   *  不能等太久：用户常常说完就开新对话，或者手机直接切走 */
  app.reflectFrom = app.history.length;
  let reflectTimer = 0;
  function scheduleReflect() {
    if (app.server) return; // 服务器模式：记忆在服务器上，本机不整理
    clearTimeout(reflectTimer);
    if (!app.settings.autoMemory) return;
    reflectTimer = setTimeout(reflectNow, 30_000);
  }
  async function reflectNow({ manual = false } = {}) {
    clearTimeout(reflectTimer);
    // 服务器自己整理；pagehide不能绕过scheduleReflect的运行位置与评测隔离。
    if (app.server || app.session?.evaluationId) return;
    const turns = app.history.slice(app.reflectFrom);
    if (!turns.some((t) => t.role === 'user')) {
      if (manual) toast('没有新的对话需要整理');
      return;
    }
    app.reflectFrom = app.history.length;
    try {
      const title = app.session.titleSet ? app.session.title : sessionsApi.autoTitle(app.history.find((m) => m.role === 'user')?.content);
      const r = await agentMemory.reflect(turns, { session: { id: app.session.id, title } });
      const n = r.memories.filter((m) => m.action !== 'NOOP').length;
      if (n || manual) toast(`记忆已整理：新增或更新 ${n} 条${r.episode ? '，并记下这段对话的摘要' : ''}`);
      app.panels.refreshMind();
    } catch (e) {
      console.warn('[memory] 整理失败', e);
    }
  }
  addEventListener('pagehide', () => {
    if (app.settings.autoMemory) reflectNow();
  });
  // 手机切到后台时不一定有 pagehide（之后可能被系统直接杀掉）：页面一隐藏就整理
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.settings.autoMemory && !app.active) reflectNow();
  });

  /** 长对话压缩：回答完后在后台把较早的消息并进“前情提要”（见 compress.js），不影响当前对话 */
  let compressing = false;
  async function compressHistory() {
    if (app.server) return;
    const s = app.session;
    if (compressing || !compress.dueForCompression(s.messages, s.summary).length) return;
    compressing = true;
    try {
      const next = await compress.updateSummary(s.messages, s.summary, { llm: app.helperLlm() });
      if (next && next !== s.summary) {
        s.summary = next;
        if (app.settings.saveSessions !== false) sessionsApi.save(s).catch(() => {});
        app.hud.think(`◆ 较早的对话已压缩成摘要${next.by === 'rule' ? '（本地规则）' : ''}`);
      }
    } catch (e) {
      console.warn('[compress]', e);
    } finally {
      compressing = false;
    }
  }

  // ---------------------------------------------------------------- 主动问好：你回到电脑前时
  let lastGreetAt = (() => {
    try {
      return Number(localStorage.getItem('jarvis.lastGreet')) || 0;
    } catch {
      return 0;
    }
  })();
  /**
   * @param {{ awayMs: number, reason?: string, force?: boolean }} info
   * @returns {Promise<string|null>} 说了什么（没说返回 null）
   */
  async function greetOnReturn({ awayMs, reason = '', force = false }) {
    if (!force && (!app.settings.greetOnReturn || app.active || Date.now() - lastGreetAt < GREET_GAP_MS || awayMs < 10 * 60_000)) return null;
    lastGreetAt = Date.now();
    try {
      localStorage.setItem('jarvis.lastGreet', String(lastGreetAt));
    } catch {
      /* 隐私模式 */
    }
    const [core, schedules, open, habitTips] = await Promise.all([
      agentMemory
        .getCore()
        .then(agentMemory.cleanCore)
        .catch(() => ({})), // 去掉像注入指令的行
      scheduler.list().catch(() => []),
      agentMemory.openItems({ k: 2 }).catch(() => []),
      habitHints().catch(() => [])
    ]);
    const { text } = await composeGreeting({
      awayMs,
      coreHuman: core.human,
      schedules: schedules.filter((x) => x.enabled),
      openItems: open,
      habits: habitTips,
      llm: app.helperLlm()
    });
    // 很久没说话的旧对话：开一段新的，问候放在新对话里
    const lastTs = app.history.at(-1)?.ts ?? 0;
    if (app.history.length && Date.now() - lastTs > 3 * 3600_000) await app.switchTo(sessionsApi.create());
    const b = app.transcript.add('agent', text);
    b.el.classList.add('proactive');
    b.done(`主动问候 · ${reason === 'face' ? '看到你回来了' : '你回到电脑前'}`);
    app.rememberTurn('assistant', text, { proactive: true });
    app.director.onEmotion('亲和');
    wp({ say: text, emotion: '亲和' });
    app.hud.think(`◆ 主动问候（离开 ${Math.round(awayMs / 60000)} 分钟）`);
    if (app.settings.readTyped) app.speaker.speak(text);
    if (document.hidden && DESKTOP && !app.settings.readTyped) DESKTOP.invoke('notify', { title: '未央', body: text }).catch(() => {});
    app.openingCallouts();
    return text;
  }
  /** 习惯提示（操作习惯学习开启后才有，见 habits.js） */
  const habitHints = async () => habits.hintFor(await habits.load());

  // ---------------------------------------------------------------- 操作习惯学习（桌面版，默认关闭）
  /** 把习惯结论写进记忆（每天最多一次，或手动） */
  async function memorizeHabits({ manual = false } = {}) {
    const r = habits.insightsFrom(await habits.load());
    if (!r.ready) {
      if (manual) toast(`再观察几天：已有 ${r.days} 天的记录，至少要 3 天才总结习惯`);
      return 0;
    }
    const today = new Date().toDateString();
    let last = '';
    try {
      last = localStorage.getItem('jarvis.habitsMemorized') || '';
    } catch {
      /* 隐私模式 */
    }
    if (!manual && last === today) return 0;
    for (const text of r.insights) await agentMemory.remember(`用户${text}`, 'habit', { importance: 2, source: 'habits' });
    try {
      localStorage.setItem('jarvis.habitsMemorized', today);
    } catch {
      /* 隐私模式 */
    }
    app.panels.refreshMind();
    renderHabits();
    if (manual) toast(`已把 ${r.insights.length} 条习惯写进记忆`);
    return r.insights.length;
  }
  async function renderHabits() {
    const box = $('#habit-insights');
    if (!box) return;
    const r = habits.insightsFrom(await habits.load());
    const lines = r.ready ? r.insights : [`已记录 ${r.days} 天、约 ${r.hours} 小时。至少观察 3 天后开始总结。`];
    box.replaceChildren(...lines.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  }
  if (DESKTOP) {
    DESKTOP.onActivity?.((sample) => {
      habits.record(sample);
    });
    setInterval(() => {
      habits
        .flush()
        .then(() => memorizeHabits())
        .catch(() => {});
    }, 60_000);
  }

  // 网页版：标签页隐藏 30 分钟以上再回来，也算“回来了”
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (!DESKTOP && hiddenAt && Date.now() - hiddenAt >= 30 * 60_000) greetOnReturn({ awayMs: Date.now() - hiddenAt, reason: 'tab' });
    hiddenAt = 0;
  });

  // ---------------------------------------------------------------- 定时任务
  /** 系统通知：桌面版用系统通知；网页版用浏览器通知（需要授权），并总是弹一条提示 */
  function notify(title, body) {
    toast(`${title}：${body.slice(0, 60)}`);
    if (DESKTOP) {
      DESKTOP.invoke('notify', { title, body }).catch(() => {});
      return;
    }
    if (MOBILE) {
      globalThis.__jarvisBackgroundTask?.notifyDone?.({ title, body: body.slice(0, 300) }).catch(() => {});
      return;
    }
    try {
      if (Notification.permission === 'granted') new Notification(title, { body });
    } catch {
      /* 不支持 */
    }
  }
  let schedulerBusy = false;
  /** 在后台执行一个定时任务：结果存成一段对话（不打断当前对话），并通知 */
  async function runScheduled(s) {
    const releaseTask = app.taskKeeper.begin();
    try {
      const sess = sessionsApi.create();
      sess.title = `⏰ ${s.title}`;
      sess.titleSet = true;
      sess.messages.push({ role: 'user', content: s.prompt, ts: Date.now() });
      const usedTools = [];
      const { adapter, model, problem } = createAdapter(app.llmConfig, { gateway: app.gateway });
      // 卡住保护、空回复、【无需通知】见 scheduledRun.js
      const res = problem
        ? { ok: false, quiet: false, text: '', note: problem }
        : await executeScheduled(
            async ({ signal, emit }) =>
              runAgent({
                adapter,
                model,
                history: [],
                sessionId: sess.id,
                signal,
                emit,
                userText: scheduledPrompt(s, scheduler.describe(s)),
                tools: await app.buildTools({ background: true }),
                // 无人值守：需要确认的操作默认拒绝，除非这个任务设为“允许无人值守操作”或本次会话已允许；危险命令一律拒绝
                approve: async (req) => preApproved(req, { sessionKeys: app.sessionApprovals, unattended: s.unattended })
              }),
            {
              onEvent: (e) => {
                if (e.type === 'tool_start') usedTools.push(e.name);
              }
            }
          );
      const content = res.ok ? res.text || '（已检查，无需通知）' : `执行失败：${res.note}`;
      sess.messages.push({ role: 'assistant', content, ts: Date.now(), ...(usedTools.length && { tools: [...new Set(usedTools)] }) });
      sess.updatedAt = Date.now();
      await sessionsApi.save(sess).catch(() => {});
      const rec = await scheduler.recordRun(s.id, { ok: res.ok, quiet: res.quiet, session: sess.id, note: res.note });
      const n = notificationFor(s, res, rec); // 【无需通知】时为 null
      if (n) notify(n.title, n.body);
      app.sessionsPanel?.refresh();
      schedulesPanel?.refresh();
      return sess;
    } finally {
      releaseTask();
    }
  }
  async function schedulerTick() {
    if (schedulerBusy || app.active) return; // 正在对话时先等一等，不抢资源
    schedulerBusy = true;
    try {
      for (const s of await scheduler.due()) {
        await scheduler.claim(s.id); // 先排好下一次再执行：中途崩溃重启后不会重复执行
        await runScheduled(s);
      }
    } catch (e) {
      console.warn('[scheduler]', e);
    } finally {
      schedulerBusy = false;
    }
  }

  let schedulesPanel = null;
  /** 定时任务面板，并开始按时检查（启动末尾调用） */
  function initSchedules() {
    schedulesPanel = initSchedulesPanel({
      toast: (t) => toast(t),
      runNow: async (s) => {
        if (schedulerBusy) {
          toast('有任务正在运行，稍后再试');
          return;
        }
        schedulerBusy = true;
        try {
          const sess = await runScheduled(s);
          await app.openSession(sess.id);
        } finally {
          schedulerBusy = false;
        }
      },
      openSession: (id) => app.openSession(id)
    });
    setInterval(schedulerTick, 30_000);
    setTimeout(schedulerTick, 4000);
  }

  return {
    scheduleReflect,
    reflectNow,
    compressHistory,
    greetOnReturn,
    memorizeHabits,
    renderHabits,
    notify,
    runScheduled,
    schedulerTick,
    initSchedules,
    get reflectTimer() {
      return reflectTimer;
    },
    get schedulesPanel() {
      return schedulesPanel;
    }
  };
}
