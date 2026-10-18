import { renderOffice } from './officeRender.mjs';
import { createHash } from 'node:crypto';
import { checkpointEvent, checkpointNeedsReview } from '../shared/taskCheckpoint.js';
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
import dns from 'node:dns/promises';
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import * as sessions from '../src/agent/sessions.js';
import { unsummarized, dueForCompression, updateSummary } from '../src/agent/compress.js';
import * as memory from '../src/agent/memory.js';
import { collectRequirements } from '../src/agent/taskRequirements.js';
import { createAdapter } from '../src/llm/config.js';
import { generateImage } from '../src/llm/images.js';
import { generateVideo } from '../src/llm/videos.js';
import { providerById, isPrivateHost } from '../shared/providers.js';
import { routeFor, fallbackRoutes, classifyTask, effortFor, isSmallTalk } from '../src/llm/router.js';
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

/** 做到一半时先存进对话的半截回答结尾的标记；做完会换成完整回答 */
export const DRAFT_MARK = '（还在做，做完会更新这里）';
/** 半截回答多久存一次 */
export const DRAFT_MS = { value: 10_000 };

/** 随任务发来的图片：最多几张、每张多大（base64 字符数） */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

/**
 * 服务器上联网（搜索、读网页、查天气）：服务器没有浏览器的跨域限制，直接请求；
 * 但只许访问公网地址，每一跳重定向都重新检查（不让模型借机访问服务器内网的面板、数据库）
 */
