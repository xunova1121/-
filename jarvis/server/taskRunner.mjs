/**
 * 服务器上的任务执行器：手机 / 电脑把任务交过来，服务器自己从头做到尾。
 * 发任务的那台设备关掉、断网都不影响；它再连上来时，按序号补发漏掉的进度，做完的结果存在对话里。
 *
 *   start({ sessionId, text })  记下用户的话，排队执行；同一个对话同时只做一个任务
 *   events(id, after)           序号大于 after 的进度事件（断线重连时补发）
 *   subscribe(id, fn)           之后的新事件实时推给 fn
 *   stop(id)                    用户叫停
 *
 * 和界面上的做法一致：模型分工、备用模型、项目规则、任务清单、收尾核对都由 runAgent 负责；
 * 这里只负责排队、存对话、记进度。手机上才有的能力（控制电脑、运行代码、语音）在服务器上不提供。
 */
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import * as sessions from '../src/agent/sessions.js';
import { unsummarized } from '../src/agent/compress.js';
import { collectRequirements } from '../src/agent/taskRequirements.js';
import { createAdapter } from '../src/llm/config.js';
import { providerById } from '../shared/providers.js';
import { routeFor, fallbackRoutes, classifyTask } from '../src/llm/router.js';
import { INTERRUPTED_MARK } from '../src/core/suggest.js';
import { uid } from '../src/agent/store.js';

