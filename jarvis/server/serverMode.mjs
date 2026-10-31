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
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFileStore } from './fileStore.mjs';
import { createTaskRunner, publicFetch } from './taskRunner.mjs';
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
/** 登录令牌：由密码算出来（改密码后旧令牌自动失效），不在服务器上另存 */
export const tokenFor = (password) => createHash('sha256').update(`jarvis-server:${password}`).digest('hex');

/** 模型设置里的密钥只给看后 4 位 */
export function maskConfig(cfg) {
  cfg = withoutCodeCredentials(cfg);
  const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
  return { ...cfg, keys: Object.fromEntries(Object.entries(cfg.keys ?? {}).map(([k, v]) => [k, mask(v)])), tavilyKey: mask(cfg.tavilyKey), bochaKey: mask(cfg.bochaKey), deepseekSearchKey: mask(cfg.deepseekSearchKey), falKey: mask(cfg.falKey), qweatherKey: mask(cfg.qweatherKey) };
}
/** 保存时：密钥没改（还是 •••• 或留空）就沿用原来的 */
export function mergeConfig(old, next) {
  // GitHub凭据只在专用仓库设置接口更新，模型面板的旧快照不能清空或覆盖。
  const { codeRepos: ignored, codeAccount: ignoredAccount, ...modelSettings } = next;
  next = modelSettings;
  if (Object.hasOwn(next, 'publicDataHosts')) next = { ...next, publicDataHosts: publicDataHosts(next.publicDataHosts) };
  if (Object.hasOwn(next, 'lookupRegion') && !LOOKUP_REGIONS.includes(next.lookupRegion)) throw Object.assign(new Error('查询地区只接受auto、cn或global'), { status: 400, code: 'LOOKUP_REGION' });
  const keep = (n, o) => (!n || String(n).startsWith('••••') ? o ?? '' : n);
  const keys = { ...(old.keys ?? {}) };
  for (const [k, v] of Object.entries(next.keys ?? {})) keys[k] = keep(v, old.keys?.[k]);
  const maps = Object.fromEntries(['models', 'baseURLs', 'providerNames', 'modelLists', 'serviceTiers'].map((field) => [field, { ...old[field], ...next[field] }]));
  const merged = { ...old, ...next, ...maps, keys, tavilyKey: keep(next.tavilyKey, old.tavilyKey), bochaKey: keep(next.bochaKey, old.bochaKey), deepseekSearchKey: keep(next.deepseekSearchKey, old.deepseekSearchKey), falKey: keep(next.falKey, old.falKey), qweatherKey: keep(next.qweatherKey, old.qweatherKey) };
  // 字典合并不能把前端淘汰的旧地址缓存重新带回来；服务器也必须执行同一上限。
  if (next.modelLists || next.baseURLs) merged.modelLists = boundedCatalogs(merged);
  // 前端删掉的服务商：字典合并不会自己少掉，照着标记删
  return applyRemovedProviders(merged, next.removedProviders, next);
}

/**
 * @param {{ dataDir: string, password: string, maxRunning?: number, runner?: object }} o
 */