export async function publicFetch(url, init = {}, fetchImpl = globalThis.fetch, lookup = (h) => dns.lookup(h, { all: true })) {
  let u = new URL(url);
  for (let hop = 0; ; hop++) {
    // 域名也要查一下解析到哪：指向 127.0.0.1 这类内网地址的域名同样不许访问
    const addrs = /^https?:$/.test(u.protocol) && !isPrivateHost(u.hostname) ? await lookup(u.hostname.replace(/^\[|\]$/g, '')).catch(() => []) : null;
    if (!addrs || addrs.some((a) => isPrivateHost(a.address))) throw new Error('只允许访问公网 http(s) 地址');
    const res = await fetchImpl(u, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(20000) });
    const loc = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400 && loc)) return res;
    if (hop >= 5) throw new Error('重定向次数过多');
    u = new URL(loc, u);
  }
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…（已截断）` : s);

/**
 * @param {{ getConfig: () => Promise<object>, maxRunning?: number, maxSteps?: number, idleMs?: number, makeTools?: (ctx: object) => object[], makeAdapter?: typeof createAdapter, now?: () => number }} o
 */
export function createTaskRunner({ getConfig, maxRunning = 1, maxSteps = 28, idleMs = IDLE_MS, makeTools = createTools, makeAdapter = createAdapter, now = Date.now }) {
  const tasks = new Map();
  const waiting = [];
  let running = 0;
  const locks = new Map();
  const background = new Set(); // 做完后在后台整理记忆、压缩对话的活（settled() 等它们做完）

  /** 同一段对话的“读出来 → 改 → 存回去”排队做：几处同时改时，后存的不会冲掉先存的 */
  function editSession(id, fn) {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => fn(await sessions.get(id)));
    locks.set(id, next);
    next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  }

  // 上次服务器重启时没做完的任务：存下的半截回答标成“没完成”，不会丢
  const recovered = (async () => {
    for (const one of await sessions.list().catch(() => [])) {
      if (!one.messages?.some((m) => m.draftOf) && !['running','queued'].includes(one.taskCheckpoint?.status)) continue;
      await editSession(one.id, async (s) => {
        if (['running','queued'].includes(s.taskCheckpoint?.status)) s.taskCheckpoint = {...s.taskCheckpoint,status:checkpointNeedsReview(s.taskCheckpoint)?'needs_review':'interrupted',interruptedAt:now()};
        s.messages = s.messages.map(({ draftOf, ...m }) => (draftOf ? { ...m, content: `${String(m.content).replace(DRAFT_MARK, '').trim()}\n\n${INTERRUPTED_MARK}` } : m));
        await sessions.save(s);
      }).catch(() => {});
    }
  })();

  function record(task, e) {
    if (['file','plan','task_state'].includes(e.type)) task.checkpoint=checkpointEvent(task.checkpoint,e,now());
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
    task.checkpoint=checkpointEvent(task.checkpoint,{type:'task_state',status:'running'},now());
    await editSession(task.sessionId,async s=>{s.taskCheckpoint=task.checkpoint;await sessions.save(s);});
    console.log(`[任务] ${task.id} 开始：${task.text.slice(0, 40).replace(/\s+/g, ' ')}`);
    record(task, { type: 'task_state', status: 'running' });
    const session = await sessions.get(task.sessionId);
    const cfg = await getConfig();
    const kind = classifyTask(task.text, { images: task.images.length });
    const route = routeFor(cfg, kind);
    const { adapter, model, problem } = makeAdapter(route.cfg);
    if (problem) return finish(task, session, { error: `服务器上的模型还没配置好：${problem}` });
    const fallbacks = fallbackRoutes(cfg, { provider: route.cfg.provider, model }).map((f) => ({ ...createAdapter(f.cfg), label: f.model })).filter((f) => !f.problem && f.adapter && f.model);
    const history = session.messages.slice(0, -1); // 最后一条是这次的用户原话，单独作为 userText
    const tools = makeTools({
      tavilyKey: cfg.tavilyKey, bochaKey: cfg.bochaKey, searchRegion: cfg.searchRegion || 'auto',
      fetchViaGateway: (url, init) => publicFetch(url, init), // 不填搜索密钥也能联网搜索、读网页
      llm: helper(cfg, 'write'), reasonLlm: helper(cfg, 'reason'),
      onFileChanged: (p) => { if (!/^skills\//.test(p)) { task.files.add(p); record(task, { type: 'file', path: p }); } },
      // 画图、做视频：用服务器上的模型设置；生成的文件照常存进工作区，手机按文件下载后显示在对话里
      imageGen: (o) => generateImage(cfg, o),
      videoGen: (o) => generateVideo(cfg, o),
      // 显示工作区里已有的图片：让手机按文件取回来显示
      onImage: (src, path) => { if (path) record(task, { type: 'file', path }); },
      officeRender:renderOffice,
      currentSessionId: () => session.id
    }).filter((t) => !SERVER_BLOCKED.has(t.name));

    let shown = '';
    const usedTools = [];
    let idle;
    // 每隔一会儿把写到一半的回答先存进对话：服务器中途重启也不会全丢
    const saveDraft = () => {
      if (task.draftTimer) return;
      task.draftTimer = setTimeout(() => {
        task.draftTimer = null;
        if (task.status !== 'running' || (!shown.trim() && !usedTools.length)) return;
        editSession(task.sessionId, async (s) => {
          if (!s || task.status !== 'running') return;
          const draft = { role: 'assistant', content: `${shown.trim()}\n\n${DRAFT_MARK}`, ts: now(), draftOf: task.id, ...(usedTools.length && { tools: [...new Set(usedTools)] }) };
          const i = s.messages.findIndex((m) => m.draftOf === task.id);
          if (i >= 0) s.messages[i] = draft; else s.messages.push(draft);
          await sessions.save(s);
        }).catch(() => {});
      }, DRAFT_MS.value);
    };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { task.idle = true; task.ctrl.abort(); }, idleMs); };
    arm();
    try {
      const r = await runAgent({
        adapter, model, fallbacks, maxSteps,
        history: unsummarized(history, session.summary).map(({ role, content }) => ({ role, content })),
        userText: task.text, requirementText: task.text, images: task.images,
        // 日常闲聊少想一点（首字更快）；要查证、分析、算结果的不省
        effort: effortFor(kind, task.text, cfg),
        // 语音对话：口语短答；“你好 / 谢谢”这类寒暄不带工具，回得快
        voice: task.voice, light: !task.images.length && isSmallTalk(task.text),
        sessionId: session.id, summary: session.summary ?? null,
        requirements: collectRequirements(session.messages, session.requirements),
        inbox: task.inbox,
        checkpoint: async event => {
          task.checkpoint=checkpointEvent(task.checkpoint,event,now());
          await editSession(task.sessionId,async s=>{s.taskCheckpoint=task.checkpoint;await sessions.save(s);});
        },
        signal: task.ctrl.signal,
        tools,
        // 服务器上没人能点“确认”：需要确认的操作（删除、覆盖等）一律不做，模型会改用别的办法或在回答里说明
        approve: async () => false,
        emit: (e) => {
          arm();
          if (e.type === 'text') { if (!task.firstTextAt) task.firstTextAt = now(); shown += e.delta; }
          if (e.type === 'tool_start' && e.name !== 'update_plan') usedTools.push(e.name);
          if (e.type === 'text' || e.type === 'tool_end') saveDraft();
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
    clearTimeout(task.draftTimer);
    // 重新读出来再改（期间用户可能又说了话、改了标题）：去掉半截回答，换成完整的
    await editSession(task.sessionId, async (fresh) => {
      fresh ??= session;
      if (!fresh) return;
      fresh.messages = fresh.messages.filter((m) => m.draftOf !== task.id);
      if (!error && !stopped) fresh.messages.push({ role: 'assistant', content: text || '（完成）', ts: now(), ...extra });
      else if (shown.trim() || usedTools.length) fresh.messages.push({ role: 'assistant', content: `${shown.trim()}\n\n${stopped ? '（已打断）' : INTERRUPTED_MARK}`, ts: now(), ...extra });
      fresh.updatedAt = now();
      task.checkpoint=checkpointEvent(task.checkpoint,{type:'task_state',status:stopped?'stopped':error?'error':'done'},now());
      fresh.taskCheckpoint=task.checkpoint;
      await sessions.save(fresh);
    }).catch((e) => console.error(`[任务] ${task.id} 回答没存上：${e?.stack || e}`));
    task.status = stopped ? 'stopped' : error ? 'error' : 'done';
    task.endedAt = now();
    // 记一笔用时，方便查“为什么慢”：journalctl -u jarvis 能看到
    const sec = (t) => (t && task.startedAt ? `${((t - task.startedAt) / 1000).toFixed(1)}s` : '—');
    console.log(`[任务] ${task.id} ${task.status}：排队 ${task.startedAt ? ((task.startedAt - task.createdAt) / 1000).toFixed(1) : '—'}s，首字 ${sec(task.firstTextAt)}，共 ${sec(task.endedAt)}，工具 ${usedTools.length} 次${error ? `，出错：${error.slice(0, 120)}` : ''}`);
    task.error = error;
    record(task, { type: 'task_state', status: task.status, ...(error && { error }), ...(task.status === 'done' && { text, toolCalls }), files: [...task.files] });
    task.listeners.clear();
    task.images = [];
    running--;
    pump();
    if (task.status === 'done') {
      const job = afterTask(task, text).catch((e) => console.warn(`[任务] ${task.id} 整理记忆 / 压缩对话没做成：${e?.message || e}`));
      background.add(job);
      job.finally(() => background.delete(job));
    }
    setTimeout(() => tasks.delete(task.id), KEEP_DONE_MS).unref?.();
  }

  /** 做完以后在后台：把这轮对话交给记忆整理（以后的对话能想起来），太长的对话把较早部分并进前情提要 */
  async function afterTask(task, text) {
    const cfg = await getConfig();
    const llm = helper(cfg, 'write');
    if (cfg.autoMemory !== false) {
      memory.configureMemory({ llm });
      const s = await sessions.get(task.sessionId);
      await memory.reflect([{ role: 'user', content: task.text }, ...task.notes.map((t) => ({ role: 'user', content: t })), { role: 'assistant', content: text }], { session: s && { id: s.id, title: s.title } });
    }
    await editSession(task.sessionId, async (s) => {
      if (!s || !dueForCompression(s.messages, s.summary).length) return;
      const next = await updateSummary(s.messages, s.summary, { llm });
      if (next && next !== s.summary) { s.summary = next; await sessions.save(s); }
    });
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
    async start({ sessionId = null, text, images = [], voice = false, requestId = null, targetTaskId = null }) {
      text = String(text ?? '').trim();
      if (!text) throw Object.assign(new Error('任务内容是空的'),{status:400});
      if (text.length>20000) throw Object.assign(new Error('任务内容太长'),{status:400});
      if (sessionId!==null&&!/^[\w-]{1,40}$/.test(String(sessionId))) throw Object.assign(new Error('对话编号不对'),{status:400});
      if (requestId!==null&&!/^[\w-]{1,80}$/.test(String(requestId))) throw Object.assign(new Error('请求编号不对'),{status:400});
      images=(Array.isArray(images)?images:[]).filter(i=>/^image\/(png|jpe?g|webp|gif)$/.test(i?.mime)&&typeof i.data==='string'&&i.data.length<=MAX_IMAGE_CHARS).slice(0,MAX_IMAGES).map(({mime,data})=>({mime,data}));
      await recovered;
      const hash=createHash('sha256').update(JSON.stringify([text,images,Boolean(voice),targetTaskId])).digest('hex');
      const id=sessionId||(requestId?'c_'+createHash('sha256').update(requestId).digest('hex').slice(0,30):sessions.create().id);
      const result=await editSession(id,async session=>{
        session??={...sessions.create(),id};
        const receipts=(session.taskReceipts||[]).filter(x=>now()-x.at<KEEP_DONE_MS);
        const prior=requestId&&receipts.find(x=>x.requestId===requestId);
        if(prior){
          if(prior.hash!==hash)throw Object.assign(new Error('同一请求编号不能用于不同内容'),{status:409});
          if(!tasks.has(prior.result.id))throw Object.assign(new Error('该请求已接收，服务器曾重启或记录已归档；请查看原会话，不要重复执行'),{status:409});
          return {...prior.result,duplicate:true};
        }
        const busy=[...tasks.values()].find(t=>t.sessionId===id&&['queued','running'].includes(t.status));
        if(targetTaskId&&busy?.id!==targetTaskId)throw Object.assign(new Error('原任务已结束或中断，补充未执行；请作为新任务发送'),{status:409});
        session.messages.push({role:'user',content:text,ts:now()});session.updatedAt=now();
        const task=busy||{id:uid('t'),sessionId:id,text,status:'queued',seq:0,events:[],listeners:new Set(),files:new Set(),inbox:[],notes:[],images,voice:Boolean(voice),ctrl:new AbortController(),createdAt:now(),checkpoint:{text,notes:[],steps:[],inFlight:[],files:[],status:'queued',createdAt:now()}};
        const nextCheckpoint=busy?checkpointEvent(task.checkpoint,{type:'user_note',text},now()):task.checkpoint;
        session.taskCheckpoint=nextCheckpoint;
        const answer={id:task.id,sessionId:id,...(busy&&{joined:true})};
        session.taskReceipts=[...receipts,...(requestId?[{requestId,hash,result:answer,at:now()}]:[])];
        await sessions.save(session);task.checkpoint=nextCheckpoint;
        if(busy){busy.inbox.push(text);busy.notes.push(text);record(busy,{type:'user_note',text});}
        else{tasks.set(task.id,task);record(task,{type:'task_state',status:'queued',position:waiting.length+running});waiting.push(task);}
        return answer;
      });
      pump();return result;
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
    get running() { return running; },
    /** 改一段对话（和任务的读写排队，不互相冲掉）：截断、追加消息用 */
    edit: (id, fn) => editSession(id, fn),
    /** 等手上的活（恢复、排队和正在做的任务、做完后的整理）都结束：测试收尾、服务停止前用 */
    async settled() {
      await recovered;
      while (running || waiting.some((t) => t.status === 'queued') || background.size || locks.size) {
        await Promise.allSettled([...background, ...locks.values()]);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };
}