/** 服务器上不提供的工具：浏览器里的代码沙箱、预览窗口、本机指标、定时任务（定时任务还在手机 / 电脑上跑） */
export const SERVER_BLOCKED = new Set(['run_javascript', 'run_python', 'preview', 'get_local_metrics', 'schedule_task', 'list_schedules', 'cancel_schedule']);
/** 连续这么久没有任何进展（模型输出、工具事件）就中断，记为失败 */
export const IDLE_MS = 10 * 60_000;
/** 做完的任务在内存里留多久（之后只在对话记录里） */
const KEEP_DONE_MS = 2 * 3600_000;
/** 一个任务最多记这么多条进度事件（文字是一小段一小段来的，超了就把旧的文字段合并） */
const MAX_EVENTS = 3000;

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…（已截断）` : s);

/**
 * @param {{ getConfig: () => Promise<object>, maxRunning?: number, maxSteps?: number, idleMs?: number, makeTools?: (ctx: object) => object[], makeAdapter?: typeof createAdapter, now?: () => number }} o
 */
export function createTaskRunner({ getConfig, maxRunning = 1, maxSteps = 28, idleMs = IDLE_MS, makeTools = createTools, makeAdapter = createAdapter, now = Date.now }) {
  const tasks = new Map();
  const waiting = [];
  let running = 0;

  function record(task, e) {
    const ev = { ...e, seq: ++task.seq, at: now() };
    if (ev.type === 'tool_end') ev.output = clip(ev.output, 4000);
    task.events.push(ev);
    if (task.events.length > MAX_EVENTS) compact(task);
    for (const fn of task.listeners) { try { fn(ev); } catch { /* 某个连接写不进去：不影响任务 */ } }
  }
  // 事件太多时：把最前面一半里连续的文字段并成一条（序号保留最后那条的），进度卡片照样能重建
  function compact(task) {
    const half = task.events.splice(0, Math.floor(task.events.length / 2));
    const merged = [];
    for (const ev of half) {
      const last = merged.at(-1);
      if (ev.type === 'text' && last?.type === 'text') { last.delta += ev.delta; last.seq = ev.seq; } else merged.push({ ...ev });
    }
    task.events.unshift(...merged);
  }

  /** 给模型用的辅助调用（深度调研、逐项查证等工具用） */
  function helper(cfg, kind) {
    const { adapter, model, problem } = createAdapter(routeFor(cfg, kind).cfg);
    if (problem || providerById(cfg.provider)?.kind === 'mock') return null;
    return async ({ system, prompt, signal, images }) => {
      let text = '';
      const r = await adapter.stream({ model, system: [system], messages: [{ role: 'user', content: prompt, ...(images?.length && { images }) }], tools: [], signal, onText: (d) => { text += d; } });
      return r?.text || text;
    };
  }

  async function execute(task) {
    task.status = 'running';
    task.startedAt = now();
    console.log(`[任务] ${task.id} 开始：${task.text.slice(0, 40).replace(/\s+/g, ' ')}`);
    record(task, { type: 'task_state', status: 'running' });
    const session = await sessions.get(task.sessionId);
    const cfg = await getConfig();
    const route = routeFor(cfg, classifyTask(task.text));
    const { adapter, model, problem } = makeAdapter(route.cfg);
    if (problem) return finish(task, session, { error: `服务器上的模型还没配置好：${problem}` });
    const fallbacks = fallbackRoutes(cfg, { provider: route.cfg.provider, model }).map((f) => ({ ...createAdapter(f.cfg), label: f.model })).filter((f) => !f.problem && f.adapter && f.model);
    const history = session.messages.slice(0, -1); // 最后一条是这次的用户原话，单独作为 userText
    const tools = makeTools({
      tavilyKey: cfg.tavilyKey, bochaKey: cfg.bochaKey, searchRegion: cfg.searchRegion || 'auto',
      llm: helper(cfg, 'write'), reasonLlm: helper(cfg, 'reason'),
      onFileChanged: (p) => { if (!/^skills\//.test(p)) { task.files.add(p); record(task, { type: 'file', path: p }); } },
      onImage: (src) => record(task, { type: 'image', src: clip(src, 300) }),
      currentSessionId: () => session.id
    }).filter((t) => !SERVER_BLOCKED.has(t.name));

    let shown = '';
    const usedTools = [];
    let idle;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { task.idle = true; task.ctrl.abort(); }, idleMs); };
    arm();
    try {
      const r = await runAgent({
        adapter, model, fallbacks, maxSteps,
        history: unsummarized(history, session.summary).map(({ role, content }) => ({ role, content })),
        userText: task.text, requirementText: task.text,
        sessionId: session.id, summary: session.summary ?? null,
        requirements: collectRequirements(session.messages, session.requirements),
        inbox: task.inbox,
        signal: task.ctrl.signal,
        tools,
        // 服务器上没人能点“确认”：需要确认的操作（删除、覆盖等）一律不做，模型会改用别的办法或在回答里说明
        approve: async () => false,
        emit: (e) => {
          arm();
          if (e.type === 'text') { if (!task.firstTextAt) task.firstTextAt = now(); shown += e.delta; }
          if (e.type === 'tool_start' && e.name !== 'update_plan') usedTools.push(e.name);
          record(task, e);
        }
      });
      return finish(task, session, { text: r.text, usedTools, toolCalls: r.toolCalls ?? 0 });
    } catch (err) {
      const stopped = task.ctrl.signal.aborted && !task.idle;
      return finish(task, session, { error: stopped ? '' : task.idle ? '连续 10 分钟没有进展，已中断' : String(err?.message || err), stopped, shown, usedTools });
    } finally {
      clearTimeout(idle);
    }
  }

  async function finish(task, session, { text = '', error = '', stopped = false, shown = '', usedTools = [], toolCalls = 0 }) {
    const extra = { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(task.files.size && { files: [...task.files].slice(-12) }) };
    const fresh = (await sessions.get(task.sessionId)) ?? session; // 期间用户可能改了标题等
    if (fresh) {
      if (!error && !stopped) fresh.messages.push({ role: 'assistant', content: text || '（完成）', ts: now(), ...extra });
      else if (shown.trim() || usedTools.length) fresh.messages.push({ role: 'assistant', content: `${shown.trim()}\n\n${stopped ? '（已打断）' : INTERRUPTED_MARK}`, ts: now(), ...extra });
      fresh.updatedAt = now();
      await sessions.save(fresh).catch((e) => console.error(`[任务] ${task.id} 回答没存上：${e?.stack || e}`));
    }
    task.status = stopped ? 'stopped' : error ? 'error' : 'done';
    task.endedAt = now();
    // 记一笔用时，方便查“为什么慢”：journalctl -u jarvis 能看到
    const sec = (t) => (t && task.startedAt ? `${((t - task.startedAt) / 1000).toFixed(1)}s` : '—');
    console.log(`[任务] ${task.id} ${task.status}：排队 ${task.startedAt ? ((task.startedAt - task.createdAt) / 1000).toFixed(1) : '—'}s，首字 ${sec(task.firstTextAt)}，共 ${sec(task.endedAt)}，工具 ${usedTools.length} 次${error ? `，出错：${error.slice(0, 120)}` : ''}`);
    task.error = error;
    record(task, { type: 'task_state', status: task.status, ...(error && { error }), ...(task.status === 'done' && { text, toolCalls }), files: [...task.files] });
    task.listeners.clear();
    running--;
    pump();
    setTimeout(() => tasks.delete(task.id), KEEP_DONE_MS).unref?.();
  }

  function pump() {
    while (running < maxRunning && waiting.length) {
      const task = waiting.shift();
      if (task.status !== 'queued') continue;
      running++;
      execute(task).catch((err) => finish(task, null, { error: String(err?.message || err) }));
    }
  }

  return {
    /** @returns {Promise<{ id: string, sessionId: string }>} */
    async start({ sessionId = null, text }) {
      text = String(text ?? '').trim();
      if (!text) throw Object.assign(new Error('任务内容是空的'), { status: 400 });
      if (text.length > 20000) throw Object.assign(new Error('任务内容太长'), { status: 400 });
      if (sessionId !== null && !/^[\w-]{1,40}$/.test(String(sessionId))) throw Object.assign(new Error('对话编号不对'), { status: 400 });
      // 手机 / 电脑上新建的对话第一次发任务时，服务器上还没有：用同一个编号新建
      let session = sessionId ? await sessions.get(sessionId) : null;
      const busy = session && [...tasks.values()].find((t) => t.sessionId === session.id && (t.status === 'queued' || t.status === 'running'));
      if (busy) {
        // 正在干活时又发来一句：不打断，交给正在干的未央（下一步开始前看到）
        busy.inbox.push(text);
        session.messages.push({ role: 'user', content: text, ts: now() });
        await sessions.save(session);
        record(busy, { type: 'user_note', text });
        return { id: busy.id, sessionId: session.id, joined: true };
      }
      session ??= sessionId ? { ...sessions.create(), id: sessionId } : sessions.create();
      session.messages.push({ role: 'user', content: text, ts: now() });
      session.updatedAt = now();
      await sessions.save(session);
      const task = { id: uid('t'), sessionId: session.id, text, status: 'queued', seq: 0, events: [], listeners: new Set(), files: new Set(), inbox: [], ctrl: new AbortController(), createdAt: now() };
      tasks.set(task.id, task);
      record(task, { type: 'task_state', status: 'queued', position: waiting.length + running });
      waiting.push(task);
      pump();
      return { id: task.id, sessionId: session.id };
    },
    get(id) {
      const t = tasks.get(id);
      return t && { id: t.id, sessionId: t.sessionId, text: t.text, status: t.status, seq: t.seq, files: [...t.files], error: t.error || '', createdAt: t.createdAt, startedAt: t.startedAt ?? null, endedAt: t.endedAt ?? null };
    },
    list() { return [...tasks.keys()].map((id) => this.get(id)); },
    events(id, after = 0) { return tasks.get(id)?.events.filter((e) => e.seq > after) ?? null; },
    subscribe(id, fn) {
      const t = tasks.get(id);
      if (!t || t.status === 'done' || t.status === 'error' || t.status === 'stopped') return null;
      t.listeners.add(fn);
      return () => t.listeners.delete(fn);
    },
    stop(id) {
      const t = tasks.get(id);
      if (!t) return false;
      if (t.status === 'queued') { t.status = 'stopped'; running++; finish(t, null, { stopped: true }); return true; }
      if (t.status === 'running') { t.ctrl.abort(); return true; }
      return false;
    },
    get running() { return running; }
  };
}
