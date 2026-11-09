import { createUserStore, currentUser, PRIMARY_USER, runAsUser, userDataDir, userService } from './userScope.mjs';
import { memberModelConfig } from './userRoutes.mjs';
import { createAgentProfileRoutes } from './agentProfileRoutes.mjs';
import { createStudioRoutes } from './studioRoutes.mjs';
import { createEvaluationAccess } from './evaluationAccess.mjs';
import { createAccessSecurity, legacyAccessToken } from './accessSecurity.mjs';
import { createAccessRoutes } from './accessRoutes.mjs';
import { stockDiagnostic } from '../src/agent/stockImageDiagnostics.js';
import { createReadinessRoutes } from './readinessRoutes.mjs';
import { createStockImages } from './stockImages.mjs';
import { STOCK_KEY_FIELDS, STOCK_PROVIDERS } from '../src/agent/stockImageSources.js';
import { publicDataHosts } from '../src/agent/publicJson.js';
import { createLookupService } from '../src/agent/lookup/service.js';
import { LOOKUP_REGIONS } from '../src/agent/lookup/sources.js';
import { createLookupRoutes } from './lookupRoutes.mjs';
import { createCodeProjects } from './codeProjects.mjs';
import { codeProjectRoutes } from './codeProjectRoutes.mjs';
import { createCodeBrowser } from './codeBrowser.mjs';
import { listWorkRecords, removeWorkRecord, renameWorkRecord } from '../src/agent/workLedger.js';
import { createSearchTest } from './searchTest.mjs';
import { createGitHubHost, withoutCodeCredentials } from './gitHosting.mjs';
import { createCodeRepos } from './codeRepos.mjs';
import { createCodeRepoRoutes } from './codeRepoRoutes.mjs';
import { createCodeSandbox } from './codeSandbox.mjs';
/**
 * 服务器模式（部署在自己的云服务器上）：任务交给服务器做，手机 / 电脑只负责发任务、看进度、取结果。
 *
 * 开启：设置环境变量 JARVIS_DATA（数据目录）和 JARVIS_PASSWORD（访问密码）。
 * 开启后网关所有 /api 接口都要先登录（/api/health 和登录本身除外），防止别人用你的模型额度。
 *
 *   POST   /api/server/login               { password } → { token }
 *   GET    /api/server/status              正在做 / 排队的任务
 *   GET    /api/server/config              模型设置（密钥只显示后 4 位）
 *   PUT    /api/server/config              保存模型设置（密钥留空 = 不改）
 *   GET    /api/server/update              版本号、自动更新装没装、上次检查 / 更新的结果
 *   POST   /api/server/update              马上检查并更新（留一个请求文件，由 root 的 jarvis-update 服务去做，见 deploy/update.sh）
 *   POST   /api/tasks                      { sessionId?, text } → { id, sessionId }
 *   GET    /api/tasks/<id>                 任务状态
 *   GET    /api/tasks/<id>/events?after=N  进度事件流（SSE）：先补发序号 > N 的，再实时推送，做完就结束
 *   POST   /api/tasks/<id>/stop            叫停
 *   GET    /api/sessions                   对话列表（不含消息内容）
 *   POST   /api/sessions/import            传一段本机的对话上来（服务器上已有同一段的不覆盖）
 *   GET    /api/sessions/<id>              一段对话
 *   PATCH  /api/sessions/<id>              { title?, pinned? } 改标题、钉住
 *   DELETE /api/sessions/<id>              删除对话
 *   POST   /api/sessions/<id>/truncate     { keep } 只留前 keep 条消息（编辑重发、重新生成用）
 *   POST   /api/sessions/<id>/append       { messages } 追加消息（电脑上在本机做的那一轮记回服务器）
 *   GET    /api/sessions/search?q=         按内容搜所有对话
 *   GET    /api/files                      工作区文件列表
 *   GET    /api/files/raw?path=            下载文件
 *   PUT    /api/files/raw?path=            上传文件（请求体就是文件内容）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskRunner, publicFetch } from './taskRunner.mjs';
import { createPhoneBroker } from './phoneBroker.mjs';
import { createPhoneRoutes } from './phoneRoutes.mjs';
import { createServerSchedules, notices as scheduleNotices } from './serverSchedules.mjs';
import * as scheduler from '../src/agent/scheduler.js';
import { useBackend } from '../src/agent/store.js';
import { seedBuiltins } from '../src/agent/skillPacks.js';
import * as skillPacks from '../src/agent/skillPacks.js';
import { needsRunner } from '../src/agent/skillDeps.js';
import { createSkillRunner, SKILL_RUNNER_IMAGE } from './skillRunner.mjs';
import * as sessions from '../src/agent/sessions.js';
import * as ws from '../src/agent/workspace.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';
import { streamPCModel } from './pcModelBridge.mjs';
import { serverModelCatalog } from './modelCatalog.mjs';
import { listDocumentStyles, deleteDocumentStyle, setEmbedder, vectorStatus, backfillVectors } from '../src/agent/memory.js';
import { createEmbedder } from '../src/llm/embeddings.js';
import { qweatherConfig } from '../src/core/qweather.js';
import { boundedCatalogs, applyRemovedProviders } from '../src/llm/modelLibrary.js';

const UPLOAD_LIMIT = 50 * 1024 * 1024;
/** 程序所在目录（安装包里的 VERSION 文件在这里） */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** install.sh 装的“立即更新”触发器：有它才能从手机上更新 */
const UPDATE_UNIT = '/etc/systemd/system/jarvis-update.path';
/** 上传一段本机对话的大小上限 */
const IMPORT_LIMIT = 8 * 1024 * 1024;
/** 仅供14天旧设备迁移；新登录使用随机会话。 */
export const tokenFor = legacyAccessToken;