export function createServerMode({ dataDir, password, maxRunning = 1, runner: injected = null, appDir = APP_DIR, updateUnit = UPDATE_UNIT, makeModelAdapter, autoSchedules = false, codeHosting = createGitHubHost(), codeGit, codeSandbox = null, lookupService: injectedLookup = null } = {}) {
  if (!password || String(password).length < 8) throw new Error('服务器模式需要设置 JARVIS_PASSWORD（至少 8 位）');
  const store = createFileStore(path.join(dataDir, 'store'));
  useBackend(store);
  // 内置技能（做 PPT、Word、Excel 的步骤和规范）：和手机 / 电脑一样装上，版本更新时跟着升级
  const ready=seedBuiltins().catch((e) => console.warn('[服务器模式] 内置技能没装上：', e?.message || e));
  const configFile = path.join(dataDir, 'config.json');
  const loadConfig = () => {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch { return { ...DEFAULT_CONFIG }; }
  };
  const saveConfig = (cfg) => {
    const fd = fs.openSync(`${configFile}.tmp`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(cfg, null, 2)); } finally { fs.closeSync(fd); }
    fs.renameSync(`${configFile}.tmp`, configFile);
  };
  // systemd的PrivateTmp不与Docker守护进程共享/tmp，必须把绑定源放到数据目录。
  const sandbox = codeSandbox ?? createCodeSandbox({ image: process.env.JARVIS_CODE_SANDBOX_IMAGE, registry: process.env.JARVIS_CODE_NPM_REGISTRY, baseDir: path.join(dataDir, 'code-jobs') });
  const browser = createCodeBrowser({ image: process.env.JARVIS_CODE_BROWSER_IMAGE, baseDir: path.join(dataDir, 'code-browser-jobs') });
  const codeRepos = createCodeRepos({ browser, baseDir: path.join(dataDir, 'repos'), getConfig: loadConfig, hosting: codeHosting, editing: true, sandbox, ...(codeGit && { git: codeGit }) });
  // 技能脚本运行器：技能里的 Python / Node 命令在隔离的 Docker 里跑（没装 Docker 或镜像时照实告诉模型怎么装）
  const skillRunner = createSkillRunner({ image: process.env.JARVIS_SKILL_RUNNER_IMAGE || SKILL_RUNNER_IMAGE, baseDir: path.join(dataDir, 'skill-runner') });
  let runner;
  const projects = createCodeProjects({ dataDir, getConfig: loadConfig, saveConfig, legacyRepos: codeRepos, hosting: codeHosting, git: codeGit, sandbox, browser,
    validateSession: async sessionId => { if (!await sessions.get(sessionId)) throw Object.assign(new Error('请先开始服务器对话，再管理项目'), { code: 'CODE_SCOPE' }); },
    isBusy: sessionId => (runner?.list() || []).some(t => t.sessionId === sessionId && ['queued','running'].includes(t.status)),
    onBind: async (sessionId, projectId, taskId) => {
      const s = await sessions.get(sessionId);
      if (!s) throw Object.assign(new Error('对话不存在，请先开始对话'), { code: 'CODE_SCOPE' });
      if (s.codeProjectId !== projectId) { s.codeProjectId = projectId; s.taskCheckpoint = null; }
      if (taskId) s.taskCheckpoint = { text: 'GitHub项目开发', status: 'done', codeTaskId: taskId, taskId, steps: [], inFlight: [] };
      await sessions.save(s);
    }
  });
  const lookupService = injectedLookup ?? createLookupService({ storage: { get: id => store.get('kv', id), put: row => store.put('kv', row) }, get: publicFetch });
  runner = injected ?? createTaskRunner({ codeProjects: projects, getConfig: async () => withoutCodeCredentials(loadConfig()), maxRunning, skillRunner, codeRepos, projectBaseDir: path.join(dataDir, 'project-jobs'), lookupService });
  // 定时任务 / 提醒：服务器自己按时执行（手机关着也做），见 serverSchedules.mjs；测试里不自动开始计时
  const schedules = createServerSchedules({ runner });
  if (autoSchedules) schedules.start();
  const want = Buffer.from(tokenFor(password));
  const failures = new Map(); // IP → 最近登录失败的时间（防止暴力猜密码）
  let activePCModels=0;
  let activeCatalogs=0;

  function authorized(req) {
    const url = new URL(req.url, 'http://x');
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const lookupRoutes = createLookupRoutes({ service: lookupService, getConfig: loadConfig, json });
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

  const searchTest = createSearchTest({ getConfig: () => withoutCodeCredentials(loadConfig()), readJson, json });
  const codeRoutes = createCodeRepoRoutes({ getConfig: loadConfig, saveConfig, hosting: codeHosting, repos: codeRepos, readJson, json });

  const projectRoutes = codeProjectRoutes({ projects, readJson, json });

  function login(req, res, body) {
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    const recent = (failures.get(ip) ?? []).filter((t) => Date.now() - t < 10 * 60_000);
    if (recent.length >= 5) return json(res, 429, { error: '密码错误次数太多，10 分钟后再试' });
    const got = Buffer.from(tokenFor(String(body.password ?? '')));
    if (got.length === want.length && timingSafeEqual(got, want)) { failures.delete(ip); return json(res, 200, { token: tokenFor(password) }); }
    failures.set(ip, [...recent, Date.now()]);
    return json(res, 401, { error: '密码不对' });
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
    const cleanup = () => { clearInterval(beat); unsubscribe(); };
    req.on('close', cleanup);
  }

  /** 处理服务器模式的接口；不是这些接口返回 false */
  async function handle(req, res, pathname) {
    const url = new URL(req.url, 'http://x');
    if (pathname === '/api/server/login' && req.method === 'POST') { login(req, res, await readJson(req)); return true; }
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
    if (pathname === '/api/server/status' && req.method === 'GET') { json(res, 200, { ok: true, features:{evaluationMemoryIsolation:true,taskRequestIds:true,taskNotes:true,taskCheckpoints:true,pcModelBridge:true,skillSync:true}, running: runner.running, tasks: runner.list().filter((t) => t.status === 'running' || t.status === 'queued') }); return true; }
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
    if (pathname === '/api/server/config') {
      if (req.method === 'GET') { json(res, 200, maskConfig(loadConfig())); return true; }
      if (req.method === 'PUT') { saveConfig(mergeConfig(loadConfig(), await readJson(req))); json(res, 200, { ok: true }); return true; }
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
    if (pathname === '/api/server/notices' && req.method === 'GET') { json(res, 200, await scheduleNotices(Number(url.searchParams.get('after')) || 0)); return true; }
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
      json(res, 200, await scheduler.upsert({ title: body.title, prompt: body.prompt, unattended: false, ...timing })); return true;
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const { sessionId = null, text, images, voice, requestId, evaluationId } = await readJson(req, IMPORT_LIMIT); // 可能带图片，放宽大小
      json(res, 200, await runner.start({ sessionId, text, images, voice: voice === true, requestId:requestId??null, evaluationId:evaluationId??null })); return true;
    }
    if (pathname === '/api/tasks' && req.method === 'GET') { json(res, 200, runner.list()); return true; }
    const t = pathname.match(/^\/api\/tasks\/([\w-]+)(\/events|\/stop|\/notes)?$/);
    if (t) {
      if (t[2] === '/notes' && req.method === 'POST') {
        const task=runner.get(t[1]);if(!task){json(res,404,{error:'原任务不存在'});return true;}
        const {text,requestId}=await readJson(req,IMPORT_LIMIT);
        json(res,200,await runner.start({sessionId:task.sessionId,text,requestId:requestId??null,targetTaskId:t[1]}));return true;
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
      const busy = new Map(runner.list().filter((x) => x.status === 'running' || x.status === 'queued').map((x) => [x.sessionId, x.id]));
      // 评测会话不进对话列表（不然手机会把最近一段评测当成“当前对话”打开）
      json(res, 200, (await sessions.list()).filter((x) => !x.evaluationId).map(({ messages, requirements, taskCheckpoint, taskReceipts, recoveryCheckpoints, ...s }) => ({ ...s, count: messages.length, taskId: busy.get(s.id) ?? null })));
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

  return { authorized, handle, runner, schedules, store, ready, realtimeKey: () => loadConfig().keys?.qwen || '', qweather: () => qweatherConfig(loadConfig()) };
}
