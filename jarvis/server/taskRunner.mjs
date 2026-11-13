import { createPhoneTools } from '../src/agent/phoneTools.js';
import { serverModelConfig } from './modelCredentials.mjs';
import { chargeSearchRequest, chargeEvaluation, evaluationAdapter, evaluationModelFetch } from './evaluationAccess.mjs';
import { presentationOverview } from './presentationOverview.mjs';
import { createStockImages } from './stockImages.mjs';
import { createLookupModel } from '../src/agent/lookupModels.js';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { convertLegacyDoc } from './officeRender.mjs';
import { codeProjectTools } from './codeProjectTools.mjs';
import { codeFollowup, codeTaskPolicy, CODE_TASK_MS } from './codeTaskPolicy.mjs';
import { prepareCodeWork } from './codeWorkContext.mjs';
import { editImage } from '../src/llm/imageEdit.js';
import { renderSvg } from './svgRender.mjs';
import { renderPoster } from './posterRaster.mjs';
import { renderVisualScene } from './visualSceneRaster.mjs';
import { compareDiagramPpt } from './diagramCompare.mjs';
import { cropImageRegion } from './imageRegion.mjs';
import { qweatherConfig } from '../src/core/qweather.js';
import { deepseekSearchOptions } from '../src/agent/deepseekSearch.js';
import { openaiSearchOptions } from '../src/agent/openaiSearch.js';
import { evaluationTools, bindEvaluation } from './evaluation.mjs';
import { measureModelInput } from '../shared/modelMetrics.js';
import { createHelperLlm } from '../src/llm/helper.js';
import { createEmbedder } from '../src/llm/embeddings.js';
import { ocrLine, recognizeText } from '../src/llm/ocr.js';
import { projectExecutionTool } from './projectExecution.mjs';
import { renderOffice } from './officeRender.mjs';
import { createTaskTiming } from '../shared/taskTiming.js';
import { HEDGE_MS } from '../src/agent/hedgedRequest.js';
import { createHash } from 'node:crypto';
import { createDocumentReviewer } from '../src/llm/documentReviewer.js';
import { checkpointEvent, checkpointNeedsReview, checkpointRecoveryText, isReadOnlyTool } from '../shared/taskCheckpoint.js';
import { evidence } from '../src/agent/evidenceStore.js';
import { failedStep } from '../src/agent/failedSteps.js';
import { createCodeTools, createRepoAdoptTool } from './codeTools.mjs';
import { withoutCodeCredentials } from './gitHosting.mjs';
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
import { assertPublicDns } from './publicFetchDns.mjs';
import { resolveAgentTurn, sanitizeAgentForm } from '../src/agent/agentTurn.js';
import { runWorkflow } from '../src/agent/workflowRun.js';
import { ALL_BUILTIN_AGENTS as BUILTIN_AGENTS } from '../src/agent/agentProfileBuiltins.js';
import { profileId } from '../src/agent/agentProfileValidation.js';
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import * as sessions from '../src/agent/sessions.js';
import { unsummarized, dueForCompression, updateSummary } from '../src/agent/compress.js';
import { resolveTaskIntent } from '../src/core/taskIntent.js';
import { capabilityUpgradeRoutes } from '../src/llm/capabilityUpgrade.js';
import * as memory from '../src/agent/memory.js';
import { collectRequirements } from '../src/agent/taskRequirements.js';
import { createAdapter } from '../src/llm/config.js';
import { generateImage } from '../src/llm/images.js';
import { generateVideo } from '../src/llm/videos.js';
import { providerById } from '../shared/providers.js';
import { routeFor, fallbackRoutes, effortFor, isSmallTalk, visionRoute } from '../src/llm/router.js';
import { providerLabel, modelNote } from '../src/llm/modelLibrary.js';
import { INTERRUPTED_MARK, interruptionMark, errorKind } from '../src/core/suggest.js';
import { uid } from '../src/agent/store.js';
import * as skillPacks from '../src/agent/skillPacks.js';
import * as ws from '../src/agent/workspace.js';
import { needsRunner } from '../src/agent/skillDeps.js';
import { skillRunnerTool } from './skillRunner.mjs';
import { normalizeMarketSnapshot, mergeMarketSnapshots } from '../shared/marketSnapshot.js';

/** 服务器上不提供的工具：浏览器里的代码沙箱、预览窗口、本机指标（定时任务由服务器自己按时执行，见 serverSchedules.mjs） */
export const SERVER_BLOCKED = new Set(['run_javascript', 'run_python', 'preview', 'get_local_metrics']);
/** 连续这么久没有任何进展（模型输出、工具事件）就中断，记为失败 */
export const IDLE_MS = 10 * 60_000;
/** 回答完以后，等服务器安静这么久再整理记忆、压缩对话（不和下一句抢模型）；一直忙也最多等这么久 */
export const AFTER_IDLE_MS = 20_000;
const AFTER_IDLE_MAX_MS = 3 * 60_000;
/** 做完的任务在内存里留多久（之后只在对话记录里） */
const KEEP_DONE_MS = 2 * 3600_000;
/** 一个任务最多记这么多条进度事件（文字是一小段一小段来的，超了就把旧的文字段合并） */
const MAX_EVENTS = 3000;

/** 做到一半时先存进对话的半截回答结尾的标记；做完会换成完整回答 */
export const DRAFT_MARK = '（还在做，做完会更新这里）';
/** 半截回答多久存一次 */
export const DRAFT_MS = { value: 10_000 };
export const CHECKPOINT_MS = { value: 1000 }; // 检查点合并写盘的间隔（测试里可以调小）

/** 随任务发来的图片：最多几张、每张多大（base64 字符数） */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