/** 模型设置里的密钥只给看后 4 位 */
export function maskConfig(cfg) {
  cfg = withoutCodeCredentials(cfg);
  const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
  return { ...cfg, ...Object.fromEntries(STOCK_KEY_FIELDS.map(key => [key, mask(cfg[key])])), keys: Object.fromEntries(Object.entries(cfg.keys ?? {}).map(([k, v]) => [k, mask(v)])), tavilyKey: mask(cfg.tavilyKey), bochaKey: mask(cfg.bochaKey), qianfanSearchKey: mask(cfg.qianfanSearchKey), deepseekSearchKey: mask(cfg.deepseekSearchKey), falKey: mask(cfg.falKey), qweatherKey: mask(cfg.qweatherKey) };
}
/** 保存时：密钥没改（还是 •••• 或留空）就沿用原来的 */
export function mergeConfig(old, next) {
  // GitHub凭据只在专用仓库设置接口更新，模型面板的旧快照不能清空或覆盖。
  const { codeRepos: ignored, codeAccount: ignoredAccount, stockVerified: ignoredStockVerified, ...modelSettings } = next;
  next = modelSettings;
  if (Object.hasOwn(next, 'publicDataHosts')) next = { ...next, publicDataHosts: publicDataHosts(next.publicDataHosts) };
  if (Object.hasOwn(next, 'lookupRegion') && !LOOKUP_REGIONS.includes(next.lookupRegion)) throw Object.assign(new Error('查询地区只接受auto、cn或global'), { status: 400, code: 'LOOKUP_REGION' });
  if (Object.hasOwn(next, 'taskConcurrency') && (!Number.isInteger(next.taskConcurrency) || next.taskConcurrency < 1 || next.taskConcurrency > 4)) throw Object.assign(new Error('同时执行任务数须为1至4'), { status: 400 });
  const keep = (n, o) => (!n || String(n).startsWith('••••') ? o ?? '' : n);
  const keys = { ...(old.keys ?? {}) };
  for (const [k, v] of Object.entries(next.keys ?? {})) {
    if (typeof v !== 'string') throw Object.assign(new Error('模型Key必须是文字'), { status: 400 });
    const value = v.trim();
    if (value === 'use-gateway-key') throw Object.assign(new Error('请填写真实模型Key，不能保存网关占位符'), { status: 400 });
    keys[k] = keep(value, old.keys?.[k]);
  }
  // OpenRouter 线路选择只接受固定三档，不把任意文字写进配置
  for (const v of Object.values(next.routeSorts ?? {})) if (!['latency', 'throughput', 'price'].includes(v)) throw Object.assign(new Error('OpenRouter 线路选择只能是延迟优先、出字速度优先或价格优先'), { status: 400 });
  const maps = Object.fromEntries(['models', 'baseURLs', 'providerNames', 'modelLists', 'serviceTiers', 'routeSorts'].map((field) => [field, { ...old[field], ...next[field] }]));
  const merged = { ...old, ...next, ...maps, keys, tavilyKey: keep(next.tavilyKey, old.tavilyKey), bochaKey: keep(next.bochaKey, old.bochaKey), qianfanSearchKey: keep(next.qianfanSearchKey, old.qianfanSearchKey), deepseekSearchKey: keep(next.deepseekSearchKey, old.deepseekSearchKey), falKey: keep(next.falKey, old.falKey), qweatherKey: keep(next.qweatherKey, old.qweatherKey) };
  merged.stockVerified = { ...old.stockVerified };
  for (const key of STOCK_KEY_FIELDS) {
    merged[key] = keep(next[key], old[key]);
    if (merged[key] !== old[key]) delete merged.stockVerified[key.replace(/Key$/, '')];
  }
  if (!Number.isInteger(merged.qianfanSearchTopK ?? 10) || (merged.qianfanSearchTopK ?? 10) < 5 || (merged.qianfanSearchTopK ?? 10) > 20) throw Object.assign(new Error('百度搜索条数须为5至20'), { status: 400, code: 'QIANFAN_TOP_K' });
  // 字典合并不能把前端淘汰的旧地址缓存重新带回来；服务器也必须执行同一上限。
  if (next.modelLists || next.baseURLs) merged.modelLists = boundedCatalogs(merged);
  // 前端删掉的服务商：字典合并不会自己少掉，照着标记删
  return applyRemovedProviders(merged, next.removedProviders, next);
}

/**
 * @param {{ dataDir: string, password: string, maxRunning?: number, runner?: object }} o
 */
