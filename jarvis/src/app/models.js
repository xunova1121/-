import { createHelperLlm } from '../llm/helper.js';
/**
 * 模型与网关：连本机网关、模型名显示、服务器模式的连接和模型同步、给内部环节用的辅助模型、记忆引擎配置。
 */
import { STANDALONE, MOBILE } from '../config.js';
import { loadConfig, createAdapter, displayName, providerById, modelOf } from '../llm/config.js';
import { routeFor, fallbackRoutes, visionRoute } from '../llm/router.js';
import { chipLabel, isAuto } from '../ui/modelPicker.js';
import { providerLabel } from '../llm/modelLibrary.js';
import { createEmbedder } from '../llm/embeddings.js';
import { ocrLine, recognizeText } from '../llm/ocr.js';
import { browserMetrics } from '../api/browserMetrics.js';
import { nativeWebFetch } from '../mobile/nativeFetch.js';
import { loadServerSettings, createServerClient, remoteSessions, normalizeUrl } from '../core/serverClient.js';
import * as sessionsApi from '../agent/sessions.js';
import * as agentMemory from '../agent/memory.js';
import * as kb from '../agent/knowledge.js';
import { friendlyError } from '../core/friendlyError.js';
import { $, COMPACT, storage, toast } from './env.js';

export function createModels(app) {
  app.llmConfig = loadConfig();

  /** 单文件版也会尝试连接本机网关（双击 启动.bat 后运行在 127.0.0.1:8787），连上后不受浏览器跨域限制 */
  const LOCAL_GATEWAY = 'http://127.0.0.1:8787';
  let probing = null;
  async function detectGateway() {
    const local = STANDALONE || location.protocol === 'file:';
    probing ??= (async () => {
      try {
        if (MOBILE) throw new Error('mobile'); // 手机上没有本机网关：直接连服务商（原生网络，不受跨域限制）
        const url = local ? `${LOCAL_GATEWAY}/api/health` : '/api/health';
        const h = await (await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout?.(5000) })).json(); // 启动时主线程忙（编译着色器），留足时间
        if (!h?.ok) throw new Error('not a gateway');
        // 这个网址是开了服务器模式的未央服务器，但还没登录：提示去登录（不登录用不了它的任何功能）
        if (h.serverMode && !serverCfg.token)
          setTimeout(() => {
            app.showPanel('settings');
            const u = $('#server-url');
            if (u && !u.value) u.value = location.origin;
            toast('这是你的未央服务器：请先在“服务器模式”里输入访问密码登录');
          }, 800);
        const found = !app.gateway;
        app.gateway = {
          origin: local ? LOCAL_GATEWAY : location.origin,
          keys: h.gatewayKeys ?? [],
          cors: Boolean(h.cors),
          serverMode: Boolean(h.serverMode),
          mcp: Boolean(h.mcp),
          ollama: Boolean(h.ollama)
        };
        if (local && found) toast('已连接本机网关：所有服务商和自定义接口都可以用了');
      } catch {
        app.gateway = null;
        // 单文件版：启动时页面忙可能超时，过几秒再试两次
        if (local && !MOBILE && (detectGateway.retries = (detectGateway.retries ?? 0) + 1) <= 2) setTimeout(() => detectGateway(), 3000);
      }
      app.panels.refreshModels();
      app.voicePanel.render();
      app.mcpPanel.refresh();
      app.localModels.refresh();
      syncMemoryEngine();
      updateModelLabels();
    })().finally(() => {
      probing = null;
    });
    return probing;
  }
  // 单文件版：回到页面时再找一次网关（用户可能刚双击了 启动.bat）
  if ((STANDALONE && !MOBILE) || location.protocol === 'file:') {
    let last = 0;
    addEventListener('focus', () => {
      if (!app.gateway && Date.now() - last > 5000) {
        last = Date.now();
        detectGateway();
      }
    });
  }

  function updateModelLabels() {
    const name = globalThis.__jarvisServerMode
      ? `云服务器 · ${globalThis.__jarvisServerProvider || ''} · ${globalThis.__jarvisServerModel || '读取配置中'}`
      : displayName(app.llmConfig);
    $('#mode-text').textContent = name;
    // 输入框里显示型号（或“自动”），点一下弹出模型列表
    $('#model-chip-text').textContent = COMPACT && isAuto(app.llmConfig) ? `自动 · ${modelOf(app.llmConfig) || '选择模型'}` : chipLabel(app.llmConfig);
    if (globalThis.__jarvisServerMode)
      $('#model-chip-text').textContent = globalThis.__jarvisServerModel
        ? `云端 · ${globalThis.__jarvisServerAuto ? '自动分工' : globalThis.__jarvisServerPinned ? globalThis.__jarvisServerModel : `智能 · ${globalThis.__jarvisServerModel}`}`
        : '云端 · 读取配置中'; // 服务器模式：用服务器上的模型设置
    else $('#model-chip-text').textContent = `本机 · ${$('#model-chip-text').textContent}`;
    $('#model-chip').title = globalThis.__jarvisServerMode
      ? `云服务器 · ${globalThis.__jarvisServerProvider || ''} · ${globalThis.__jarvisServerModel || '读取配置中'}`
      : `本机 · ${name}`;
    if (isAuto(app.llmConfig)) $('#mode-text').textContent = `${name} · 自动选模型`;
    $('#mode-pill').title = `当前模型：${name}${app.gateway ? '（经本机网关）' : ''}。点击切换`;
    $('#hud-model').textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name;
  }

  const metrics = () => (app.gateway ? fetch(`${app.gateway.origin}/api/local/metrics`).then((r) => r.json()) : browserMetrics());
  function fetchDeepseek(url, init = {}) {
    const headers = new Headers(init.headers);
    if (app.gateway?.serverMode && serverCfg.token && normalizeUrl(serverCfg.url) === app.gateway?.origin) {
      // 同源服务器的登录凭据不能冒充DeepSeek密钥，也不能被转发给上游。
      headers.set('x-jarvis-search-key', String(headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
      headers.set('Authorization', 'Bearer ' + serverCfg.token);
    }
    return fetch(`/api/llm/deepseek/${url.slice('https://api.deepseek.com/v1/'.length)}`, { ...init, headers });
  }
  // 网页读取只对完整版开放（单文件版跨域连网关时网关不提供 /api/fetch）
  // 安卓 App 没有本机网关，但系统原生网络没有跨域限制：直接用它搜索、读网页
  const fetchViaGateway = () =>
    app.gateway && !app.gateway.cors
      ? (url, init) =>
          url.startsWith('https://api.deepseek.com/v1/tools/')
            ? fetchDeepseek(url, init)
            : url.startsWith('https://queue.fal.run/')
              ? fetch(`/api/llm/fal/${url.slice('https://queue.fal.run/'.length)}`, init)
              : url.startsWith('https://api.tavily.com/')
                ? fetch(`/api/llm/tavily/${url.slice('https://api.tavily.com/'.length)}`, init)
                : url.startsWith('https://api.bochaai.com/')
                  ? fetch(`/api/llm/bocha/${url.slice('https://api.bochaai.com/'.length)}`, init)
                  : fetch(`/api/fetch?url=${encodeURIComponent(url)}`)
      : globalThis.__jarvisNativeFetch
        ? nativeWebFetch(globalThis.__jarvisNativeFetch)
        : null;

  // 服务器模式（设置 → 服务器模式）：任务交给自己的云服务器做，对话也存在服务器上
  const SERVER_LABEL_KEY = 'jarvis.serverModelLabel';
  const labelGlobals = (l) =>
    l?.model
      ? { __jarvisServerModel: l.model, __jarvisServerAuto: Boolean(l.auto), __jarvisServerPinned: Boolean(l.pinned), __jarvisServerProvider: l.provider || '' }
      : {};
  const serverCfg = loadServerSettings(storage);
  const server = serverCfg.enabled && serverCfg.url && serverCfg.token ? createServerClient({ base: serverCfg.url, token: serverCfg.token }) : null;
  if (server) {
    // 手机 App：连自己的服务器直接走系统原生网络（不先试 WebView、没有跨域预检，国内移动网络下快得多）
    try {
      globalThis.__jarvisPreferNative?.(new URL(server.base).host);
    } catch {
      /* 网址不对就算了 */
    }
    sessionsApi.useRemote(remoteSessions(server));
    globalThis.__jarvisServerMode = true;
    globalThis.__jarvisServerClient = server;
    // 先显示上次记下的服务器模型，不用等连上服务器才不显示“读取配置中”；连上后再按服务器的刷新
    try {
      Object.assign(globalThis, labelGlobals(JSON.parse(storage.getItem(SERVER_LABEL_KEY) || 'null')));
    } catch {
      /* 没记过就等服务器 */
    }
    updateModelLabels();
    refreshServerModel();
  }
  /** 服务器模式：输入框里显示服务器上设的模型 */
  /** 保留旧模块调用名；只刷新，不再把本机配置自动覆盖到服务器。 */
  function pushConfigToServer() {
    refreshServerModel();
  }
  function refreshServerModel() {
    server
      ?.getConfig()
      .then((c) => {
        const label = {
          model: modelOf(c) || '',
          auto: isAuto(c),
          pinned: Boolean(c.pinModel),
          provider: c.providerNames?.[c.provider] || providerById(c.provider)?.name || c.provider
        };
        Object.assign(globalThis, labelGlobals(label));
        try {
          storage.setItem(SERVER_LABEL_KEY, JSON.stringify(label));
        } catch {
          /* 存不了下次就多等一下 */
        }
        updateModelLabels();
      })
      .catch(() => {});
  }
  // 页面就是从自己的服务器打开的：发给它的请求（模型转发、读网页等）都带上登录令牌
  if (serverCfg.token && typeof location !== 'undefined' && normalizeUrl(serverCfg.url) === location.origin) {
    const plain = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (!/^\/api\//.test(url) && !url.startsWith(`${location.origin}/api/`)) return plain(input, init);
      const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${serverCfg.token}`);
      return plain(input, { ...init, headers });
    };
  }

  // ---------------------------------------------------------------- 记忆引擎：整理用的大模型 + 语义向量，随配置变化
  /** 给记忆整理、深度调研等内部环节用的“单次问答”；内置演示或配置不全时返回 null。task 决定用哪个分工模型 */
  function helperLlm(task = 'chat') {
    const { adapter, model, problem } = createAdapter(routeFor(app.llmConfig, task).cfg, { gateway: app.gateway });
    if (problem || providerById(app.llmConfig.provider)?.kind === 'mock') return null;
    return createHelperLlm(adapter, model);
  }
  /** 能看图的辅助模型（PPT 生成后看预览图检查排版）：按能力表“看图”那一项（设过的、默认模型自己能看、或自动挑的） */
  function visionHelperLlm() {
    return imageDescriber()?.describe ?? null;
  }
  /** 当前模型看不了图时，替它看图的模型：{ describe, label }；一个都没有时 null（见 router.visionRoute） */
  function imageDescriber() {
    const r = visionRoute(app.llmConfig);
    if (!r || providerById(app.llmConfig.provider)?.kind === 'mock') return null;
    const { adapter, model, problem } = createAdapter(r.cfg, { gateway: app.gateway });
    return problem ? null : { describe: createHelperLlm(adapter, model), label: model };
  }
  /** 文字识别（能力表“文字识别”，智谱 GLM-OCR）：没有就 null */
  function imageTextReader() {
    return ocrLine(app.llmConfig) ? (file, o) => recognizeText(app.llmConfig, file, { ...o, gateway: app.gateway }) : null;
  }
  /** 团队模式：按角色挑分工模型 */
  const ROLE_TASK = { coder: 'code', writer: 'write', researcher: 'reason', analyst: 'reason', operator: 'chat', generalist: 'chat' };
  function modelForRole(role) {
    const r = routeFor(app.llmConfig, ROLE_TASK[role] ?? 'chat');
    if (!r.routed) return null;
    const a = createAdapter(r.cfg, { gateway: app.gateway });
    return a.problem
      ? null
      : {
          adapter: a.adapter,
          model: a.model,
          fallbacks: fallbackRoutes(app.llmConfig, { provider: r.cfg.provider, model: a.model, task: ROLE_TASK[role] ?? 'chat' })
            .map((f) => ({ ...createAdapter(f.cfg, { gateway: app.gateway }), label: `${providerLabel(f.cfg, f.provider)} · ${f.model}` }))
            .filter((f) => !f.problem && f.adapter && f.model)
        };
  }
  function syncMemoryEngine() {
    const embedder = createEmbedder(app.llmConfig, { gateway: app.gateway, direct: MOBILE });
    agentMemory.configureMemory({ llm: helperLlm(), embedder });
    kb.configureKnowledge({ embedder });
    app.panels?.refreshKb?.();
  }

  return {
    serverCfg,
    server,
    detectGateway,
    friendlyError,
    updateModelLabels,
    metrics,
    fetchViaGateway,
    pushConfigToServer,
    refreshServerModel,
    helperLlm,
    visionHelperLlm,
    imageDescriber,
    imageTextReader,
    modelForRole,
    syncMemoryEngine
  };
}