/**
 * 服务器上联网（搜索、读网页、查天气）：服务器没有浏览器的跨域限制，直接请求；
 * 但只许访问公网地址，每一跳重定向都重新检查（不让模型借机访问服务器内网的面板、数据库）
 */
export async function publicFetch(url, init = {}, fetchImpl = globalThis.fetch, lookup = (h) => dns.lookup(h, { all: true })) {
  if (init.signal?.aborted) throw init.signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' });
  chargeSearchRequest(url);
  if (new URL(url).hostname === 'queue.fal.run' && String(init.method || 'GET').toUpperCase() === 'POST') chargeEvaluation('model');
  let u = new URL(url);
  const headers = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  });
  new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  const requestSignal = init.signal ?? AbortSignal.timeout(20000);
  for (let hop = 0; ; hop++) {
    requestSignal.throwIfAborted();
    // DNS 等待也沿用本次请求期限；解析失败与实际私网拦截分开处理。
    await assertPublicDns(u, lookup, requestSignal);
    requestSignal.throwIfAborted();
    const res = await fetchImpl(u, { ...init, headers, redirect: 'manual', signal: requestSignal });
    const loc = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400 && loc)) return res;
    if (init.redirect === 'error') throw Object.assign(new Error('此请求不允许重定向'), { code: 'REDIRECT_BLOCKED', kind: 'api' });
    if (hop >= 5) throw new Error('重定向次数过多');
    const next = new URL(loc, u);
    // 跳到别的站点时去掉凭据头（同 Fetch 标准）：手动跟随重定向会把同一份请求头带到每一跳，
    // 搜索/图库等服务的 Key 放在请求头里，不能因为一次跨站重定向就交给第三方。
    if (next.origin !== u.origin) for (const name of [...headers.keys()]) if (CREDENTIAL_HEADER.test(name)) headers.delete(name);
    u = next;
  }
}
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|access[_-]?key|x-access-key|x-auth-token|x-goog-api-key)$/i;

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…（已截断）` : s);

/**
 * @param {{ getConfig: () => Promise<object>, maxRunning?: number, maxSteps?: number, idleMs?: number, makeTools?: (ctx: object) => object[], makeAdapter?: typeof createAdapter, now?: () => number }} o
 */
/**
 * 服务器上的“确认”：没人能点确认框，只放行用户原话里已经明确要求的操作。
 * 目前只有安装技能（“装一个 PPT 技能”“安装这个 skill”）；删除、覆盖文件等照旧不做。
 */
export function serverApproves(ask, text) {
  if (ask?.key === 'skill-install') return /安装|装[上好个一下]|install/i.test(String(text ?? ''));
  return false;
}

export function createTaskRunner({ getConfig, maxRunning = 1, maxSteps = 28, idleMs = IDLE_MS, afterIdleMs = AFTER_IDLE_MS, makeTools = createTools, makeAdapter = createAdapter, now = Date.now, skillRunner = null, codeRepos = null, codeProjects = null, projectBaseDir, codeMaxSteps = 80, codeTaskMs = CODE_TASK_MS, lookupService = createLookupService({ get: publicFetch }), evaluationAccess = null, userAccess = null, phoneBroker = null }) {
  const stockByUser = new Map(); // 最多50个已绑定用户；缓存不能跨用户复用。
  const stockForUser = () => {
    const id = userAccess?.current() || 'owner';
    if (!stockByUser.has(id)) stockByUser.set(id, createStockImages({ getConfig, fetchImpl: publicFetch }));
    return stockByUser.get(id);
  };
  const tasks = new Map();
  const waiting = [];
  let running = 0;
  let lastUser = null;
  const locks = new Map();
  const background = new Set(); // 做完后在后台整理记忆、压缩对话的活（settled() 等它们做完）
  const summaryControllers = new Set(); // 后台摘要全局最多一个；新前台任务开始即取消。
  let lastActive = Date.now(); // 最近一次有任务开始或结束的时间
  const wakers = new Set(); // settled() 用：叫醒还在等空闲的整理活，马上做
  let flushing = 0; // settled() 进行中：整理活不再等空闲

  /** 等服务器空下来再做后台整理：没有任务在做、排队，且安静了 afterIdleMs。
   *  不等的话，整理记忆、压缩对话会和用户紧接着说的下一句话同时调模型（中转站常常排队），下一句回答就慢。
   *  最多等 AFTER_IDLE_MAX_MS，一直有人在说话也不至于永远不整理 */
  async function whenIdle() {
    const since = Date.now();
    for (;;) {
      if (flushing) return;
      const busy = running || waiting.some((t) => t.status === 'queued');
      const quiet = Date.now() - lastActive;
      if ((!busy && quiet >= afterIdleMs) || Date.now() - since >= AFTER_IDLE_MAX_MS) return;
      const wait = busy ? Math.min(afterIdleMs, 2000) : afterIdleMs - quiet;
      const woken = await new Promise((resolve) => {
        const timer = setTimeout(() => { wakers.delete(wake); resolve(false); }, Math.max(20, wait));
        timer.unref?.();
        const wake = () => { clearTimeout(timer); resolve(true); };
        wakers.add(wake);
      });
      if (woken) return;
    }
  }

  /** 同一段对话的“读出来 → 改 → 存回去”排队做：几处同时改时，后存的不会冲掉先存的 */
  function editSession(id, fn) {
    const key = (userAccess?.current() || 'owner') + ':' + id;
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => fn(await sessions.get(id)));
    locks.set(key, next);
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
  }

  // 上次服务器重启时没做完的任务：存下的半截回答标成“没完成”，不会丢
  const recoveries = new Map();
  function recover() {
    const id = userAccess?.current() || 'owner';
    if (!recoveries.has(id)) recoveries.set(id, (async () => {
    for (const one of await sessions.list().catch(() => [])) {
      if (!one.messages?.some((m) => m.draftOf) && !['running','queued'].includes(one.taskCheckpoint?.status)) continue;
      await editSession(one.id, async (s) => {
        if (['running','queued'].includes(s.taskCheckpoint?.status)) s.taskCheckpoint = {...s.taskCheckpoint,status:checkpointNeedsReview(s.taskCheckpoint)?'needs_review':'interrupted',interruptedAt:now()};
        s.messages = s.messages.map(({ draftOf, ...m }) => (draftOf ? { ...m, content: `${String(m.content).replace(DRAFT_MARK, '').trim()}\n\n${INTERRUPTED_MARK}` } : m));
        await sessions.save(s);
      }).catch(() => {});
    }
    })());
    return recoveries.get(id);
  }
  const recovered = recover();

  function record(task, e) {
    task.timing?.event(e);
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

  /**
   * 检查点落盘：每个工具开始、结束都会记一笔，每次都把整段对话重写一遍太浪费。
   * 合并成最多每秒写一次；只有“要动手改东西”的工具开始前立刻写（服务器这时重启，恢复时要知道它可能做了一半）。
   */
  function saveCheckpoint(task, now_ = false) {
    clearTimeout(task.checkpointTimer); task.checkpointTimer = null;
    if (!now_) { task.checkpointTimer = setTimeout(() => { task.checkpointTimer = null; saveCheckpoint(task, true).catch(() => {}); }, CHECKPOINT_MS.value); return Promise.resolve(); }
    if (['done', 'error', 'stopped'].includes(task.status)) return Promise.resolve(); // 已经由 finish 写了最终状态
    return editSession(task.sessionId, async (s) => { if (!s) return; s.taskCheckpoint = task.checkpoint; await sessions.save(s); });
  }

  /** 给模型用的辅助调用（深度调研、逐项查证等工具用） */
  function helper(cfg, kind, task = null, purpose = kind) {
    const { adapter, model, problem } = createAdapter(routeFor(cfg, kind).cfg);
    if (problem || providerById(cfg.provider)?.kind === 'mock') return null;
    return createHelperLlm(task ? measuredAdapter(evaluationAdapter(adapter), model, task, purpose) : evaluationAdapter(adapter), model);
  }
  /**
   * 只采集数字（用途、型号、耗时、Token），不保存提示、回答或密钥。
   * purpose 为 memory 的是后台记忆整理：单独记成 background，不算进这道题的辅助调用。
   */
  function measuredAdapter(adapter, model, task, purpose) {
    let seq = 0;
    return {
      ...adapter,
      async stream(options) {
        const id = 'h' + ++seq + '-' + purpose;
        const background = purpose === 'memory';
        task.timing.event({ type: 'diagnostic', phase: background ? 'background_start' : 'helper_start', id, purpose, model, ...measureModelInput(options), inputChars: (options.messages || []).reduce((total, message) => total + String(message.content || '').length, 0) });
        let result = null;
        try {
          result = await adapter.stream(options);
          return result;
        } finally {
          task.timing.event({ type: 'diagnostic', phase: background ? 'background_end' : 'helper_end', id, ok: Boolean(result), ...(result?.usage && { usage: result.usage }) });
        }
      }
    };
  }

  /** 当前模型看不了图时替它看图的模型（见 router.visionRoute、agent/imageSight.js） */
  function sight(cfg, task = null) {
    const r = visionRoute(cfg);
    if (providerById(cfg.provider)?.kind === 'mock') return {};
    if (!r) return { readImageText: ocrLine(cfg) ? (file, o) => recognizeText(cfg, file, { ...o, fetchImpl: evaluationModelFetch }) : null };
    const selected = makeAdapter(r.cfg);
    const { model, problem } = selected;
    const adapter = evaluationAdapter(selected.adapter);
    const readImageText = ocrLine(cfg) ? (file, o) => recognizeText(cfg, file, { ...o, fetchImpl: evaluationModelFetch }) : null; // 文字识别（GLM-OCR）
    return problem || !adapter ? { readImageText } : { describeImages: createHelperLlm(task ? measuredAdapter(adapter, model, task, 'vision') : adapter, model), visionLabel: model, readImageText };
  }

  const inTask = (task, work) => userAccess ? userAccess.run(task.userId, () => evaluationAccess ? evaluationAccess.run(task, work) : work()) : evaluationAccess ? evaluationAccess.run(task, work) : work();
  const execute = task => inTask(task, () => executeScoped(task).catch(err => finish(task, null, { error: String(err?.message || err) })));
  const visible = task => task && (!userAccess || task.userId === userAccess.current());
  async function executeScoped(task) {
    if (userAccess && !userAccess.active(task.userId)) return finish(task, null, { stopped: true });
    const stockImages = stockForUser();
    task.status = 'running';
    task.startedAt = now();
    task.timing.start();
    task.checkpoint=checkpointEvent(task.checkpoint,{type:'task_state',status:'running'},now());
    await editSession(task.sessionId,async s=>{s.taskCheckpoint=task.checkpoint;await sessions.save(s);});
    console.log(`[任务] ${task.id} 开始：${task.text.slice(0, 40).replace(/\s+/g, ' ')}`);
    record(task, { type: 'task_state', status: 'running' });
    for (const controller of summaryControllers) controller.abort();
    const session = await sessions.get(task.sessionId);
    const cfg = serverModelConfig(withoutCodeCredentials(await getConfig()));
    // 智能体对话：按本人注册表解析（找不到就报错，不悄悄当普通对话）
    // 评测任务只允许内置智能体（固定配置、不涉及个人数据），不读个人智能体
    const agent = await resolveAgentTurn({ agentId: session.agentId || null, form: session.agentForm || null }, task.evaluationId ? { lookup: async (id) => BUILTIN_AGENTS.find((p) => p.id === id) || null } : undefined);
    const taskIntent = resolveTaskIntent(task.text, { history: session.messages.slice(0, -1), state: session.taskContext, images: task.images.length });
    // 记忆按意思找：用能力表“记忆向量”那一项（服务器没有跨域限制）；没有就只按关键字
    memory.configureMemory({ llm: helper(cfg, 'write', task, 'memory'), embedder: createEmbedder(cfg, { direct: true }) });
    const taskRepos = task.evaluationAuthorization ? null : codeProjects ? await codeProjects.reposFor(session.id) : codeRepos;
    const mayUseCode = Boolean((taskRepos || codeProjects) && !task.evaluationId && (codeFollowup(task.text) || codeTaskPolicy({ text: task.text, taskIntent, hasRepos: true, hasProjects: Boolean(codeProjects), projectBound: taskRepos !== codeRepos }).enabled));
    task.codeDeadline = mayUseCode ? setTimeout(() => { task.codeTimeout = true; task.ctrl.abort(Object.assign(new Error('代码任务达到总时限，保留工作副本，可继续'), { code: 'CODE_TASK_TIMEOUT', kind: 'timeout' })); }, Math.max(1, Math.min(20 * 60_000, Number(codeTaskMs) || CODE_TASK_MS))) : null;
    const { policy, codeTaskId, scopedRepos, codeWork } = await prepareCodeWork({ text: task.text, taskIntent, images: task.images.length, sessionId: session.id, taskId: task.id, checkpoint: task.checkpoint, resume: task.resumeFrom, repos: taskRepos, hasProjects: Boolean(codeProjects), projectBound: taskRepos !== codeRepos, evaluationId: task.evaluationId, maxSteps, codeMaxSteps, signal: task.ctrl.signal });
    const kind = policy.kind;
    if (!policy.enabled) { clearTimeout(task.codeDeadline); task.codeDeadline = null; }

    if (policy.enabled) {
      task.checkpoint.codeTaskId = codeTaskId;
      await saveCheckpoint(task, true);
    }
    const route = routeFor(cfg, kind);
    const selected = makeAdapter(route.cfg);
    const capabilityRoutes = capabilityUpgradeRoutes(cfg, value => { const picked = makeAdapter(value); return { ...picked, adapter: evaluationAdapter(picked.adapter) }; }, { provider: route.cfg.provider, model: selected.model });
    const { model, problem } = selected;
    const adapter = evaluationAdapter(selected.adapter);
    if (problem) return finish(task, session, { error: `服务器上的模型还没配置好：${problem}` });
    // 告诉手机这句话交给了谁（回答底下显示）
    record(task, { type: 'route', model, task: kind, routed: route.routed, reason: taskIntent.reason, category: taskIntent.category });
    const fallbacks = fallbackRoutes(cfg, { provider: route.cfg.provider, model, task: kind }).map((f) => ({ ...createAdapter(f.cfg), label: `${providerLabel(f.cfg, f.provider)} · ${f.model}` })).filter((f) => !f.problem && f.adapter && f.model).map(f => ({ ...f, adapter: evaluationAdapter(f.adapter) }));
    const history = session.messages.slice(0, -1); // 最后一条是这次的用户原话，单独作为 userText
    const taskLookup = task.evaluationId ? createLookupService({ storage: memoryLookupStorage(), get: publicFetch }) : lookupService;
    const tools = evaluationTools(makeTools({
      ...deepseekSearchOptions(cfg), qianfanSearchKey: cfg.qianfanSearchKey, qianfanSearchTopK: cfg.qianfanSearchTopK,
      ...openaiSearchOptions(cfg),
      openaiSearchFetch: (url, init) => {
        init?.signal?.throwIfAborted();
        // 自定义搜索是一次模型请求加一次原生搜索，评测额度不能因域名未知漏计。
        chargeEvaluation('model');
        chargeEvaluation('search');
        return publicFetch(url, init);
      },
      qibookAccessKey: cfg.qibookAccessKey, qibookBaseUrl: cfg.qibookBaseUrl,
      // 评测不读用户保存的文档偏好（字号、风格），结果才能复现
      ...(task.evaluationId && { documentStylePreferences: async () => '' }),
      lookup: taskLookup.options(cfg.lookupRegion || 'auto'),
      publicDataHosts: cfg.publicDataHosts, tavilyKey: cfg.tavilyKey, qweather: qweatherConfig(cfg), bochaKey: cfg.bochaKey, falKey: cfg.falKey, searchRegion: cfg.searchRegion || 'auto',
      fetchPublicJson: (url, init) => publicFetch(url, init),
      fetchViaGateway: (url, init) => publicFetch(url, init), // 不填搜索密钥也能联网搜索、读网页
      llm: helper(cfg, 'write', task), reasonLlm: helper(cfg, 'reason', task),
      documentReviewer: createDocumentReviewer(cfg, (selected) => helper({ ...selected, routing: { enabled: false } }, 'write', task, 'document_review')),
      onFileChanged: (p) => { if (!/^skills\//.test(p)) { task.files.add(p); record(task, { type: 'file', path: p }); } },
      onSportsScores: (value) => { task.sports = value; record(task, { type: 'sports_scores', value }); },
      onMarketQuote: (value) => {
        if (task.ctrl.signal.aborted || task.status !== 'running') return;
        const clean = normalizeMarketSnapshot(value);
        if (!clean) return;
        task.markets = mergeMarketSnapshots(task.markets, clean);
        record(task, { type: 'market_quote', value: clean });
        saveDraft();
      },
      // 画图、做视频：用服务器上的模型设置；生成的文件照常存进工作区，手机按文件下载后显示在对话里
      stockImageForSlide: (o) => stockImages.forSlide({ ...o, visionLlm: sight(cfg, task).describeImages }),
      imageGen: (o) => generateImage(cfg, { ...o, fetchImpl: evaluationModelFetch, download: publicFetch }),
      imageEdit: (o) => editImage(cfg, { ...o, fetchImpl: evaluationModelFetch, download: publicFetch }),
      cropImage: cropImageRegion,
      renderSvg,
      renderPoster,
      renderVisualScene,
      compareDiagramPpt,
      visionLlm: sight(cfg, task).describeImages || null,
      ocr: ocrLine(cfg) ? (file, o) => recognizeText(cfg, file, { ...o, fetchImpl: evaluationModelFetch }) : null, // 文字识别（智谱 GLM-OCR）
      videoGen: (o) => generateVideo(cfg, { ...o, fetchImpl: evaluationModelFetch }),
      // 显示工作区里已有的图片：让手机按文件取回来显示
      onImage: (src, path) => { if (path) record(task, { type: 'file', path }); },
      officeRender:renderOffice,
      presentationOverview,
      convertLegacyDoc,
      currentSessionId: () => session.id,
      scheduleHost: 'server'
    }).filter((t) => !SERVER_BLOCKED.has(t.name)), task.evaluationId, Boolean(task.evaluationAuthorization));
    if (phoneBroker && !task.evaluationId && !task.evaluationAuthorization) tools.push(...createPhoneTools(phoneBroker));
    const projectTool = projectExecutionTool({ image: process.env.JARVIS_CODE_SANDBOX_IMAGE, baseDir: typeof projectBaseDir === 'function' ? projectBaseDir() : projectBaseDir });
    if (projectTool && !task.evaluationAuthorization) tools.push(projectTool);
    if (taskRepos && !task.evaluationId) tools.push(...createCodeTools({ repos: scopedRepos, sessionId: session.id, taskId: task.checkpoint.codeTaskId || task.id, editing: taskRepos.writable === true, enableBrowser: true, saveBrowserArtifact: async (p, data, type) => { await ws.write(p, new Blob([data], { type })); task.files.add(p); record(task, { type: 'file', path: p }); } }));
    if (taskRepos?.adopt && taskRepos.writable === true && !task.evaluationId) tools.push(createRepoAdoptTool({ repos: taskRepos, sessionId: session.id })); // 别的对话里的副本接过来接着改
    if (codeProjects && !task.evaluationId) tools.push(...codeProjectTools(codeProjects, session.id));
    // 装了带脚本的技能：给模型“运行技能命令”的工具（在服务器的隔离 Docker 里跑，见 skillRunner.mjs；没装运行器时会照实说怎么装）
    if (skillRunner && !task.evaluationId && (await skillPacks.enabled().catch(() => [])).some(needsRunner)) {
      tools.push(skillRunnerTool({
        runner: skillRunner,
        getPack: (name) => skillPacks.get(name),
        saveFile: async (p, data) => { await ws.write(p, new Blob([data])); task.files.add(p); record(task, { type: 'file', path: p }); }
      }));
    }

    let shown = '';
    const usedTools = [];
    let idle;
    // 每隔一会儿把写到一半的回答先存进对话：服务器中途重启也不会全丢
    const saveDraft = () => {
      if (task.draftTimer) return;
      task.draftTimer = setTimeout(() => {
        task.draftTimer = null;
        if (task.status !== 'running' || (!shown.trim() && !usedTools.length && !task.markets?.length)) return;
        editSession(task.sessionId, async (s) => {
          if (!s || task.status !== 'running') return;
          const draft = { role: 'assistant', content: `${shown.trim()}\n\n${DRAFT_MARK}`, ts: now(), draftOf: task.id, ...(task.sports && { sports: task.sports }), ...(task.markets?.length && { markets: task.markets }), ...(usedTools.length && { tools: [...new Set(usedTools)] }) };
          const i = s.messages.findIndex((m) => m.draftOf === task.id);
          if (i >= 0) s.messages[i] = draft; else s.messages.push(draft);
          await sessions.save(s);
        }).catch(() => {});
      }, DRAFT_MS.value);
    };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { task.idle = true; task.ctrl.abort(); }, idleMs); };
    arm();
    try {
      // 智能体配置里写了步骤：按工作流逐步执行（每步仍走 runAgent，见 workflowRun.js）
      const r = await (agent?.profile?.steps?.length ? runWorkflow : runAgent)({
        adapter, model, fallbacks, lookupPreferences: () => taskLookup.preferences(), lookupModel: createLookupModel(cfg, value => { const picked = makeAdapter(value); return { ...picked, adapter: evaluationAdapter(picked.adapter) }; }), maxSteps: policy.maxSteps, maxTotalSteps: policy.maxTotalSteps, codeWork, ...sight(cfg, task), hedgeMs: cfg.hedgeBackup === false ? 0 : HEDGE_MS, modelNote: modelNote(cfg, { provider: route.cfg.provider, model }),
        history: unsummarized(history, session.summary).map(({ role, content }) => ({ role, content })),
        userText: task.resumeFrom ? task.text+'\n\n'+checkpointRecoveryText(task.resumeFrom) : task.text, requirementText: taskIntent.requirementText, taskIntent, capabilityRoutes, images: task.images, agent,
        // 日常闲聊少想一点（首字更快）；要查证、分析、算结果的不省
        effort: effortFor(kind, task.text, cfg),
        // 语音对话：口语短答；“你好 / 谢谢”这类寒暄不带工具，回得快
        quiet: Boolean(task.evaluationId),
        isolated: Boolean(task.evaluationId), // 评测不读用户个人记忆和偏好（见 agent.js isolatedContext）
        voice: task.voice, light: !task.images.length && isSmallTalk(task.text),
        sessionId: session.id, summary: session.summary ?? null,
        requirements: collectRequirements(session.messages, session.requirements),
        inbox: task.inbox,
        checkpoint: async event => {
          task.checkpoint=checkpointEvent(task.checkpoint,event,now());
          await saveCheckpoint(task, event.type==='tool_start'&&!isReadOnlyTool(event.name));
        },
        signal: task.ctrl.signal,
        tools,
        // 服务器上没人能点“确认”：需要确认的操作（删除、覆盖等）一律不做，模型会在回答里说明。
        // 例外：用户这句话里明说了要安装技能，就当已经确认（见 serverApproves）
        approve: async (ask) => serverApproves(ask, task.text),
        emit: (e) => {
          arm();
          if (e.type === 'task_review') task.review = e.review;
          if (e.type === 'text') { if (task.firstTextAt == null && String(e.delta ?? '').trim()) task.firstTextAt = now(); shown += e.delta; }
          if (e.type === 'tool_start' && e.name !== 'update_plan') usedTools.push(e.name);
          // 失败的步骤连同报错原话记下来存进这条回答：用户下一句问“为啥失败”时还能看到（见 agent.js 的“上一轮失败的步骤”）
          if (e.type === 'tool_end' && e.ok === false) {
            const failure = failedStep(e);
            if (failure) task.failedSteps = [...(task.failedSteps || []), failure].slice(-6);
          }
          if (e.type === 'text' || e.type === 'tool_end') saveDraft();
          record(task, e);
        }
      });
      return finish(task, session, { text: r.text, usedTools, toolCalls: r.toolCalls ?? 0 });
    } catch (err) {
      const stopped = task.ctrl.signal.aborted && !task.idle && !task.codeTimeout;
      return finish(task, session, { error: stopped ? '' : task.codeTimeout ? '代码任务达到总时限，工作副本已保留，发送继续可接着处理' : task.idle ? '连续 10 分钟没有进展，已中断' : String(err?.message || err), errorType: task.idle || task.codeTimeout ? 'timeout' : errorKind(err), stopped, shown, usedTools });
    } finally {
      clearTimeout(idle);
      clearTimeout(task.codeDeadline);
    }
  }

  async function finish(task, session, { text = '', error = '', errorType = '', stopped = false, shown = '', usedTools = [], toolCalls = 0 }) {
    clearTimeout(task.codeDeadline);
    const timing = task.timing.finish();
    const extra = { ...(task.sports && { sports: task.sports }), ...(task.markets?.length && { markets: task.markets }), ...(task.failedSteps?.length && { failures: task.failedSteps }), timing, ...(task.review?.outcome && { review: { outcome: task.review.outcome, issueCount: task.review.warnings?.length || 0 } }), ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(task.files.size && { files: [...task.files].slice(-12) }) };
    clearTimeout(task.draftTimer);
    clearTimeout(task.checkpointTimer); task.checkpointTimer = null; // 下面一起写最终的检查点
    evidence.flush().catch(() => {});
    // 重新读出来再改（期间用户可能又说了话、改了标题）：去掉半截回答，换成完整的
    await editSession(task.sessionId, async (fresh) => {
      fresh ??= session;
      if (!fresh) return;
      fresh.messages = fresh.messages.filter((m) => m.draftOf !== task.id);
      if (!error && !stopped) fresh.messages.push({ role: 'assistant', content: text || '（完成）', ts: now(), ...extra });
      else if (shown.trim() || usedTools.length || task.markets?.length) fresh.messages.push({ role: 'assistant', content: `${shown.trim()}\n\n${stopped ? '（已打断）' : interruptionMark({ message: error, kind: errorType })}`, ts: now(), ...extra });
      fresh.updatedAt = now();
      task.checkpoint=checkpointEvent(task.checkpoint,{type:'task_state',status:stopped?'stopped':error?'error':'done',error},now());
      fresh.taskCheckpoint={...task.checkpoint,timing};
      await sessions.save(fresh);
    }).catch((e) => console.error(`[任务] ${task.id} 回答没存上：${e?.stack || e}`));
    task.status = stopped ? 'stopped' : error ? 'error' : 'done';
    task.endedAt = now();
    // 记一笔用时，方便查“为什么慢”：journalctl -u jarvis 能看到
    const sec = (t) => (t && task.startedAt ? `${((t - task.startedAt) / 1000).toFixed(1)}s` : '—');
    console.log(`[任务] ${task.id} ${task.status}：排队 ${task.startedAt ? ((task.startedAt - task.createdAt) / 1000).toFixed(1) : '—'}s，首字 ${sec(task.firstTextAt)}，共 ${sec(task.endedAt)}，工具 ${usedTools.length} 次${error ? `，出错：${error.slice(0, 120)}` : ''}`);
    task.error = error;
    task.errorType = errorType;
    record(task, { type: 'task_state', status: task.status, timing, ...(task.review?.outcome && { outcome: task.review.outcome }), ...(error && { error, errorKind: errorType }), ...(task.status === 'done' && { text, toolCalls }), files: [...task.files] });
    console.log(`[任务耗时] ${task.id} ${JSON.stringify(timing)}`);
    task.listeners.clear();
    task.images = [];
    running--;
    lastActive = Date.now();
    pump();
    if (task.status === 'done') {
      const job = whenIdle().then(() => afterTask(task, text)).catch((e) => console.warn(`[任务] ${task.id} 整理记忆 / 压缩对话没做成：${e?.message || e}`));
      background.add(job);
      job.finally(() => background.delete(job));
    }
    setTimeout(() => tasks.delete(task.id), KEEP_DONE_MS).unref?.();
  }

  /** 做完以后在后台：把这轮对话交给记忆整理（以后的对话能想起来），太长的对话把较早部分并进前情提要 */
  async function afterTask(task, text) {
    const cfg = serverModelConfig(withoutCodeCredentials(await getConfig()));
    const llm = helper(cfg, 'write');
    if (!task.evaluationId && cfg.autoMemory !== false) {
      memory.configureMemory({ llm, embedder: createEmbedder(cfg, { direct: true }) });
      const s = await sessions.get(task.sessionId);
      await memory.reflect([{ role: 'user', content: task.text }, ...task.notes.map((t) => ({ role: 'user', content: t })), { role: 'assistant', content: text }], { session: s && { id: s.id, title: s.title } });
      memory.maintain().catch(() => {}); // 每天最多整理一次记忆
    }
    if (summaryControllers.size || running || waiting.some(t => t.status === 'queued')) return;
    const snapshot = await sessions.get(task.sessionId);
    // 读取期间可能来了新任务或另一份后台摘要，拿到快照后再检查一次。
    if (summaryControllers.size || running || waiting.some(t => t.status === 'queued')) return;
    if (!snapshot || !dueForCompression(snapshot.messages, snapshot.summary).length) return;
    const controller = new AbortController();
    summaryControllers.add(controller);
    try {
      // 不在会话写锁内等模型，下一句话不必排在后台摘要后面。
      const next = await updateSummary(snapshot.messages, snapshot.summary, { llm: helper(cfg, 'chat', task, 'memory'), signal: controller.signal });
      await editSession(task.sessionId, async fresh => {
        if (!fresh || controller.signal.aborted || (fresh.summary?.upTo || 0) !== (snapshot.summary?.upTo || 0)) return;
        if (next && next !== snapshot.summary) { fresh.summary = next; await sessions.save(fresh); }
      });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally {
      summaryControllers.delete(controller);
    }
  }

  function pump() {
    while (running < Math.max(1, Math.min(4, Number(typeof maxRunning === 'function' ? maxRunning() : maxRunning) || 1)) && waiting.length) {
      const activeUsers = new Set([...tasks.values()].filter(t => t.status === 'running').map(t => t.userId));
      const eligible = t => t.status === 'queued' && (!userAccess || !activeUsers.has(t.userId));
      let index = userAccess ? waiting.findIndex(t => eligible(t) && t.userId !== lastUser) : -1;
      if (index < 0) index = waiting.findIndex(eligible);
      if (index < 0) break;
      const [task] = waiting.splice(index, 1);
      lastUser = task.userId;
      // 同一人的剩余请求移到队尾，空出的槽位轮到其他等候用户。
      if (userAccess) { const own = waiting.filter(t => t.userId === task.userId); for (const t of own) waiting.splice(waiting.indexOf(t), 1); waiting.push(...own); }
      running++;
      lastActive = Date.now();
      execute(task).catch(err => console.error('[任务] 收尾失败：', err?.code || err?.name || 'unknown'));
    }
  }

  return {
    /** @returns {Promise<{ id: string, sessionId: string }>} */
    async start({ sessionId = null, text, images = [], voice = false, requestId = null, targetTaskId = null, evaluationId = null, evaluationAuthorization = null, agentId = null, agentForm = null }) {
      text = String(text ?? '').trim();
      if (!text) throw Object.assign(new Error('任务内容是空的'),{status:400});
      if (text.length>20000) throw Object.assign(new Error('任务内容太长'),{status:400});
      if (sessionId!==null&&!/^[\w-]{1,40}$/.test(String(sessionId))) throw Object.assign(new Error('对话编号不对'),{status:400});
      if (requestId!==null&&!/^[\w-]{1,80}$/.test(String(requestId))) throw Object.assign(new Error('请求编号不对'),{status:400});
      // 智能体：这里只认编号格式；是否真有这个智能体、能用哪些工具，执行时按本人注册表再查（不信客户端传来的配置）
      if (agentId!==null&&agentId!==''){profileId(agentId);}else agentId=null;
      agentForm=agentId?sanitizeAgentForm(agentForm):null;
      images=(Array.isArray(images)?images:[]).filter(i=>/^image\/(png|jpe?g|webp|gif)$/.test(i?.mime)&&typeof i.data==='string'&&i.data.length<=MAX_IMAGE_CHARS).slice(0,MAX_IMAGES).map(({mime,data})=>({mime,data}));
      await recover();
      if (userAccess && !userAccess.active(userAccess.current())) throw Object.assign(new Error('该用户已停用'), { status: 403 });
      const hash=createHash('sha256').update(JSON.stringify([text,images,Boolean(voice),targetTaskId,evaluationId,...(agentId?[agentId,agentForm]:[])])).digest('hex');
      const id=sessionId||(requestId?'c_'+createHash('sha256').update(requestId).digest('hex').slice(0,30):sessions.create().id);
      const result=await editSession(id,async session=>{
        session??={...sessions.create(),id};
        const evaluationScope = bindEvaluation(session, evaluationId);
        // 一段对话只属于一个智能体：新对话记下；已绑定的不许换成别的（防止中途换配置扩大工具范围）
        if(agentId&&session.agentId&&session.agentId!==agentId)throw Object.assign(new Error('这段对话属于另一个智能体，请新开对话'),{status:409});
        if(agentId&&!session.agentId&&!session.messages.length)session.agentId=agentId;
        if(agentId&&session.agentId===agentId&&agentForm)session.agentForm=agentForm;
        const receipts=(session.taskReceipts||[]).filter(x=>now()-x.at<KEEP_DONE_MS);
        const prior=requestId&&receipts.find(x=>x.requestId===requestId);
        if(prior){
          if(prior.hash!==hash)throw Object.assign(new Error('同一请求编号不能用于不同内容'),{status:409});
          if(!tasks.has(prior.result.id))throw Object.assign(new Error('该请求已接收，服务器曾重启或记录已归档；请查看原会话，不要重复执行'),{status:409});
          return {...prior.result,duplicate:true};
        }
        const busy=[...tasks.values()].find(t=>visible(t)&&t.sessionId===id&&['queued','running'].includes(t.status));
        if(targetTaskId&&busy?.id!==targetTaskId)throw Object.assign(new Error('原任务已结束或中断，补充未执行；请作为新任务发送'),{status:409});
        const previous=session.taskCheckpoint;
        const incomplete=previous&&(['running','queued','interrupted','needs_review','error'].includes(previous.status) || previous.status==='stopped'&&previous.codeTaskId&&/^(继续|恢复|接着)/.test(text));
        if(!busy&&incomplete){
          const key=previous.taskId||createHash('sha256').update(JSON.stringify([previous.text,previous.createdAt])).digest('hex');
          const archive=session.recoveryCheckpoints||[];const {evidence:_,...kept}=previous; // 旧版检查点里带着网页正文：归档时去掉，只留最近 5 次
          session.recoveryCheckpoints=[...archive.filter(x=>x.key!==key).map(({evidence,...record})=>record),{key,...kept}].slice(-5);
        }
        session.messages.push({role:'user',content:text,ts:now()});session.updatedAt=now();
        // 只有评测程序明确带了 evaluationId 的才按评测隔离；用户本人在评测会话里发的话照常读记忆（用户 2026-10-30：误进评测会话后“不知道我是谁”）
        if (!busy && userAccess && ([...tasks.values()].filter(t => visible(t) && ['queued','running'].includes(t.status)).length >= 20 || tasks.size >= 1000)) throw Object.assign(new Error('任务过多，请等待已有任务完成'), { status: 429 });
        const task=busy||{id:uid('t'),userId:userAccess?.current() || 'owner',sessionId:id,evaluationId:evaluationId?evaluationScope:null,...(evaluationAuthorization && { evaluationAuthorization: { id: evaluationAuthorization.id } }),text,status:'queued',seq:0,events:[],listeners:new Set(),files:new Set(),inbox:[],notes:[],images,voice:Boolean(voice),ctrl:new AbortController(),createdAt:now(),checkpoint:{text,notes:[],steps:[],inFlight:[],files:[],status:'queued',createdAt:now()}};
        if (!busy && codeFollowup(text) && (previous?.codeTaskId || codeTaskPolicy({ text: previous?.text || '', hasRepos: Boolean(codeRepos && !evaluationScope) }).enabled)) {
          task.checkpoint.codeTaskId = previous.codeTaskId || previous.taskId;
        }
        task.checkpoint.taskId=task.id;
        if(!busy&&incomplete&&/^(继续|恢复|接着)/.test(text))task.resumeFrom=previous;
        const nextCheckpoint=busy?checkpointEvent(task.checkpoint,{type:'user_note',text},now()):task.checkpoint;
        session.taskCheckpoint=nextCheckpoint;
        const answer={id:task.id,sessionId:id,...(busy&&{joined:true})};
        session.taskReceipts=[...receipts,...(requestId?[{requestId,hash,result:answer,at:now()}]:[])];
        await sessions.save(session);task.checkpoint=nextCheckpoint;
        if(busy){busy.inbox.push(text);busy.notes.push(text);record(busy,{type:'user_note',text});}
        else{task.timing=createTaskTiming(task.createdAt,now);tasks.set(task.id,task);record(task,{type:'task_state',status:'queued',position:waiting.length+running});waiting.push(task);}
        return answer;
      });
      pump();return result;
    },
    get(id) {
      const t = tasks.get(id);
      return visible(t) && { id: t.id, sessionId: t.sessionId, evaluationId: t.evaluationId || null, text: t.text, status: t.status, seq: t.seq, files: [...t.files], error: t.error || '', errorKind: t.errorType || '', review: t.review ?? null, timing: t.timing.snapshot(), createdAt: t.createdAt, startedAt: t.startedAt ?? null, endedAt: t.endedAt ?? null };
    },
    list() { return [...tasks.keys()].map((id) => this.get(id)).filter(Boolean); },
    events(id, after = 0) { const t = tasks.get(id); return visible(t) ? t.events.filter(e => e.seq > after) : null; },
    subscribe(id, fn) {
      const t = tasks.get(id);
      if (!visible(t) || t.status === 'done' || t.status === 'error' || t.status === 'stopped') return null;
      t.listeners.add(fn);
      return () => t.listeners.delete(fn);
    },
    stop(id) {
      const t = tasks.get(id);
      if (!visible(t)) return false;
      if (t.status === 'queued') { t.status = 'stopped'; running++; waiting.splice(waiting.indexOf(t), 1); inTask(t, () => finish(t, null, { stopped: true })); return true; }
      if (t.status === 'running') { t.ctrl.abort(); return true; }
      return false;
    },
    get busy() { return running > 0 || waiting.some(t => t.status === 'queued'); },
    get running() { return userAccess ? [...tasks.values()].filter(t => visible(t) && t.status === 'running').length : running; },
    stopUser(userId) { for (const t of tasks.values()) if (t.userId === userId) userAccess?.run(userId, () => this.stop(t.id)); },
    /** 改一段对话（和任务的读写排队，不互相冲掉）：截断、追加消息用 */
    edit: (id, fn) => editSession(id, fn),
    /** 等手上的活（恢复、排队和正在做的任务、做完后的整理）都结束：测试收尾、服务停止前用 */
    async settled() {
      await recovered;
      await Promise.all(recoveries.values());
      flushing++;
      try {
        for (const wake of [...wakers]) wake();
        wakers.clear();
        while (running || waiting.some((t) => t.status === 'queued') || background.size || locks.size) {
          await Promise.allSettled([...background, ...locks.values()]);
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        flushing--;
      }
    }
  };
}