export function createServerMode({ dataDir, password, maxRunning = 2, runner: injected = null, appDir = APP_DIR, updateUnit = UPDATE_UNIT, makeModelAdapter, makeTaskAdapter, autoSchedules = false, codeHosting = createGitHubHost(), codeGit, codeSandbox = null, lookupService: injectedLookup = null, readinessRuntime, searchFetch } = {}) {
  if (!password || String(password).length < 6) throw new Error('服务器模式需要设置 JARVIS_PASSWORD（至少 6 位）');
  const security = createAccessSecurity({ dataDir, password: String(password) });
  const evaluationAccess = createEvaluationAccess({ store: createUserStore(dataDir), dataDir, security });
  const store = evaluationAccess.store;
  useBackend(store);
  // 内置技能（做 PPT、Word、Excel 的步骤和规范）：和手机 / 电脑一样装上，版本更新时跟着升级
  const seeded = new Map(); // 用户最多50人；每人升级一次内置技能，不覆盖个人启停状态。
  const initialize = () => {
    const id = currentUser();
    if (!seeded.has(id)) seeded.set(id, seedBuiltins());
    return seeded.get(id);
  };
  const ready = initialize();
  const configFile = path.join(dataDir, 'config.json');
  const loadConfig = () => {
    let cfg;
    try { cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch { cfg = { ...DEFAULT_CONFIG }; }
    if (currentUser() !== PRIMARY_USER) {
      // 只共享模型及工具配置，管理员GitHub授权与仓库绑定绝不借给成员。
      delete cfg.codeAccount; delete cfg.codeRepos;
      try { const own = JSON.parse(fs.readFileSync(path.join(userDataDir(dataDir), 'code-config.json'), 'utf8')); cfg.codeAccount = own.codeAccount; cfg.codeRepos = own.codeRepos; } catch { /* 新成员尚未连接自己的代码账户。 */ }
    }
    return cfg;
  };
  const saveConfig = (cfg) => {
    const target = currentUser() === PRIMARY_USER ? configFile : path.join(userDataDir(dataDir), 'code-config.json');
    if (currentUser() !== PRIMARY_USER) cfg = { codeAccount: cfg.codeAccount, codeRepos: cfg.codeRepos };
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(`${target}.tmp`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(cfg, null, 2)); } finally { fs.closeSync(fd); }
    fs.renameSync(`${target}.tmp`, target);
  };
  // systemd的PrivateTmp不与Docker守护进程共享/tmp，必须把绑定源放到数据目录。
  const sandbox = userService(() => codeSandbox ?? createCodeSandbox({ image: process.env.JARVIS_CODE_SANDBOX_IMAGE, registry: process.env.JARVIS_CODE_NPM_REGISTRY, baseDir: path.join(userDataDir(dataDir), 'code-jobs') }));
  const browser = userService(() => createCodeBrowser({ image: process.env.JARVIS_CODE_BROWSER_IMAGE, baseDir: path.join(userDataDir(dataDir), 'code-browser-jobs') }));
  const codeRepos = userService(() => createCodeRepos({ browser, baseDir: path.join(userDataDir(dataDir), 'repos'), getConfig: loadConfig, hosting: codeHosting, editing: true, sandbox, ...(codeGit && { git: codeGit }) }));
  // 技能脚本运行器：技能里的 Python / Node 命令在隔离的 Docker 里跑（没装 Docker 或镜像时照实告诉模型怎么装）
  const skillRunner = userService(() => createSkillRunner({ image: process.env.JARVIS_SKILL_RUNNER_IMAGE || SKILL_RUNNER_IMAGE, baseDir: path.join(userDataDir(dataDir), 'skill-runner') }));
  let runner;
  const projects = userService(() => createCodeProjects({ dataDir: userDataDir(dataDir), getConfig: loadConfig, saveConfig, legacyRepos: codeRepos, hosting: codeHosting, git: codeGit, sandbox, browser,
    validateSession: async sessionId => { if (!await sessions.get(sessionId)) throw Object.assign(new Error('请先开始服务器对话，再管理项目'), { code: 'CODE_SCOPE' }); },
    isBusy: sessionId => (runner?.list() || []).some(t => t.sessionId === sessionId && ['queued','running'].includes(t.status)),
    onBind: async (sessionId, projectId, taskId) => {
      const s = await sessions.get(sessionId);
      if (!s) throw Object.assign(new Error('对话不存在，请先开始对话'), { code: 'CODE_SCOPE' });
      if (s.codeProjectId !== projectId) { s.codeProjectId = projectId; s.taskCheckpoint = null; }
      if (taskId) s.taskCheckpoint = { text: 'GitHub项目开发', status: 'done', codeTaskId: taskId, taskId, steps: [], inFlight: [] };
      await sessions.save(s);
    }
  }));
  const lookupService = userService(() => injectedLookup ?? createLookupService({ storage: { get: id => store.get('kv', id), put: row => store.put('kv', row) }, get: publicFetch }));
  const phoneBroker = createPhoneBroker({ active: security.users.active });
  security.onRevoke(id => phoneBroker.revokeSession(id));
  runner = injected ?? createTaskRunner({ phoneBroker, ...(makeTaskAdapter && { makeAdapter: makeTaskAdapter }), codeProjects: projects, getConfig: async () => withoutCodeCredentials(loadConfig()), maxRunning: () => loadConfig().taskConcurrency ?? maxRunning, skillRunner, codeRepos, projectBaseDir: () => path.join(userDataDir(dataDir), 'project-jobs'), lookupService, evaluationAccess, userAccess: { current: currentUser, run: runAsUser, active: security.users.active } });
  // 定时任务 / 提醒：服务器自己按时执行（手机关着也做），见 serverSchedules.mjs；测试里不自动开始计时
  const schedules = userService(() => createServerSchedules({ runner, active: () => security.users.active(currentUser()) }));
  // 启动时为每个有效身份恢复提醒；新建成员的定时器在首次请求时启动。
  if (autoSchedules) for (const id of security.users.ids()) runAsUser(id, () => schedules.start());
  let activePCModels = 0;
  let activeCatalogs = 0;
  // WebSocket等只需主人身份；普通HTTP由access逐项判定权限及403。
  const authorized = req => ['owner', 'member'].includes(security.authenticate(req)?.role);

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const lookupRoutes = createLookupRoutes({ service: lookupService, getConfig: loadConfig, json });
  const readinessRoutes = createReadinessRoutes({ getConfig: loadConfig, appDir, json, runtime: readinessRuntime });
  async function readBody(req, limit) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('文件太大（最多 50 MB）'), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  const readJson = async (req, limit = 256 * 1024) => {
    try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); } catch(e) { if(e.status===413)throw e;throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
  };

  const accessRoutes = createAccessRoutes({ security, runner, sessions, readJson, json, getConfig: loadConfig, appDir });
  const searchTest = createSearchTest({ getConfig: () => withoutCodeCredentials(loadConfig()), readJson, json, ...(searchFetch && { fetchViaGateway: searchFetch }) });
  const codeRoutes = createCodeRepoRoutes({ getConfig: loadConfig, saveConfig, hosting: codeHosting, repos: codeRepos, readJson, json });

  const projectRoutes = codeProjectRoutes({ projects, readJson, json });

  function login(req, res, body) {
    json(res, 200, security.login(req, body.password));
  }

  function streamEvents(req, res, id, after) {
    const backlog = runner.events(id, after);
    if (!backlog) return json(res, 404, { error: '找不到这个任务（可能已经做完很久了，结果在对话记录里）' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const send = (ev) => res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    for (const ev of backlog) send(ev);
    const last = backlog.at(-1);
    const finished = (ev) => ev?.type === 'task_state' && ['done', 'error', 'stopped'].includes(ev.status);
    if (finished(last)) return res.end();
    let sent = last?.seq ?? after;
    const unsubscribe = runner.subscribe(id, (ev) => {
      if (ev.seq <= sent) return;
      sent = ev.seq;
      send(ev);
      if (finished(ev)) { cleanup(); res.end(); }
    });
    if (!unsubscribe) return res.end();
    // 心跳：中间的 Nginx / 手机网络长时间没数据会断开连接
    const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
    const unwatch = security.onRevoke(id => { if (security.authenticate(req)?.id === id) { cleanup(); res.end(); } });
    const cleanup = () => { clearInterval(beat); unsubscribe(); unwatch(); };
    req.on('close', cleanup);
  }

  const agentProfileRoutes = createAgentProfileRoutes({ readJson, json });
  const studioRoutes = createStudioRoutes({ dataDir, readJson, json, activeUser: id => security.users.active(id) });
  const phoneRoutes = createPhoneRoutes({ broker: phoneBroker, readJson, json, principal: security.authenticate });
  /** 处理服务器模式的接口；不是这些接口返回 false */
  async function handle(req, res, pathname) {
    if (pathname === '/api/phone/transport' && req.method === 'POST') return phoneRoutes(req, res, pathname);
    const principal = security.authenticate(req);
    return runAsUser(principal?.userId || PRIMARY_USER, async () => {
      if (principal) { await initialize(); if (autoSchedules) schedules.start(); }
      return handleScoped(req, res, pathname);
    });
  }
  async function handleScoped(req, res, pathname) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.has('token')) { json(res, 401, { error: '网址不能携带登录凭证，请使用请求头' }); return true; }
    if (pathname === '/api/server/login' && req.method === 'POST') { login(req, res, await readJson(req)); return true; }
    if (pathname === '/api/health') return false;
    const decision = await accessRoutes.access(req);
    if (decision.status !== 200) { json(res, decision.status, { error: decision.status === 403 ? '此授权不能访问这项功能' : '服务器登录已失效' }); return true; }
    const principal = decision.principal;
    if (await accessRoutes.handle(req, res, pathname)) return true;
    if (await agentProfileRoutes(req, res, pathname, url)) return true;
    if (await studioRoutes(req, res, pathname, url)) return true;
    if (await phoneRoutes(req, res, pathname)) return true;
    if (pathname === '/api/server/readiness') {
      if (!authorized(req)) { json(res, 401, { error: '服务器登录已失效' }); return true; }
      return readinessRoutes(req, res);
    }
    if (pathname === '/api/server/lookup-health') {
      if (!authorized(req)) { json(res, 401, { error: '服务器登录已失效' }); return true; }
      return lookupRoutes(req, res);
    }
    if (pathname.startsWith('/api/server/code-projects')) {
      if (!authorized(req)) { json(res, 401, { error: '服务器登录已失效' }); return true; }
      return projectRoutes(req, res, pathname, url);
    }
    if (pathname === '/api/server/code-repos') {
      if (!authorized(req)) { json(res, 401, { error: '服务器登录已失效' }); return true; }
      return codeRoutes(req, res, pathname);
    }
    if (pathname === '/api/server/status' && req.method === 'GET') { json(res, 200, { ok: true, features:{evaluationMemoryIsolation:true,taskRequestIds:true,taskNotes:true,taskCheckpoints:true,pcModelBridge:true,skillSync:true,multiUser:true}, identity: security.users.identity(principal), running: runner.running, tasks: runner.list().filter((t) => t.status === 'running' || t.status === 'queued') }); return true; }
    if(pathname==='/api/server/pc-model'&&req.method==='POST'){
      if(!authorized(req)){json(res,401,{error:'服务器登录已失效'});return true;}
      if(activePCModels>=2){json(res,429,{error:'PC模型请求繁忙，请稍后重试'});return true;}
      activePCModels++;
      try{const body=await readJson(req,UPLOAD_LIMIT);await streamPCModel(req,res,body,{cfg:withoutCodeCredentials(loadConfig()),makeAdapter:makeModelAdapter});}
      finally{activePCModels--;}
      return true;
    }
    if (pathname === '/api/server/search-test' && req.method === 'POST') {
      await searchTest(req, res);
      return true;
    }
    if (pathname === '/api/server/stock-images/probe' && req.method === 'POST') {
      if (!authorized(req)) { json(res, 401, { error: '服务器登录已失效' }); return true; }
      const body = await readJson(req);
      if (body.network !== 'cn') { json(res, 400, { error: '请确认执行服务器位于国内网络' }); return true; }
      if (!STOCK_PROVIDERS.includes(body.provider)) { json(res, 400, { error: '图库名称不支持' }); return true; }
      const original = loadConfig();
      const service = createStockImages({ getConfig: () => original, fetchImpl: publicFetch });
      let result;
      try { result = await service.probe(body.provider, { signal: AbortSignal.timeout(25000) }); }
      catch (error) {
        const detail = stockDiagnostic(error, { provider:body.provider, phase:'api' });
        json(res, 502, { error:detail.note, ...detail }); return true;
      }
      const cfg = loadConfig();
      if (cfg[body.provider + 'Key'] !== original[body.provider + 'Key']) { json(res, 409, { error: '检测期间密钥已改变，请重新检测' }); return true; }
      saveConfig({ ...cfg, stockVerified: { ...cfg.stockVerified, [body.provider]: result } });
      json(res, 200, result); return true;
    }
    if (pathname === '/api/server/config') {
      if (req.method === 'GET') { json(res, 200, principal.role === 'member' ? memberModelConfig(loadConfig()) : maskConfig(loadConfig())); return true; }
      if (req.method === 'PUT') {
        // 请求正文尚未收完时，另一台设备可能刚保存了新Key。收完再读配置，
        // 同步合并/写盘，防止慢请求把先读到的旧Key覆盖回去。
        const patch = await readJson(req);
        const next = mergeConfig(loadConfig(), patch);
        saveConfig(next);
        const stored = loadConfig();
        // 写盘失败或读回不一致绝不显示“已保存”；只比较，不回传完整密钥。
        if (Object.entries(next.keys || {}).some(([id, key]) => stored.keys?.[id] !== key))
          throw Object.assign(new Error('云服务器Key保存后核对失败，请重试'), { status: 500, code: 'MODEL_KEY_SAVE' });
        json(res, 200, { ok: true }); return true;
      }
    }
    // 记忆向量现在的情况（模型页“记忆向量”那一行显示）；还有没算向量的记忆就在后台补
    if (pathname === '/api/server/memory-status' && req.method === 'GET') {
      const embedder = createEmbedder(withoutCodeCredentials(loadConfig()), { direct: true });
      if (embedder) setEmbedder(embedder);
      const status = embedder ? await vectorStatus() : { model: null, total: 0, embedded: 0, lastError: null };
      if (embedder && status.embedded < status.total) backfillVectors().catch(() => {});
      json(res, 200, status);
      return true;
    }
    // 技能：手机 / 电脑装好的技能传到服务器（服务器模式下任务在服务器上做，技能也得在服务器上）
    if (pathname === '/api/server/skills' && req.method === 'GET') {
      const list = await skillPacks.list();
      json(res, 200, { runner: { available: await skillRunner.available(), image: skillRunner.image }, skills: list.map((p) => ({ name: p.name, description: p.description, source: p.source, enabled: p.enabled !== false, builtin: p.source === '内置', needsRunner: needsRunner(p), installedAt: p.installedAt })) });
      return true;
    }
    if (pathname === '/api/server/skills' && req.method === 'POST') {
      const body = await readJson(req, UPLOAD_LIMIT);
      if (!body?.files || typeof body.files !== 'object' || Array.isArray(body.files)) { json(res, 400, { error: '缺少技能文件' }); return true; }
      try {
        const pack = await skillPacks.installFromFiles(body.files, { source: String(body.source || '手机 / 电脑同步').slice(0, 200) });
        json(res, 200, { name: pack.name, needsRunner: needsRunner(pack), runner: await skillRunner.available() });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
      return true;
    }
    // 手机 / 电脑上卸载技能时，服务器上的那份也删掉（不然任务照样会用到）
    const skillPath = pathname.match(/^\/api\/server\/skills\/([^/]{1,200})$/);
    if (skillPath && req.method === 'PATCH') {
      let skillName = '';
      try { skillName = decodeURIComponent(skillPath[1]); } catch { json(res, 400, { error: '技能名不对' }); return true; }
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') { json(res, 400, { error: 'enabled必须是布尔值' }); return true; }
      if (!await skillPacks.get(skillName)) { json(res, 404, { error: '服务器上没有这个技能；不会自动重装已卸载技能' }); return true; }
      await skillPacks.setEnabled(skillName, body.enabled);
      json(res, 200, { name: skillName, enabled: (await skillPacks.get(skillName)).enabled });
      return true;
    }
    if (skillPath && req.method === 'DELETE') {
      let skillName = '';
      try { skillName = decodeURIComponent(skillPath[1]); } catch { json(res, 400, { error: '技能名不对' }); return true; }
      const existed = Boolean(await skillPacks.get(skillName));
      if (existed) await skillPacks.remove(skillName);
      json(res, 200, { ok: true, removed: existed });
      return true;
    }
    if (pathname === '/api/server/document-styles' && req.method === 'GET') {
      json(res, 200, await listDocumentStyles());
      return true;
    }
    const stylePath = pathname.match(/^\/api\/server\/document-styles\/([\w-]{1,80})$/);
    if (stylePath && req.method === 'DELETE') {
      await deleteDocumentStyle(stylePath[1]);
      json(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/api/server/models' && req.method === 'POST') {
      if (!authorized(req)) { json(res, 401, { error: '服务器登录已失效' }); return true; }
      if (activeCatalogs >= 2) { json(res, 429, { error: '正在拉取模型，请稍后重试' }); return true; }
      const { provider } = await readJson(req);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      activeCatalogs++;
      try { json(res, 200, await serverModelCatalog(withoutCodeCredentials(loadConfig()), provider, controller.signal)); }
      catch (error) {
        if (error.name === 'AbortError' || error.code === 'RETRIEVAL_BUDGET') throw error;
        // 服务商的401不是未央登录失效，避免手机把访问令牌误判为过期。
        const httpStatus = error.code === 'INVALID_PROVIDER' ? 400 : error.kind === 'timeout' ? 504 : 502;
        json(res, httpStatus, { error: error.message, code: error.code, kind: error.kind, upstreamStatus: error.status });
      }
      finally { activeCatalogs--; res.off('close', cancel); }
      return true;
    }
    if (pathname === '/api/server/update') {
      const auto = fs.existsSync(updateUnit);
      if (req.method === 'GET') {
        let last = null;
        try { last = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-status.json'), 'utf8')); } catch { /* 还没检查过 */ }
        let version = '';
        try { version = fs.readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim(); } catch { /* 不是用安装包装的 */ }
        json(res, 200, { version, auto, last, requested: fs.existsSync(path.join(dataDir, 'update-request')) });
        return true;
      }
      if (req.method === 'POST') {
        if (!auto) { json(res, 409, { error: '服务器上还没装自动更新：在服务器终端用新版安装包运行一次 install.sh 就有了' }); return true; }
        fs.writeFileSync(path.join(dataDir, 'update-request'), `${new Date().toISOString()}\n`);
        json(res, 200, { ok: true });
        return true;
      }
    }
    if (pathname === '/api/server/schedules' && req.method === 'GET') { json(res, 200, await scheduler.list()); return true; }
    if (pathname === '/api/server/notices' && req.method === 'GET') { const after = Number(url.searchParams.get('after')) || 0; const securityNotices = security.overview(principal).notices.filter(n => n.at > after).map(n => ({ id: n.id, at: n.at, kind: 'security', deviceId: n.sessionId, title: '新设备登录', body: `${new Date(n.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${n.ip} · ${n.device}；可在设置→服务器→登录安全中退出此设备` })); json(res, 200, [...await scheduleNotices(after), ...securityNotices].sort((a, b) => a.at - b.at)); return true; }
    const sch = pathname.match(/^\/api\/server\/schedules\/([\w-]{1,60})(\/run)?$/);
    if (sch) {
      if (sch[2] && req.method === 'POST') {
        const s = (await scheduler.list()).find((x) => x.id === sch[1]);
        if (!s) { json(res, 404, { error: '找不到这个定时任务' }); return true; }
        if (!schedules.runNow(s)) { json(res, 409, { error: '有定时任务正在运行，稍后再试' }); return true; }
        json(res, 200, { started: true }); return true;
      }
      if (!sch[2] && req.method === 'PATCH') {
        const body = await readJson(req);
        const s = await scheduler.update(sch[1], { enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, when: typeof body.when === 'string' ? body.when : undefined, prompt: typeof body.prompt === 'string' ? body.prompt : undefined, title: typeof body.title === 'string' ? body.title : undefined });
        s ? json(res, 200, s) : json(res, 404, { error: '找不到这个定时任务' }); return true;
      }
      if (!sch[2] && req.method === 'DELETE') { await scheduler.remove(sch[1]); json(res, 200, { ok: true }); return true; }
    }
    if (pathname === '/api/server/schedules' && req.method === 'POST') {
      const body = await readJson(req);
      // 口语时间（“每天 9 点”）或面板表单的分项（kind / time / weekday / at / everyMinutes）都收；服务器上没人确认，不开无人值守操作
      const timing = typeof body.when === 'string' ? scheduler.parseWhen(body.when) : { kind: body.kind, time: body.time, weekday: body.weekday, at: body.at, everyMinutes: body.everyMinutes };
      json(res, 200, await scheduler.upsert({ title: body.title, prompt: body.prompt, unattended: false, ...(typeof body.agentId === 'string' && { agentId: body.agentId }), ...timing })); return true;
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const { sessionId = null, text, images, voice, requestId, evaluationId, agentId = null, agentForm = null } = await readJson(req, IMPORT_LIMIT); // 可能带图片，放宽大小
      let forcedEvaluationId = evaluationId ?? null;
      if (principal.role === 'evaluation') {
        const existing = sessionId ? await sessions.get(sessionId) : null;
        if (sessionId && !accessRoutes.owned(principal, existing)) { json(res, 403, { error: '评测授权不能接入这个对话' }); return true; }
        forcedEvaluationId = existing && !evaluationId ? existing.evaluationId : security.evaluationScope(principal, evaluationId);
      }
      if (principal.role === 'evaluation' && security.remaining(principal.id) < 1) { json(res, 429, { error: '评测令牌今日模型与搜索调用次数已达上限', code: 'EVAL_QUOTA' }); return true; }
      json(res, 200, await runner.start({ sessionId, text, images, voice: voice === true, requestId:requestId??null, evaluationId: forcedEvaluationId, agentId, agentForm, ...(principal.role === 'evaluation' && { evaluationAuthorization: { id: principal.id } }) })); return true;
    }
    if (pathname === '/api/tasks' && req.method === 'GET') { json(res, 200, runner.list().filter(row => principal.role !== 'evaluation' || accessRoutes.owned(principal, row))); return true; }
    const t = pathname.match(/^\/api\/tasks\/([\w-]+)(\/events|\/stop|\/notes)?$/);
    if (t) {
      if (t[2] === '/notes' && req.method === 'POST') {
        const task=runner.get(t[1]);if(!task){json(res,404,{error:'原任务不存在'});return true;}
        const {text,requestId}=await readJson(req,IMPORT_LIMIT);
        json(res,200,await runner.start({sessionId:task.sessionId,text,requestId:requestId??null,targetTaskId:t[1], ...(principal.role === 'evaluation' && { evaluationId: task.evaluationId, evaluationAuthorization: { id: principal.id } })}));return true;
      }
      if (!t[2] && req.method === 'GET') { const info = runner.get(t[1]); info ? json(res, 200, info) : json(res, 404, { error: '找不到这个任务' }); return true; }
      if (t[2] === '/events' && req.method === 'GET') { streamEvents(req, res, t[1], Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0)); return true; }
      if (t[2] === '/stop' && req.method === 'POST') { json(res, 200, { ok: runner.stop(t[1]) }); return true; }
    }
    if (pathname === '/api/sessions/import' && req.method === 'POST') {
      // 手机 / 电脑本机的对话传上来：服务器上没有的才存（已有的不覆盖，免得冲掉服务器上新聊的内容）
      const one = JSON.parse((await readBody(req, IMPORT_LIMIT)).toString('utf8') || '{}');
      if (!/^[\w-]{1,40}$/.test(String(one.id)) || !Array.isArray(one.messages)) { json(res, 400, { error: '对话格式不对' }); return true; }
      if (await sessions.get(one.id)) { json(res, 200, { ok: true, skipped: true }); return true; }
      const messages = one.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(({ role, content, ts, tools, files }) => ({ role, content, ts: Number(ts) || Date.now(), ...(Array.isArray(tools) && { tools: tools.slice(0, 30) }), ...(Array.isArray(files) && { files: files.slice(0, 12) }) }));
      if (!messages.length) { json(res, 200, { ok: true, skipped: true }); return true; }
      await sessions.save({ id: one.id, title: String(one.title || '新对话').slice(0, 60), titleSet: Boolean(one.titleSet), createdAt: Number(one.createdAt) || Date.now(), updatedAt: Number(one.updatedAt) || Date.now(), pinned: Boolean(one.pinned), messages, ...(one.summary && { summary: one.summary }), ...(one.requirements && { requirements: one.requirements }) });
      json(res, 200, { ok: true, imported: true });
      return true;
    }
    if (pathname === '/api/sessions/search' && req.method === 'GET') {
      // 按内容搜：标题或任何一条消息里有这个词；每段对话给一句带上下文的摘录
      const hits = await sessions.searchContent(url.searchParams.get('q') || '');
      json(res, 200, hits);
      return true;
    }
    const sub = pathname.match(/^\/api\/sessions\/([\w-]+)\/(truncate|append)$/);
    if (sub && req.method === 'POST') {
      const [, id, op] = sub;
      if (runner.list().some((x) => x.sessionId === id && (x.status === 'running' || x.status === 'queued'))) { json(res, 409, { error: '这段对话正在做任务，等做完再改' }); return true; }
      const body = await readJson(req, IMPORT_LIMIT);
      const ok = await runner.edit(id, async (one) => {
        // 电脑上新开的对话第一句就在本机做了：服务器上还没有这段，用同一个编号新建
        if (!one && op === 'append') one = { ...sessions.create(), id };
        if (!one) return false;
        if (op === 'truncate') one.messages = one.messages.slice(0, Math.max(0, Number(body.keep) || 0));
        else {
          const add = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(0, 20)
            .map(({ role, content, ts, tools, files }) => ({ role, content: content.slice(0, 200000), ts: Number(ts) || Date.now(), ...(Array.isArray(tools) && { tools: tools.slice(0, 30) }), ...(Array.isArray(files) && { files: files.slice(0, 12) }) }));
          one.messages.push(...add);
        }
        one.updatedAt = Date.now();
        // 截成空的（从第一句话开始重来）：sessions.save 不存空对话，直接写进存储
        if (one.messages.length) await sessions.save(one); else await store.put('sessions', one);
        return true;
      });
      ok ? json(res, 200, { ok: true }) : json(res, 404, { error: '找不到这个对话' });
      return true;
    }
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const busy = new Map(runner.list().filter((x) => x.status === 'running' || x.status === 'queued').map((x) => [x.sessionId, x]));
      // 评测会话不进对话列表（不然手机会把最近一段评测当成“当前对话”打开）
      json(res, 200, (principal.role === 'evaluation' ? await store.all('sessions') : await sessions.list()).filter((x) => principal.role === 'evaluation' ? accessRoutes.owned(principal, x) : !x.evaluationId).map(({ messages, requirements, taskCheckpoint, taskReceipts, recoveryCheckpoints, ...s }) => ({ ...s, count: messages.length, taskId: busy.get(s.id)?.id ?? null, taskStatus: busy.get(s.id)?.status ?? null, lastReplyAt: messages.findLast((m) => m.role === 'assistant' || m.role === 'agent')?.ts ?? null })));
      return true;
    }
    // 回收站：删到回收站 / 看回收站 / 恢复（7 天后真正删掉，见 sessions.js）
    if (pathname === '/api/sessions/trash' && req.method === 'GET') { json(res, 200, await sessions.listTrash()); return true; }
    const trashed = pathname.match(/^\/api\/sessions\/([\w-]+)\/(trash|restore)$/);
    if (trashed && req.method === 'POST') {
      const r = trashed[2] === 'trash' ? await sessions.trash(trashed[1]) : await sessions.restore(trashed[1]);
      r ? json(res, 200, r) : json(res, 404, { error: '找不到这个对话' });
      return true;
    }
    const s = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (s) {
      if (req.method === 'GET') {
        const one = await sessions.get(s[1]);
        const busy = runner.list().find((x) => x.sessionId === s[1] && (x.status === 'running' || x.status === 'queued'));
        // 还在做的：半截回答不给（手机会接上实时进度，做完拿完整的）
        one ? json(res, 200, { ...one, messages: busy ? one.messages.filter((m) => m.draftOf !== busy.id) : one.messages, taskId: busy?.id ?? null }) : json(res, 404, { error: '找不到这个对话' });
        return true;
      }
      if (req.method === 'PATCH') {
        const { title, pinned } = await readJson(req);
        if (title !== undefined) await sessions.rename(s[1], title);
        if (pinned !== undefined) await sessions.setPinned(s[1], Boolean(pinned));
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'DELETE') { await sessions.remove(s[1]); json(res, 200, { ok: true }); return true; }
    }
    if (pathname === '/api/work-records' && req.method === 'GET') { json(res, 200, await listWorkRecords({ kind: url.searchParams.get('kind') || '', format: url.searchParams.get('format') || '', path: (url.searchParams.get('path') || '').slice(0, 600), offset: Number(url.searchParams.get('offset')) || 0, limit: Number(url.searchParams.get('limit')) || 50 })); return true; }
    if (pathname.startsWith('/api/work-records/') && req.method === 'PATCH') { const body = await readJson(req); if (typeof body.title !== 'string' || body.title.length > 160) { json(res, 400, { error: '名称格式不正确' }); return true; } await renameWorkRecord(decodeURIComponent(pathname.slice('/api/work-records/'.length)), body.title); json(res, 200, { ok: true }); return true; }
    if (pathname.startsWith('/api/work-records/') && req.method === 'DELETE') { await removeWorkRecord(decodeURIComponent(pathname.slice('/api/work-records/'.length))); json(res, 200, { ok: true }); return true; }
    if (pathname === '/api/files' && req.method === 'GET') { json(res, 200, await ws.list(url.searchParams.get('prefix') || '')); return true; }
    if (pathname === '/api/files/raw') {
      const p = ws.normalize(url.searchParams.get('path') || '');
      if (req.method === 'GET') {
        const blob = await ws.readBlob(p).catch(() => null);
        if (!blob) { json(res, 404, { error: '找不到文件' }); return true; }
        res.writeHead(200, { 'Content-Type': blob.type || 'application/octet-stream', 'Content-Length': blob.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(p.split('/').pop())}`, 'Cache-Control': 'no-store' });
        res.end(Buffer.from(await blob.arrayBuffer()));
        return true;
      }
      if (req.method === 'PUT') {
        // encoding=base64：内容是 { data: Base64 }（手机 App 原生网络传不了原始字节）
        const raw = await readBody(req, url.searchParams.get('encoding') === 'base64' ? Math.ceil(UPLOAD_LIMIT * 1.4) : UPLOAD_LIMIT);
        const bytes = url.searchParams.get('encoding') === 'base64' ? Buffer.from(JSON.parse(raw.toString('utf8') || '{}').data || '', 'base64') : raw;
        const r = await ws.write(p, new Blob([bytes], { type: ws.MIME[ws.ext(p)] || 'application/octet-stream' }));
        json(res, 200, r);
        return true;
      }
    }
    return false;
  }

  return { authorized, watchAccess: (req, close) => { const principal = security.authenticate(req); return security.onRevoke(id => { if (id === principal?.id) close(); }); }, access: req => runAsUser(security.authenticate(req)?.userId || PRIMARY_USER, () => accessRoutes.access(req)), handle, runner, schedules, store, ready, realtimeKey: () => loadConfig().keys?.qwen || '', qweather: () => qweatherConfig(loadConfig()) };
}
