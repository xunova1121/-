import { checkpointEvent, checkpointNeedsReview } from '../shared/taskCheckpoint.js';
import { openQwenSession, QWEN_ASR } from './perception/qwenRealtime.js';
import { QwenVoice } from './perception/qwenVoice.js';
import {createHome} from './ui/home.js';
import {createWeatherClient} from './core/weather.js';
/**
 * 未央前端入口：状态管理层 + 渲染策略控制器。
 *
 *   感知（人脸 / VAD / 识别） ─┐
 *   智能体事件（agent.js）     ─┼─▶ EmotionMachine ─▶ ParamTween(400ms) ─┐
 *   注入事件（SSE）           ─┘                                        ├─▶ stage.frame()
 *   人脸角度 / 麦克风包络 / 播报包络 ─────────────────────────────────┘
 *
 * 主视觉默认是“光核”（发光能量球 + 会变形状的眼睛），可切换为全息胸像 / 线框胸像。
 * 情绪通过颜色、眼睛形状、轮廓光强度、光环转速与扫描速度表达。
 * 减少动画：在初始化 WebGL 之前判断，命中则根本不 import three.js、不下载网格。
 */
import { initWorkbench } from './ui/workbench.js';
import logoUrl from './ui/logo.svg';
import { initMascots } from './ui/mascot.js';
import { initCompanion } from './ui/companion.js';
import { initHologramCompanion } from './ui/hologramScene.js';
import { transcriptWindow } from './mobile/transcriptWindow.js';
import { initRenderHealthPanel } from './mobile/renderHealth.js';
import { initCompanionAppearance } from './ui/companionAppearance.js';
let companion = null;
import { imageButton, previewWorkspaceImage } from './ui/imagePreview.js';
import { initCamera } from './ui/composerMedia.js';
import { initConversationComposer } from './ui/conversationComposer.js';
let mascots = null;
let composer = null;
let dictating = false, dictationTimer = null, dictationGeneration = 0;
let callTiming = null;
let callActive = false;
let callStarting = false;
let callGeneration = 0;
let callRestore = null;
let voiceSwitching = false, callCloudFallback = false;

// 浏览器标签页图标：未央 logo（小图直接内联，单文件版也能显示）
document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: logoUrl }));
import './mobile/boot.js'; // 安卓 App：先装好原生网络 / 朗读（其他版本里是空的）
import { EmotionMachine } from './core/emotionMachine.js';
import { EMOTION_PARAMS, EYE_SHAPES } from './core/emotions.js';
import { ParamTween } from './core/tween.js';
import { followTarget, smoothToward } from './core/faceMath.js';
import { SentenceChunker } from './core/sentenceChunker.js';
import { toPlainText, toSpeech } from './core/markdown.js';
import { SILENCE_BY_SENSITIVITY } from './core/vadGate.js';
import { loadSettings, saveSettings, wantsReducedMotion } from './core/settings.js';
import { browserMetrics } from './api/browserMetrics.js';
import { runTeam, shouldTeam } from './agent/team.js';
import { runAgent } from './agent/agent.js';
import { STATUS_ASK, STOP_ASK, turnStatus } from './core/interject.js';
import { collectRequirements } from './agent/taskRequirements.js';
import { createTools } from './agent/tools.js';
import * as ws from './agent/workspace.js';
import * as agentMemory from './agent/memory.js';
import * as kb from './agent/knowledge.js';
import { createEmbedder } from './llm/embeddings.js';
import { initPanels } from './ui/panels.js';
import { loadConfig, saveConfig, createAdapter, displayName, providerById, resolveVoice, modelOf } from './llm/config.js';
import { initVoicePanel } from './ui/voicePanel.js';
import * as skillPacks from './agent/skillPacks.js';
import { initSkillsPanel } from './ui/skillsPanel.js';
import { initPalette } from './ui/palette.js';
import * as scheduler from './agent/scheduler.js';
import { executeScheduled, scheduledPrompt, notificationFor } from './agent/scheduledRun.js';
import { preApproved } from './agent/commandSafety.js';
import * as compress from './agent/compress.js';
import { storageProblem } from './agent/store.js';
import * as habits from './agent/habits.js';
import { initSchedulesPanel } from './ui/schedulesPanel.js';
import { prepareImage, isImageName } from './agent/images.js';
import * as sessionsApi from './agent/sessions.js';
import { initSessionsPanel } from './ui/sessionsPanel.js';
import { initCallouts } from './ui/callouts.js';
import { openingSuggestions, followUpSuggestions, INTERRUPTED_MARK } from './core/suggest.js';
import { savePending, clearPending, takePending, resumeText, listPending } from './core/pendingTask.js';
import { loadServerSettings, createServerClient, runRemote, remoteSessions, normalizeUrl } from './core/serverClient.js';
import { initServerPanel } from './ui/serverPanel.js';
import { initQuickPrompts } from './ui/quickPrompts.js';
import * as mcp from './agent/mcpClient.js';
import { createDesktopTools } from './agent/desktopTools.js';
import { initMcpPanel } from './ui/mcpPanel.js';
import { initLocalModelsPanel } from './ui/localModelsPanel.js';
import { initOrbitHud } from './ui/orbitHud.js';
import { initRoutingPanel } from './ui/routingPanel.js';
import { createSyncController } from './sync/controller.js';
import { initSyncPanel, describeResult } from './ui/syncPanel.js';
import { matchWake, WakeWindow } from './core/wakeWord.js';
import { playCue } from './perception/voiceFx.js';
import { MetricsPoller } from './api/metrics.js';
import { subscribeAgentEvents } from './api/agentEvents.js';
import { Dashboard } from './ui/dashboard.js';
import { Transcript, toolLabel, summarizeArgs, searchBrand, setActionIcon, copyText } from './ui/transcript.js';
import { stripEmotionTags } from '../shared/emotionTag.js';
import { noteAction } from './mobile/renderDiagnostics.js';
import { Speaker } from './perception/speaker.js';
import { VoiceInput, speechRecognitionSupported } from './perception/voiceInput.js';
import { resolveStt, transcribe, encodeWav, sttEngineById } from './perception/stt.js';
import { STANDALONE, MOBILE, VAD } from './config.js';
import { NativeVoice } from './mobile/nativeVoice.js';
import { createVoiceLifecycle } from './mobile/voiceLifecycle.js';
import { recordVoiceEvent, readVoiceEvents } from './mobile/voiceDiagnostics.js';
import { createTaskKeeper } from './mobile/backgroundTasks.js';
import { RecordedVoice } from './mobile/recordedVoice.js';
import { nativeWebFetch } from './mobile/nativeFetch.js';
import { initChips } from './ui/chips.js';
import { initDrawer } from './ui/drawer.js';
import { initModelPicker, chipLabel, isAuto, repairChatModel } from './ui/modelPicker.js';
import { generateImage } from './llm/images.js';
import { generateVideo } from './llm/videos.js';
import { createFormDirector } from './core/formDirector.js';
import { composeGreeting, GREET_GAP_MS } from './core/greeting.js';
import { classifyTask, routeFor, TASKS, seesImages, fallbackRoutes, effortFor, isSmallTalk, needsComputer } from './llm/router.js';
import { resolveTheme, toggled, THEMES } from './core/theme.js';
import { FORMS } from './render/formations.js';
import { resolveQuality } from './core/quality.js';
import { loadMemory, clearMemory } from './core/memoryStore.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const now = () => performance.now();

// ---------------------------------------------------------------- 设置
const settings = loadSettings();
function setSetting(key, value) {
  settings[key] = value;
  // 通话临时启用的朗读 / 唤醒词不覆盖用户保存的偏好。
  saveSettings(callRestore ? { ...settings, ...callRestore } : settings);
}

// ---------------------------------------------------------------- 设备分级
const lowEnd = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory ?? 8) < 4;
const isMobile = matchMedia('(pointer: coarse)').matches;
const reducedMql = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- 情绪
const tween = new ParamTween({ ...EMOTION_PARAMS.平静, ...EYE_SHAPES.平静 }, { duration: 400 });
const machine = new EmotionMachine({
  onChange: (emotion) => {
    tween.set({ ...EMOTION_PARAMS[emotion], ...EYE_SHAPES[emotion] }, now());
    document.documentElement.style.setProperty('--hue', String(EMOTION_PARAMS[emotion].hue));
    dashboard.setEmotion(emotion, EMOTION_PARAMS[emotion].hue);
    $('#hud-emotion').textContent = emotion;
    wp({ emotion });
  }
});
setInterval(() => machine.tick(), 100);

// ---------------------------------------------------------------- 实时量
const live = {
  pulse: 0, // 点击建议时光核闪一下（0..1，逐帧衰减）
  voiceListening: false, // VAD 确认用户在说话
  voiceEnergy: 0,
  face: null, // 跟随目标 { yaw, pitch }（度）
  yaw: 0,
  pitch: 0,
  breath: 0,
  speak: 0, // 语音输出包络（0..1）
  boundaryAt: 0, // 最近一次词边界事件时间
  glitch: 0,
  nextBlink: 2500, // 下一次眨眼的时间
  glance: { yaw: 0, pitch: 0 }, // 待机时随机张望的目标（度）
  nextGlance: 4000
};

// ---------------------------------------------------------------- 渲染策略
/** 手机 App：不放大舞台（不跑 WebGL 和舞台动画，省电、不卡），粒子缩成顶栏小球，工作进展进对话 */
const COMPACT = MOBILE;
document.body.classList.toggle('compact', COMPACT);
/** 舞台底色（与 styles.css 里 .stage 的中心颜色一致，画布边缘渐隐时才接得上） */
const STAGE_BG = 0x2b2f58;
let stage = null;
let stageLoading = null;
const DEG = Math.PI / 180;

/** 造型导演：粒子体按工作状态和语义自己变形（没有手动切换） */
const director = createFormDirector({
  setForm: (name) => {
    const el = document.querySelector('#hud-form');
    if (el) { el.textContent = FORMS[name]?.name ?? name; el.parentElement.classList.remove('flash'); void el.offsetWidth; el.parentElement.classList.add('flash'); }
    queueMicrotask(updateOrbitStatus);
    wp({ form: name, energy: ENERGY[machine.task] ?? 0, task: $('#hud-task')?.textContent });
    return stage ? stage.setForm(name) !== false || stage.form === name : true;
  }
});
let directorTick = 0;
/** 粒子体周围的轨道 HUD 与思考流（启动末尾创建） */
let orbit = null;

function frame(dt, t) {
  const p = tween.update(t);
  if (t - directorTick > 200) { directorTick = t; director.tick(); }
  stage?.setActivity({ audio: live.voiceListening ? Math.min(1, live.voiceEnergy * 1.5) : 0 });

  // 光环转速 / 扫描速度：情绪表的角速度；用户说话时放慢到 0.12（需求 6.3）
  const omega = live.voiceListening ? 0.12 : p.spin;

  // 人脸跟随：光核的眼睛在球面上滑向你；胸像只转头、肩膀不动（着色器按高度混合）。
  // 没有跟随目标时，每隔几秒随机看一眼别处，再回到正前方 —— 显得是“活的”
  if (t > live.nextGlance) {
    const look = Math.random() < 0.55;
    live.glance = look ? { yaw: (Math.random() - 0.5) * 24, pitch: (Math.random() - 0.5) * 12 } : { yaw: 0, pitch: 0 };
    live.nextGlance = t + (look ? 900 + Math.random() * 900 : 3000 + Math.random() * 4000);
  }
  const tgt = settings.faceFollow && live.face ? live.face : live.glance;
  live.yaw = smoothToward(live.yaw, tgt.yaw, 0.12, dt || 16.7);
  live.pitch = smoothToward(live.pitch, tgt.pitch, 0.12, dt || 16.7);

  // 输入：用户说话时胸像表面随麦克风包络起伏
  const breathTarget = live.voiceListening ? live.voiceEnergy * 1.6 : 0;
  live.breath += (breathTarget - live.breath) * 0.2;

  // 输出：播报时由词边界事件“敲”一下再衰减；语音包不发边界事件时用合成起伏兜底。
  // 输入驱动表面起伏，输出驱动轮廓光、眼睛与底座 —— 两者分开，一眼能看出是谁在说话
  let speakTarget = 0;
  const audioLevel = speaker.speaking ? speaker.level() : null;
  if (audioLevel !== null) {
    // 云端语音：由真实音量驱动
    speakTarget = 0.3 + 0.7 * audioLevel;
  } else if (speaker.speaking) {
    const since = t - live.boundaryAt;
    speakTarget = since < 600
      ? 0.45 + 0.55 * Math.exp(-since / 140)
      : 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(t / 95)) * (0.5 + 0.5 * Math.sin(t / 333));
  }
  speakTarget = Math.max(speakTarget, live.pulse);
  live.pulse *= 0.9;
  live.speak += (speakTarget - live.speak) * (speakTarget > live.speak ? 0.5 : 0.12);

  // 故障切片只在“警觉”时出现，平时画面保持稳定、柔和
  live.glitch += ((machine.state === '警觉' ? 0.3 : 0) - live.glitch) * 0.08;

  // 眨眼：每 3–6 秒一次，闭合约 150ms；偶尔连眨两下
  let blink = 1;
  const sinceBlink = t - live.nextBlink;
  if (sinceBlink > 0) {
    blink = Math.abs(sinceBlink - 75) / 75;
    if (sinceBlink > 150) {
      blink = 1;
      live.nextBlink = t + (Math.random() < 0.15 ? 220 : 3000 + Math.random() * 3000);
    }
  }

  return {
    hue: p.hue,
    glow: p.glow,
    spin: omega,
    scanSpeed: 0.05 + omega * 0.3,
    glitch: live.glitch,
    blink,
    eyeW: p.eyeW,
    eyeH: p.eyeH,
    eyeY: p.eyeY,
    happy: p.happy,
    calm: p.calm,
    yaw: live.yaw * DEG,
    pitch: live.pitch * DEG,
    breath: live.breath,
    speak: live.speak,
    motion: 1
  };
}

async function ensureStage() {
  if (COMPACT) return null;
  if (stage || stageLoading) return stageLoading;
  stageLoading = (async () => {
    try {
      const { createStage } = await import('./render/stage.js');
      if (wantsReducedMotion(settings, reducedMql)) return null; // 加载期间切换成了减少动画
      stage = createStage($('#stage'), {
        lowEnd,
        onContextChange: (s, ms) => console.info(`[stage] WebGL 上下文${s === 'lost' ? '丢失' : `已恢复（${Math.round(ms)}ms）`}`)
      });
      stage.setBackground(STAGE_BG); // 靛蓝显示屏：和界面的暮色同色系，粒子在上面最亮
      stage.onFrame(frame);
      stage.setForm(director.form);
      applyFpsCap();
      stage.setPaused('hidden', document.hidden);
      stage.setPaused('offscreen', !canvasVisible);
      body.classList.remove('no-webgl');
      return stage;
    } catch (err) {
      console.warn('[stage] WebGL 不可用，使用 CSS 背景：', err);
      body.classList.add('no-webgl');
      return null;
    } finally {
      stageLoading = null;
    }
  })();
  return stageLoading;
}

function disposeStage() {
  stage?.dispose();
  stage = null;
}

let quality = resolveQuality(settings.quality, { lowEnd, isMobile, focusView: settings.focusView });
function applyFpsCap() {
  quality = resolveQuality(settings.quality, { lowEnd, isMobile, focusView: settings.focusView, softwareRenderer: Boolean(stage?.stats.softwareRenderer) });
  stage?.setFpsCap(quality.fps);
  stage?.setQuality({ bloom: quality.bloom, stars: quality.stars });
  body.classList.toggle('eco', quality.tier === 'eco');
}

function applyMotionMode() {
  const reduced = wantsReducedMotion(settings, reducedMql);
  body.classList.toggle('reduced-motion', reduced);
  dashboard.setMotion(!reduced);
  if (reduced) disposeStage();
  else ensureStage();
  $('#motion-status').textContent = `系统偏好：${reducedMql.matches ? '减少动态效果' : '未开启'}；当前：${reduced ? '已停用持续动画，仅以颜色表达情绪' : '完整动画'}`;
}
reducedMql.addEventListener?.('change', applyMotionMode);

// 后台 / 视口外暂停（需求 9.2）
let canvasVisible = true;
new IntersectionObserver(([e]) => {
  canvasVisible = e.isIntersecting;
  stage?.setPaused('offscreen', !canvasVisible);
}).observe($('#stage-wrap'));

document.addEventListener('visibilitychange', () => {
  const hidden = document.hidden;
  stage?.setPaused('hidden', hidden);
  if (hidden) poller.stop();
  else if (!COMPACT) poller.start();
  face?.setPaused(hidden);
});

// ---------------------------------------------------------------- 仪表
const dashboard = new Dashboard($('#dashboard'), {
  onEmotionPick: (v) => applyEmotionOverride(v)
});
const poller = new MetricsPoller({
  onData: (m) => { dashboard.setMetrics(m); orbit?.setMetrics({ cpu: (m.cpu?.percent ?? 0) / 100, mem: (m.memory?.percent ?? 0) / 100 }); },
  onError: () => dashboard.setDisconnected()
});
if (!document.hidden && !COMPACT) poller.start(); // 手机上没有仪表盘

subscribeAgentEvents({ onEmotion: (state, ttl) => machine.inject(state, ttl ?? 5000) });

function applyEmotionOverride(v) {
  setSetting('emotionOverride', v);
  machine.setManual(v === 'auto' ? null : v);
  dashboard.setManualEmotion(v);
  $('#set-emotion').value = v;
}


// ---------------------------------------------------------------- 模型与网关
let gateway = null; // 完整版：{ origin, keys }；单文件版为 null
let llmConfig = loadConfig();

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
      if (h.serverMode && !serverCfg.token) setTimeout(() => { showPanel('settings'); const u = $('#server-url'); if (u && !u.value) u.value = location.origin; toast('这是你的未央服务器：请先在“服务器模式”里输入访问密码登录'); }, 800);
      const found = !gateway;
      gateway = { origin: local ? LOCAL_GATEWAY : location.origin, keys: h.gatewayKeys ?? [], cors: Boolean(h.cors), mcp: Boolean(h.mcp), ollama: Boolean(h.ollama) };
      if (local && found) toast('已连接本机网关：所有服务商和自定义接口都可以用了');
    } catch {
      gateway = null;
      // 单文件版：启动时页面忙可能超时，过几秒再试两次
      if (local && !MOBILE && (detectGateway.retries = (detectGateway.retries ?? 0) + 1) <= 2) setTimeout(() => detectGateway(), 3000);
    }
    panels.refreshModels();
    voicePanel.render();
    mcpPanel.refresh();
    localModels.refresh();
    syncMemoryEngine();
    updateModelLabels();
  })().finally(() => { probing = null; });
  return probing;
}
// 单文件版：回到页面时再找一次网关（用户可能刚双击了 启动.bat）
if ((STANDALONE && !MOBILE) || location.protocol === 'file:') {
  let last = 0;
  addEventListener('focus', () => { if (!gateway && Date.now() - last > 5000) { last = Date.now(); detectGateway(); } });
}

/** 常见的服务商错误翻译成人话（已经自动重试过仍失败才会走到这里） */
function friendlyError(msg) {
  const code = Number(msg.match(/模型接口返回 (\d{3})/)?.[1]);
  if (code === 524 || code === 504 || code === 522) return `中转站等模型回复超时（${code}），已自动重试过。可以点“继续”从断开的地方接着写，或在输入框里换一个更快的模型`;
  if (code === 429) return '请求太频繁或额度用完（429），已自动重试过。稍等一会儿再试，或检查中转站余额';
  if (code === 401 || code === 403) return `API Key 不对或没有权限（${code}）：请在“模型”里检查密钥`;
  if (code >= 500) return `服务商临时故障（${code}），已自动重试过。稍后再试，或换一个模型`;
  if (/图片模型|image model|images\/generations/i.test(msg)) return '当前选的是画图模型，不能用来聊天：点输入框里的模型名换一个聊天模型。想画图直接说“画一张…”就行';
  if (/connection reset|econnreset|socket hang up/i.test(msg)) return '网络连接被断开（已自动重试过）。可以点“继续”从断开的地方接着写；手机上可以试试切换 Wi‑Fi / 流量';
  return msg;
}

function updateModelLabels() {
  const name = displayName(llmConfig);
  $('#mode-text').textContent = name;
  // 输入框里显示型号（或“自动”），点一下弹出模型列表
  $('#model-chip-text').textContent = COMPACT && isAuto(llmConfig) ? `自动 · ${modelOf(llmConfig) || '选择模型'}` : chipLabel(llmConfig);
  if (globalThis.__jarvisServerMode) $('#model-chip-text').textContent = globalThis.__jarvisServerModel ? `服务器 · ${globalThis.__jarvisServerModel}` : '服务器'; // 服务器模式：用服务器上的模型设置
  if (isAuto(llmConfig)) $('#mode-text').textContent = `${name} · 自动选模型`;
  $('#mode-pill').title = `当前模型：${name}${gateway ? '（经本机网关）' : ''}。点击切换`;
  $('#hud-model').textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

const metrics = () => (gateway ? fetch(`${gateway.origin}/api/local/metrics`).then((r) => r.json()) : browserMetrics());
// 网页读取只对完整版开放（单文件版跨域连网关时网关不提供 /api/fetch）
// 安卓 App 没有本机网关，但系统原生网络没有跨域限制：直接用它搜索、读网页
const fetchViaGateway = () => (gateway && !gateway.cors
  ? (url, init) => (url.startsWith('https://api.tavily.com/')
    ? fetch(`/api/llm/tavily/${url.slice('https://api.tavily.com/'.length)}`, init)
    : url.startsWith('https://api.bochaai.com/')
      ? fetch(`/api/llm/bocha/${url.slice('https://api.bochaai.com/'.length)}`, init)
      : fetch(`/api/fetch?url=${encodeURIComponent(url)}`))
  : globalThis.__jarvisNativeFetch ? nativeWebFetch(globalThis.__jarvisNativeFetch) : null);

// ---------------------------------------------------------------- 对话
const transcript = new Transcript($('#transcript'), { progress: COMPACT });
const storage = (() => { try { return localStorage; } catch { return null; } })();
// 服务器模式（设置 → 服务器模式）：任务交给自己的云服务器做，对话也存在服务器上
const serverCfg = loadServerSettings(storage);
const server = serverCfg.enabled && serverCfg.url && serverCfg.token ? createServerClient({ base: serverCfg.url, token: serverCfg.token }) : null;
if (server) {
  // 手机 App：连自己的服务器直接走系统原生网络（不先试 WebView、没有跨域预检，国内移动网络下快得多）
  try { globalThis.__jarvisPreferNative?.(new URL(server.base).host); } catch { /* 网址不对就算了 */ }
  sessionsApi.useRemote(remoteSessions(server)); globalThis.__jarvisServerMode = true; globalThis.__jarvisServerClient = server; updateModelLabels(); refreshServerModel();
}
/** 服务器模式：输入框里显示服务器上设的模型 */
/** 服务器模式下换了模型（或改了密钥、分工）：自动传到服务器，任务马上用新设置。语音设置留在本机 */
let pushTimer = 0;
function pushConfigToServer() {
  if (!server) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const { voice, stt, ...models } = llmConfig;
      await server.putConfig(models);
      refreshServerModel();
      toast(`已同步到服务器：${modelOf(models) || '模型设置'}`);
    } catch (e) { toast(`模型设置没能同步到服务器：${e.message}`); }
  }, 800);
}
function refreshServerModel() {
  server?.getConfig().then((c) => { globalThis.__jarvisServerModel = modelOf(c) || ''; updateModelLabels(); }).catch(() => {});
}
// 页面就是从自己的服务器打开的：发给它的请求（模型转发、读网页等）都带上登录令牌
if (serverCfg.token && typeof location !== 'undefined' && normalizeUrl(serverCfg.url) === location.origin) {
  const plain = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!/^\/api\//.test(url) && !url.startsWith(`${location.origin}/api/`)) return plain(input, init);
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${serverCfg.token}`);
    return plain(input, { ...init, headers });
  };
}
// 当前会话；history 指向它的消息列表（切换会话时一起换掉）
let session = sessionsApi.create();
let history = session.messages;
/** 记一条消息：默认记进当前会话；后台任务记进它自己的会话（切到别的对话后仍然记对地方） */
function rememberTurn(role, content, extra = {}, target = session) {
  target.messages.push({ role, content, ts: Date.now(), ...extra });
  target.updatedAt = Date.now();
  persistSession(target);
}
function persistSession(target = session) {
  if (settings.saveSessions === false) return;
  return sessionsApi.save(target).then(() => { sessionsPanel?.refresh(); if (target === session) showChatTitle(); }).catch(() => {});
}
/** 手机顶栏显示当前对话的标题（还没说话的新对话不显示） */
function showChatTitle() {
  const el = $('#chat-title');
  const first = history.find((m) => m.role === 'user')?.content;
  const title = session.title || (first ? sessionsApi.autoTitle(first) : '');
  el.textContent = title;
  el.hidden = !title;
}
$('#chat-title').addEventListener('click', async () => {
  const now = $('#chat-title').textContent;
  let next = null;
  try { next = globalThis.prompt('给这段对话起个名字', now); } catch { /* 不支持弹窗 */ }
  next = String(next ?? '').trim().slice(0, 60);
  if (!next || next === now) return;
  session.title = next;
  session.titleSet = true;
  await sessionsApi.rename(session.id, next).catch(() => {});
  showChatTitle();
  sessionsPanel?.refresh();
  drawer?.refresh?.();
});
let turns = 0;
const recentImages = new Map(); // 消息时间 → 这条消息带的图片（只在内存里，不存盘）
const taskKeeper = createTaskKeeper(globalThis.__jarvisBackgroundTask, e => toast(e.message));
let active = null; // { ctrl, streamDone, bubble }
const attachments = [];

const speaker = new Speaker({
  onAudioScheduled: ({engine,delayMs}) => {
    if(callActive&&callTiming?.recognizedAt&&!callTiming.audioAt){callTiming.audioAt=now()+delayMs;recordVoiceEvent('通话分段耗时',JSON.stringify({engine,recognitionMs:callTiming.stoppedAt?Math.round(callTiming.recognizedAt-callTiming.stoppedAt):null,modelFirstTextMs:callTiming.firstTextAt?Math.round(callTiming.firstTextAt-callTiming.recognizedAt):null,audioScheduledMs:Math.round(callTiming.audioAt-callTiming.recognizedAt)}));}
  },
  onStart: () => {
    if (callActive) callStatus('未央正在说话…');
    voice.setSuppressed(true);
    body.classList.add('speaking');
  },
  onIdle: () => {
    if (callActive) callStatus('直接说话，未央在听');
    if (wake.awake) wake.wake(); // 回答说完后重新计时，方便接着问
    voice.setSuppressed(false);
    body.classList.remove('speaking');
    if (active?.streamDone) finishTurn();
  },
  onBoundary: () => { live.boundaryAt = now(); },
  onError: (e) => toast(resolveVoice(llmConfig,gateway).engine === 'qwen-realtime' ? `${e.message}（所选百炼声音未播放，请检查声音设置）` : `${e.message}（先用系统自带声音朗读，5 分钟后再试）`),
  getVoiceConfig: () => resolveVoice(llmConfig, gateway),
  getKeys: () => llmConfig.keys,
  getConfig: () => llmConfig,
  onEngine: (engine,fallback) => { const el = document.querySelector("#tts-status"); if (el) el.textContent = fallback ? "当前已回退系统声音（不是目标女孩童声），请检测语音服务" : `实际播放引擎：${engine}`; if (fallback && callActive) callStatus("在线声音失败，当前为系统声；请检测声音服务"); },
  getGateway: () => gateway
});
// 念不念由每一轮自己决定（见 makeSpeech）：语音对话、说话提问时念，打字提问默认不念
speaker.enabled = true;

/** 打断（barge-in）：停止朗读并中止正在执行的任务 */
function interrupt() {
  const had = speaker.speaking || active;
  if (active) callouts?.show();
  if (active) {
    active.ctrl.abort();
    active.bubble?.done('已打断');
    active = null;
    setTask('idle');
  }
  speaker.cancel();
  return Boolean(had);
}
$('#btn-stop').addEventListener('click', () => interrupt());

const TASK_LABEL = { idle: '待命', listening: '生成中', processing: '执行中', error: '出错', done: '完成' };
const DIRECTOR_STATE = { processing: 'processing', listening: 'speaking', done: 'speaking', idle: 'idle', error: 'error' };
const ENERGY = { processing: 0.85, listening: 0.25 };
function setTask(state, sub = '') {
  mascots?.task(state, sub);
  active?.bubble?.activity(state, sub);
  machine.setTaskState(state === 'listening' && !live.voiceListening ? 'listening' : state);
  if (DIRECTOR_STATE[state]) director.setState(DIRECTOR_STATE[state]);
  stage?.setActivity({ energy: ENERGY[state] ?? 0 });
  dashboard.setTask(state, sub);
  const label = sub || TASK_LABEL[state] || state;
  $('#hud-task').textContent = label;
  $('#task-text').textContent = label;
  body.classList.toggle('generating', Boolean(active) && state !== 'done' && state !== 'error' && state !== 'idle');
  $('#mode-pill').classList.toggle('busy', Boolean(active) && state !== 'done');
}

/** 手机：记下“正在做什么”（界面崩溃时下次打开能看到崩溃前在做什么） */
function markActivity(what) {
  if (!MOBILE) return;
  try { localStorage.setItem('jarvis.lastActivity', what ? `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${what}` : ''); } catch { /* 存不了就算了 */ }
}

function finishTurn() {
  markActivity('');
  if (!active) return;
  active = null;
  turns++;
  dashboard.setTurns(turns);
  setTask('done');
  setTimeout(() => { if (!active) setTask('idle'); }, 3000);
  panels.refreshMind();
}

/** 朗读只读正文：代码块（``` 包围的部分，包括还没闭合的）不读。auto 为 false（打字提问）时不念 */
function makeSpeech(auto = true) {
  if (!auto) return { push() {}, flush() {}, resume() {} };
  let chunker = new SentenceChunker({ maxLen:callActive ? 24 : 60 });
  let full = '';
  let fed = 0, speechGeneration = speaker.gen;
  const speechTurn = active;
  return {
    resume() { if (speechTurn) speechTurn.muteSpeech = false; full = ''; fed = 0; chunker = new SentenceChunker({maxLen:callActive ? 24 : 60}); speechGeneration = speaker.gen; },
    push(delta) {
      if (speechTurn?.muteSpeech) return;
      full += delta;
      const spoken = full.replace(/```[\s\S]*?```/g, '\n').replace(/```[\s\S]*$/, '');
      if (!speaker.foreground || speechGeneration !== speaker.gen) { chunker = new SentenceChunker({ maxLen:callActive ? 24 : 60 }); speechGeneration = speaker.gen; if (!speaker.foreground) { fed = spoken.length; return; } }
      if (spoken.length > fed) {
        for (const s of chunker.push(spoken.slice(fed))) speaker.speak(s.replace(/[*#`|>]/g, ''));
        fed = spoken.length;
      }
    },
    flush() { if (speechTurn?.muteSpeech || !speaker.foreground || speechGeneration !== speaker.gen) return; for (const s of chunker.flush()) speaker.speak(s.replace(/[*#`|>]/g, '')); }
  };
}

// ---------------------------------------------------------------- 记忆引擎：整理用的大模型 + 语义向量，随配置变化
/** 给记忆整理、深度调研等内部环节用的“单次问答”；内置演示或配置不全时返回 null。task 决定用哪个分工模型 */
function helperLlm(task = 'chat') {
  const { adapter, model, problem } = createAdapter(routeFor(llmConfig, task).cfg, { gateway });
  if (problem || providerById(llmConfig.provider)?.kind === 'mock') return null;
  return async ({ system, prompt, signal, images }) => {
    let text = '';
    const r = await adapter.stream({ model, system: [system], messages: [{ role: 'user', content: prompt, ...(images?.length && { images }) }], tools: [], signal, onText: (d) => { text += d; } });
    return r?.text || text;
  };
}
/** 能看图的辅助模型（PPT 生成后看预览图检查排版）：分工里设了“看图”模型就用它，否则默认模型能看图才用 */
function visionHelperLlm() {
  const r = routeFor(llmConfig, 'vision');
  return r.routed || seesImages(r.model) ? helperLlm('vision') : null;
}
/** 团队模式：按角色挑分工模型 */
const ROLE_TASK = { coder: 'code', writer: 'write', researcher: 'reason', analyst: 'reason', operator: 'chat', generalist: 'chat' };
function modelForRole(role) {
  const r = routeFor(llmConfig, ROLE_TASK[role] ?? 'chat');
  if (!r.routed) return null;
  const a = createAdapter(r.cfg, { gateway });
  return a.problem ? null : { adapter:a.adapter, model:a.model, fallbacks:fallbackRoutes(llmConfig,{provider:r.cfg.provider,model:a.model}).map(f=>({...createAdapter(f.cfg,{gateway}),label:f.model})).filter(f=>!f.problem&&f.adapter&&f.model) };
}
function syncMemoryEngine() {
  const embedder = createEmbedder(llmConfig, { gateway });
  agentMemory.configureMemory({ llm: helperLlm(), embedder });
  kb.configureKnowledge({ embedder });
  panels?.refreshKb?.();
}

/** 自动整理记忆：对话停下来 30 秒后、切到别的对话或 App 退到后台时，把这段对话交给记忆整理（抽取事实、写摘要）。
 *  不能等太久：用户常常说完就开新对话，或者手机直接切走 */
let reflectFrom = history.length;
let reflectTimer = 0;
function scheduleReflect() {
  if (server) return; // 服务器模式：记忆在服务器上，本机不整理
  clearTimeout(reflectTimer);
  if (!settings.autoMemory) return;
  reflectTimer = setTimeout(reflectNow, 30_000);
}
async function reflectNow({ manual = false } = {}) {
  clearTimeout(reflectTimer);
  const turns = history.slice(reflectFrom);
  if (!turns.some((t) => t.role === 'user')) { if (manual) toast('没有新的对话需要整理'); return; }
  reflectFrom = history.length;
  try {
    const title = session.titleSet ? session.title : sessionsApi.autoTitle(history.find((m) => m.role === 'user')?.content);
    const r = await agentMemory.reflect(turns, { session: { id: session.id, title } });
    const n = r.memories.filter((m) => m.action !== 'NOOP').length;
    if (n || manual) toast(`记忆已整理：新增或更新 ${n} 条${r.episode ? '，并记下这段对话的摘要' : ''}`);
    panels.refreshMind();
  } catch (e) { console.warn('[memory] 整理失败', e); }
}
addEventListener('pagehide', () => { if (settings.autoMemory) reflectNow(); });
// 手机切到后台时不一定有 pagehide（之后可能被系统直接杀掉）：页面一隐藏就整理
document.addEventListener('visibilitychange', () => { if (document.hidden && settings.autoMemory && !active) reflectNow(); });

/** 长对话压缩：回答完后在后台把较早的消息并进“前情提要”（见 compress.js），不影响当前对话 */
let compressing = false;
async function compressHistory() {
  if (server) return;
  const s = session;
  if (compressing || !compress.dueForCompression(s.messages, s.summary).length) return;
  compressing = true;
  try {
    const next = await compress.updateSummary(s.messages, s.summary, { llm: helperLlm() });
    if (next && next !== s.summary) {
      s.summary = next;
      if (settings.saveSessions !== false) sessionsApi.save(s).catch(() => {});
      hud.think(`◆ 较早的对话已压缩成摘要${next.by === 'rule' ? '（本地规则）' : ''}`);
    }
  } catch (e) { console.warn('[compress]', e); } finally { compressing = false; }
}

// ---------------------------------------------------------------- 多会话
/** 把当前会话的消息重新画到对话区 */
let historyViewEnd = null;
function visibleHistory(end = history.length) {
  return transcriptWindow(history.length, { mobile: MOBILE, safe: document.documentElement.classList.contains('safe-render'), end });
}
function replayTranscript(end = history.length) {
  showChatTitle();
  const root = $('#transcript'), range = visibleHistory(end);
  historyViewEnd = range.newer ? range.end : null;
  root.replaceChildren();
  transcript.follow = true;
  document.body.classList.remove('wy-reading-history');
  if (!history.length) { renderWelcome(); return; }
  transcript.batch(() => {
    if (range.older || range.newer) {
      const nav = Object.assign(document.createElement('nav'), { className: 'wy-history-pages' });
      nav.setAttribute('aria-label', '对话翻页');
      const pageButton = (label, target) => {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        button.onclick = () => {
          if (active) { toast('当前回复完成后，可以翻看更早的对话'); return; }
          replayTranscript(target);
        };
        nav.append(button);
      };
      if (range.older) pageButton(`查看更早的对话（还有 ${range.older} 条）`, range.start);
      if (range.newer) {
        pageButton('下一页', Math.min(history.length, range.end + range.limit));
        pageButton('回到最近对话', history.length);
      }
      root.append(nav);
    }
    // 翻看旧消息：很长的回答（除了最后一条）先只显示开头，点“展开全文”再显示，手机上少画很多内容
    const shown = history.slice(range.start, range.end);
    const lastAgent = shown.findLastIndex((m) => m.role !== 'user');
    shown.forEach((m, i) => {
      if (m.role === 'user') transcript.add('user', m.content, m.ts, { thumbs: m.thumbs });
      else {
        const b = transcript.add('agent', '', m.ts);
        b.append(m.content);
        for (const f of m.files || []) b.fileLink(f, openInWorkspace);
        b.done(m.tools?.length ? `用了：${m.tools.map(toolLabel).join('、')}` : '', { fold: i !== lastAgent });
      }
    });
  });
}
/** 新对话的开场建议：之前没做完的事 > 上一段对话 */
async function resumeSuggestion() {
  try {
    const [open] = await agentMemory.openItems({ exclude: session.id, k: 1 });
    if (open) return { title: `继续：${open.text.slice(0, 18)}`, prompt: `接着之前说的：${open.text}` };
    const [last] = await sessionsApi.recent({ exclude: session.id, k: 1 });
    if (last && Date.now() - last.updatedAt < 3 * 86400000) return { title: `接着上次：${last.title.slice(0, 16)}`, prompt: `接着上次「${last.title}」的对话继续` };
  } catch { /* 没有历史 */ }
  return null;
}
async function openingCallouts(hasSkills = true) {
  callouts?.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills, resume: await resumeSuggestion() }));
}

async function switchTo(next) {
  // 正在干活：不停下，转到后台接着做（做完记回原来的对话）；只是在朗读就停掉
  if (active && !active.streamDone) toBackground(active); else interrupt();
  if (settings.autoMemory) await reflectNow();
  session = next;
  history = session.messages;
  reflectFrom = history.length;
  replayTranscript();
  // 切回一个还在后台干活的对话：把正在写的那条回答接回来
  const bg = [...backgroundTurns].find((t) => t.session.id === session.id);
  if (bg) { backgroundTurns.delete(bg); bg.background = false; active = bg; liveBubble = bg.bubble; transcript.root.append(bg.bubble.el); setTask('processing', bg.status || '思考中'); }
  else if (server && next.taskId) followServerTask(next); // 服务器上这个对话还在干活（比如 App 重新打开）：接上它的进度
  dashboard.setTurns(history.filter((m) => m.role === 'user').length);
  if (history.length) callouts?.set(followUpSuggestions({ tools: history.at(-1)?.tools ?? [], userText: [...history].reverse().find((m) => m.role === 'user')?.content ?? '', desktop: Boolean(DESKTOP) }));
  else openingCallouts();
  sessionsPanel?.refresh();
  setTask('idle');
}
function newSession() {
  if (!history.length) { $('#prompt').focus(); return; }
  switchTo(sessionsApi.create());
  $('#prompt').focus();
}
addEventListener('jarvis:open-session', (e) => { openSession(e.detail).then(() => showPanel('sessions')); });
/** 手机：第一次交任务时问一次能不能发“做完了”的通知（之后不再问） */
let askedNotify = false;
function askNotifyOnce() {
  if (!MOBILE || askedNotify) return;
  askedNotify = true;
  try { if (localStorage.getItem('jarvis.askedNotify')) return; localStorage.setItem('jarvis.askedNotify', '1'); } catch { /* 存不了也只问这一次 */ }
  globalThis.__jarvisBackgroundTask?.askNotify?.().catch(() => {});
}
let opening = 0; // 连点了好几段对话：只认最后点的那段
async function openSession(id) {
  noteAction('切换对话');
  // 点的就是当前对话：服务器模式下从服务器取一次最新进度（另一台设备可能接着聊过）
  if (id === session.id) { if (server) refreshFromServer(); return; }
  const mine = ++opening;
  // 服务器模式：先用手机 / 电脑上留的副本马上切过去，再从服务器取最新的换上
  const cached = server ? sessionsApi.cachedGet(id) : null;
  if (cached) await switchTo(cached);
  else if (server) setTask('processing', '正在打开对话');
  const s = await sessionsApi.get(id).catch((e) => { if (!cached) toast(`打不开这段对话：${e.message}`); return null; });
  if (mine !== opening) return;
  if (!s) { if (!cached) setTask('idle'); return; }
  if (!cached) await switchTo(s);
  else if (session.id === id && !active && changed(session, s)) { session = s; history = s.messages; reflectFrom = history.length; replayTranscript(); }
  if (server && session.id === id && s.taskId && !active) followServerTask(s); // 另一台设备正在做：接上进度
}
/** 服务器上的这段对话比手上的新吗（另一台设备接着聊过、或者做完了任务） */
const changed = (a, b) => b.messages.length !== a.messages.length || (b.updatedAt ?? 0) > (a.updatedAt ?? 0) || b.messages.at(-1)?.content !== a.messages.at(-1)?.content;
/** 服务器模式：从服务器取当前对话的最新进度，有变化就换上（App 切回前台、点当前对话时） */
let refreshing = false;
async function refreshFromServer() {
  if (!server || refreshing || active || !session?.id) return;
  noteAction('从服务器刷新对话');
  refreshing = true;
  try {
    const id = session.id;
    const s = await sessionsApi.get(id).catch(() => null);
    if (!s || session.id !== id || active) return;
    if (changed(session, s)) { session = s; history = s.messages; reflectFrom = history.length; replayTranscript(); }
    if (s.taskId) followServerTask(s);
    try { drawer?.refresh?.(); } catch { /* 抽屉还没建好 */ }
  } finally { refreshing = false; }
}
// App 从后台切回来 / 电脑窗口重新获得焦点：拉一次最新进度（两台设备轮着用时不会对不上）
let lastPull = 0;
const pullSoon = () => { if (Date.now() - lastPull < 3000) return; lastPull = Date.now(); refreshFromServer(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullSoon(); });
addEventListener('focus', pullSoon);

/** 光核旁的建议标注（启动末尾创建） */
let callouts = null;
let stageMiniWas = false; // 舞台上一次是不是迷你状态（updateStageMode 用）
/** 正在回答的气泡（画图工具把图片放进去） */
let liveBubble = null;
/** 桌面背景同步：主窗口在做什么，桌面上的粒子体就跟着做（桌面版开了背景模式时） */
function wp(payload) { if (window.jarvisDesktop) window.jarvisDesktop.invoke('wallpaperEvent', payload).catch(() => {}); }
const hud = {
  think(text, kind) { orbit?.think(text, kind); wp({ think: text }); },
  toolStart(id, label) { orbit?.toolStart(id, label); wp({ tool: { id, label } }); },
  toolEnd(id, ok) { orbit?.toolEnd(id, ok); wp({ toolDone: { id, ok } }); },
  newTurn() { orbit?.newTurn(); wp({ newTurn: true }); }
};
function updateOrbitStatus() {
  orbit?.setStatus(`${(FORMS[director.form]?.id ?? director.form).toUpperCase()} · LINK ${window.jarvisDesktop ? 'DESKTOP' : gateway ? 'GATEWAY' : 'LOCAL'}`);
}
let sessionsPanel = null;
let schedulesPanel = null;

// ---------------------------------------------------------------- 桌面版与 MCP
/** 桌面版（Electron）由 preload 注入；网页版为 undefined */
const DESKTOP = window.jarvisDesktop;
/** 本次会话里用户选了“本次都允许”的操作类别 */
const sessionApprovals = new Set();
/** 电脑操作（鼠标键盘）进行中：一轮结束或被打断时把未央窗口放回来 */
let controlActive = false;
function endControl() {
  if (!controlActive) return;
  controlActive = false;
  DESKTOP?.invoke('controlEnd').catch(() => {});
}
if (DESKTOP) {
  body.classList.add('desktop', `os-${DESKTOP.platform}`);
  // 全局快捷键呼出：聚焦输入框
  DESKTOP.onSummon?.(() => { $('#prompt').focus(); });
  // 离开电脑一段时间后回来：主动问好
  DESKTOP.onPresence?.((info) => { greetOnReturn(info); });
  // 紧急停止热键：打断当前任务
  DESKTOP.onStop?.(() => { controlActive = false; interrupt(); toast('已紧急停止电脑操作'); });
}
let mcpState = { available: false, servers: [] };
async function refreshMcp() {
  if (!gateway?.mcp) { mcpState = { available: false, servers: [] }; return mcpState; }
  try { mcpState = await mcp.listServers(gateway.origin); } catch { mcpState = { available: false, servers: [] }; }
  return mcpState;
}
async function loadMcpTools() {
  if (!gateway?.mcp) return [];
  await refreshMcp();
  return mcp.mcpTools(gateway.origin, mcpState.servers);
}

/** 对话里点生成的文件：切到工作区并打开它 */
/** 导出一段对话：复制全部内容，或存成 Word / Markdown 放进工作区“导出”文件夹（在工作区里能下载、分享） */
async function exportSession(id, kind) {
  const s = id === session.id ? session : await sessionsApi.get(id).catch(() => null) ?? sessionsApi.cachedGet(id);
  if (!s?.messages?.length) { toast('这段对话还没有内容'); return; }
  const title = s.title || '对话';
  const said = (m) => stripEmotionTags(String(m.content)).replace(/\n*\[已上传到工作区：[^\]]+\]$/, '').trim();
  const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');
  const md = `# ${title}\n\n${s.messages.map((m) => `### ${m.role === 'user' ? '我' : '未央'}${m.ts ? `　${when(m.ts)}` : ''}\n\n${said(m)}`).join('\n\n')}\n`;
  if (kind === 'copy') { toast((await copyText(toPlainText(md))) ? '整段对话已复制' : '复制失败'); return; }
  const name = title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '对话';
  try {
    let path;
    if (kind === 'md') path = (await ws.write(`导出/${name}.md`, md)).path;
    else {
      const { generate } = await import('./agent/docs.js');
      const out = await generate('docx', { title, content: md.replace(/^# .*\n/, '') });
      path = (await ws.write(`导出/${name}.${out.ext}`, out.blob)).path;
    }
    panels.refreshFiles();
    toast(`已导出到工作区：${path}`);
    openInWorkspace(path);
  } catch (e) { toast(`导出没成功：${e.message}`); }
}
function openInWorkspace(path) {
  showPanel('workspace');
  panels.openFile(path);
}

/** 智能体可用的全部工具：基础工具 + 桌面版电脑操作 + MCP 工具 */
async function buildTools({ background = false, turn = null } = {}) {
  // 生成的文件、图片只挂到产生它的那一轮（turn）：中途切到别的对话，也不会跑到别的对话里
  const out = () => turn?.bubble ?? liveBubble;
  const onFileChanged = (path) => {
    panels.markFresh(path);
    panels.refreshFiles();
    if (!background && !/^skills\//.test(path)) { out()?.fileLink?.(path, openInWorkspace); turn?.files.add(path); }
  };
  return [
    ...createTools({
      metrics,
      tavilyKey: llmConfig.tavilyKey,
      bochaKey: llmConfig.bochaKey,
      searchRegion: llmConfig.searchRegion || 'auto',
      fetchViaGateway: fetchViaGateway(),
      llm: helperLlm('write'), // 深度调研：用写作模型
      reasonLlm: helperLlm('reason'), // 逐项查证：用推理模型摘答案
      visionLlm: visionHelperLlm(), // PPT 生成后看预览图检查排版
      onPreview: background ? () => {} : COMPACT
        ? (path) => { panels.openFile(path); toast(`已生成 ${path}：左上角菜单 → 工作区查看`); } // 手机上不自动盖住对话
        : (path) => { showPanel('workspace'); panels.openFile(path); },
      onFileChanged,
      imageGen: (o) => generateImage(llmConfig, { ...o, gateway }),
      onImage: (src) => out()?.image?.(src),
      videoGen: (o) => generateVideo(llmConfig, { ...o, gateway }),
      onVideo: (src) => out()?.video?.(src),
      onSchedulesChanged: () => schedulesPanel?.refresh(),
      currentSessionId: () => session?.id,
      // 桌面版：写 PDF 时直接转成 PDF 文件（网页版和安卓生成可打印的网页）
      toPdf: DESKTOP ? async (html) => Uint8Array.from(atob((await DESKTOP.invoke('printToPdf', { html })).base64), (c) => c.charCodeAt(0)) : null
    }),
    ...(DESKTOP ? createDesktopTools(DESKTOP, { onFileChanged, onControlStart: (r) => { controlActive = true; if (!background) toast(`正在操作电脑：鼠标甩到屏幕左上角或按 ${r?.stopHotkey ?? 'Ctrl+Alt+Q'} 可紧急停止`); } }) : []),
    ...(await loadMcpTools())
  ];
}

/** 服务器模式：打开一个服务器上还在干活的对话，从头补上它的进度，做完后换成服务器记下的完整对话 */
async function followServerTask(s) {
  const ctrl = new AbortController();
  const bubble = transcript.add('agent');
  bubble.el.classList.add('streaming');
  const turn = { ctrl, streamDone: false, bubble, session: s, files: new Set(), inbox: [], t0: now(), steps: 0, status: '', background: false, remote:Boolean(server) };
  active = turn;
  liveBubble = bubble;
  setTask('processing', '服务器上正在做');
  const cards = new Map();
  try {
    await runRemote(server, {
      taskId: s.taskId, onStarted:task=>{turn.remoteId=task.id;}, signal: ctrl.signal, onFile: (p) => pullServerFile(p, turn),
      emit: (e) => {
        if (active !== turn) return;
        if (e.type === 'text') bubble.append(e.delta);
        else if (e.type === 'plan') bubble.plan?.(e.steps);
        else if (e.type === 'tool_start' && e.name !== 'update_plan') { cards.set(e.id, bubble.toolCard(e.name, e.args)); turn.steps++; setTask('processing', toolLabel(e.name)); }
        else if (e.type === 'tool_progress') cards.get(e.id)?.progress(e.text);
        else if (e.type === 'tool_end') cards.get(e.id)?.done(e.ok, e.output, e.ms);
      }
    });
  } catch (e) {
    if (e.name !== 'AbortError' && active === turn) toast(e.message);
  }
  if (active === turn) { active = null; setTask('idle'); }
  // 换成服务器上记下的完整对话（回答、用到的工具、生成的文件）
  const fresh = await sessionsApi.get(s.id).catch(() => null);
  if (fresh && session.id === s.id && !active) { session = fresh; history = fresh.messages; replayTranscript(); }
}

/** 服务器模式：服务器上生成了文件，下载到本机工作区，照常预览、保存 */
async function pullServerFile(path, turn) {
  if (turn?.files.has(path)) return; // 同一轮里同一个文件只取一次（画图会同时报“新文件”和“显示图片”）
  turn?.files.add(path);
  try {
    const blob = await server.download(path);
    await ws.write(path, blob);
    panels.markFresh(path);
    panels.refreshFiles();
    const out = turn?.bubble ?? liveBubble;
    // 服务器画的图、做的视频：和本机一样直接显示在回答里
    if (/^images\/.+\.(png|jpe?g|webp|gif)$/i.test(path)) out?.image?.(URL.createObjectURL(blob));
    else if (/^videos\/.+\.(mp4|webm|mov)$/i.test(path)) out?.video?.(URL.createObjectURL(blob));
    if (!/^skills\//.test(path)) { out?.fileLink?.(path, openInWorkspace); turn?.files.add(path); }
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- 主动问好：你回到电脑前时
let lastGreetAt = (() => { try { return Number(localStorage.getItem('jarvis.lastGreet')) || 0; } catch { return 0; } })();
/**
 * @param {{ awayMs: number, reason?: string, force?: boolean }} info
 * @returns {Promise<string|null>} 说了什么（没说返回 null）
 */
async function greetOnReturn({ awayMs, reason = '', force = false }) {
  if (!force && (!settings.greetOnReturn || active || Date.now() - lastGreetAt < GREET_GAP_MS || awayMs < 10 * 60_000)) return null;
  lastGreetAt = Date.now();
  try { localStorage.setItem('jarvis.lastGreet', String(lastGreetAt)); } catch { /* 隐私模式 */ }
  const [core, schedules, open, habitTips] = await Promise.all([
    agentMemory.getCore().then(agentMemory.cleanCore).catch(() => ({})), // 去掉像注入指令的行
    scheduler.list().catch(() => []),
    agentMemory.openItems({ k: 2 }).catch(() => []),
    habitHints().catch(() => [])
  ]);
  const { text } = await composeGreeting({ awayMs, coreHuman: core.human, schedules: schedules.filter((x) => x.enabled), openItems: open, habits: habitTips, llm: helperLlm() });
  // 很久没说话的旧对话：开一段新的，问候放在新对话里
  const lastTs = history.at(-1)?.ts ?? 0;
  if (history.length && Date.now() - lastTs > 3 * 3600_000) await switchTo(sessionsApi.create());
  const b = transcript.add('agent', text);
  b.el.classList.add('proactive');
  b.done(`主动问候 · ${reason === 'face' ? '看到你回来了' : '你回到电脑前'}`);
  rememberTurn('assistant', text, { proactive: true });
  director.onEmotion('亲和');
  wp({ say: text, emotion: '亲和' });
  hud.think(`◆ 主动问候（离开 ${Math.round(awayMs / 60000)} 分钟）`);
  if (settings.readTyped) speaker.speak(text);
  if (document.hidden && DESKTOP && !settings.readTyped) DESKTOP.invoke('notify', { title: '未央', body: text }).catch(() => {});
  openingCallouts();
  return text;
}
/** 习惯提示（操作习惯学习开启后才有，见 habits.js） */
const habitHints = async () => habits.hintFor(await habits.load());

// ---------------------------------------------------------------- 操作习惯学习（桌面版，默认关闭）
/** 把习惯结论写进记忆（每天最多一次，或手动） */
async function memorizeHabits({ manual = false } = {}) {
  const r = habits.insightsFrom(await habits.load());
  if (!r.ready) { if (manual) toast(`再观察几天：已有 ${r.days} 天的记录，至少要 3 天才总结习惯`); return 0; }
  const today = new Date().toDateString();
  let last = '';
  try { last = localStorage.getItem('jarvis.habitsMemorized') || ''; } catch { /* 隐私模式 */ }
  if (!manual && last === today) return 0;
  for (const text of r.insights) await agentMemory.remember(`用户${text}`, 'habit', { importance: 2, source: 'habits' });
  try { localStorage.setItem('jarvis.habitsMemorized', today); } catch { /* 隐私模式 */ }
  panels.refreshMind();
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
  DESKTOP.onActivity?.((sample) => { habits.record(sample); });
  setInterval(() => { habits.flush().then(() => memorizeHabits()).catch(() => {}); }, 60_000);
}

// 网页版：标签页隐藏 30 分钟以上再回来，也算“回来了”
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!DESKTOP && hiddenAt && Date.now() - hiddenAt >= 30 * 60_000) greetOnReturn({ awayMs: Date.now() - hiddenAt, reason: 'tab' });
  hiddenAt = 0;
});

// ---------------------------------------------------------------- 定时任务
/** 系统通知：桌面版用系统通知；网页版用浏览器通知（需要授权），并总是弹一条提示 */
function notify(title, body) {
  toast(`${title}：${body.slice(0, 60)}`);
  if (DESKTOP) { DESKTOP.invoke('notify', { title, body }).catch(() => {}); return; }
  if (MOBILE) { globalThis.__jarvisBackgroundTask?.notifyDone?.({ title, body: body.slice(0, 300) }).catch(() => {}); return; }
  try { if (Notification.permission === 'granted') new Notification(title, { body }); } catch { /* 不支持 */ }
}
let schedulerBusy = false;
/** 在后台执行一个定时任务：结果存成一段对话（不打断当前对话），并通知 */
async function runScheduled(s) {
  const releaseTask = taskKeeper.begin();
  try {
  const sess = sessionsApi.create();
  sess.title = `⏰ ${s.title}`;
  sess.titleSet = true;
  sess.messages.push({ role: 'user', content: s.prompt, ts: Date.now() });
  const usedTools = [];
  const { adapter, model, problem } = createAdapter(llmConfig, { gateway });
  // 卡住保护、空回复、【无需通知】见 scheduledRun.js
  const res = problem ? { ok: false, quiet: false, text: '', note: problem } : await executeScheduled(async ({ signal, emit }) => runAgent({
    adapter, model, history: [], sessionId: sess.id, signal, emit,
    userText: scheduledPrompt(s, scheduler.describe(s)),
    tools: await buildTools({ background: true }),
    // 无人值守：需要确认的操作默认拒绝，除非这个任务设为“允许无人值守操作”或本次会话已允许；危险命令一律拒绝
    approve: async (req) => preApproved(req, { sessionKeys: sessionApprovals, unattended: s.unattended })
  }), { onEvent: (e) => { if (e.type === 'tool_start') usedTools.push(e.name); } });
  const content = res.ok ? res.text || '（已检查，无需通知）' : `执行失败：${res.note}`;
  sess.messages.push({ role: 'assistant', content, ts: Date.now(), ...(usedTools.length && { tools: [...new Set(usedTools)] }) });
  sess.updatedAt = Date.now();
  await sessionsApi.save(sess).catch(() => {});
  const rec = await scheduler.recordRun(s.id, { ok: res.ok, quiet: res.quiet, session: sess.id, note: res.note });
  const n = notificationFor(s, res, rec); // 【无需通知】时为 null
  if (n) notify(n.title, n.body);
  sessionsPanel?.refresh();
  schedulesPanel?.refresh();
  return sess;
  } finally { releaseTask(); }
}
async function schedulerTick() {
  if (schedulerBusy || active) return; // 正在对话时先等一等，不抢资源
  schedulerBusy = true;
  try {
    for (const s of await scheduler.due()) {
      await scheduler.claim(s.id); // 先排好下一次再执行：中途崩溃重启后不会重复执行
      await runScheduled(s);
    }
  } catch (e) { console.warn('[scheduler]', e); } finally { schedulerBusy = false; }
}

/** “/技能名 内容” → 明确要求模型使用该技能（界面上仍显示用户原话） */
async function expandSlash(text) {
  if (!text.startsWith('/')) return text;
  const names = (await skillPacks.enabled().catch(() => [])).map((p) => p.name);
  const m = skillPacks.matchSlash(text, names);
  return m ? `请使用技能「${m.name}」完成：${m.rest || '（用户没有补充内容，先说明这个技能能做什么并询问需要的材料）'}` : text;
}

// —— 干活时插话、切换对话后台继续
const backgroundTurns = new Set();
/** 干活时又发来一句：问进度直接答；说停就停；其他的交给正在干的未央（下一步开始前看到），不打断 */
async function interject(text, { thumbs = [] } = {}) {
  const turn = active;
  transcript.add('user', text, Date.now(), { thumbs });
  const reply = (words) => { const b = transcript.add('agent', words); b.done(); };
  if (STOP_ASK.test(text)) { interrupt(); reply('好的，已经停下。上面是停下前做到的地方，要接着做跟我说一声。'); return; }
  if (STATUS_ASK.test(text)) { reply(`${turnStatus(turn, now())}。做完会直接给你结果；想停的话点右下角的方块，或者说“停”。`); return; }
  rememberTurn('user', text, thumbs.length ? { thumbs } : {}, turn.session);
  if (!turn.remote) {
    turn.inbox.push(text);
    if (MOBILE) { turn.checkpoint=checkpointEvent(turn.checkpoint,{type:'user_note',text}); savePending(storage,turn.session.id,{checkpoint:turn.checkpoint}); }
  } else if (!turn.remoteId) {
    turn.inbox.push(text); reply('收到补充，连接到原任务后会送达。'); return;
  } else {
    try { await server.appendTaskNote(turn.remoteId,text); }
    catch(e) { if (!prompt.value.trim()) { prompt.value=text; autosize(); } reply('补充没有送达，已放回输入框。原任务不会重复执行；服务器较旧时请先更新服务器。'); return; }
  }
  reply(`收到，做完手上这一步就看这句话（${turnStatus(turn, now())}）。`);
}
/** 切到别的对话：正在干的任务转到后台接着做 */
function toBackground(turn) {
  turn.background = true;
  backgroundTurns.add(turn);
  active = null;
  speaker.cancel();
  setTask('idle');
  toast('刚才的任务在后台接着做，做完会提醒你');
}
/** 后台任务做完（或出错）：记回原来的对话，提醒用户 */
function finishBackground(turn, { text = '', error = '', shown = '', usedTools = [], files = new Set() }) {
  backgroundTurns.delete(turn);
  const extra = { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(files.size && { files: [...files].slice(-12) }) };
  const title = turn.session.title || '另一个对话';
  if (error) {
    if (shown.trim() || usedTools.length) rememberTurn('assistant', `${shown.trim()}\n\n${INTERRUPTED_MARK}`, extra, turn.session);
    toast(`「${title}」里的任务没做完：${error.slice(0, 40)}`);
  } else {
    rememberTurn('assistant', text || '（完成）', extra, turn.session);
    toast(`「${title}」里的任务做完了，切回去就能看到`);
  }
  turn.bubble.done();
  sessionsPanel?.refresh();
}

async function send(text, { echo = true, byVoice = false } = {}) {
  noteAction(byVoice ? '语音提问' : '发消息');
  askNotifyOnce();
  text = String(text || '').trim();
  if (!text && !attachments.length) return;
  if (!attachments.length && companion?.perform(text)) return;
  if (!text && attachments.some((a) => a.image)) text = '请看看这张图片。';
  // 正在干活时又发了一句：不打断，问进度就直接答，别的话交给正在干的未央；说“停”才停
  if (echo && active && !active.streamDone) {
    const extra = attachments.splice(0); renderAttachments();
    if (server && extra.length) {
      try { for (const f of extra) await server.upload(f.path, await ws.readBlob(f.path)); }
      catch (e) { attachments.unshift(...extra); renderAttachments(); if (!prompt.value.trim()) { prompt.value=text; autosize(); } toast(`附件未送达，已保留：${e.message}`); return; }
      if (!active || active.streamDone) { attachments.unshift(...extra); renderAttachments(); return send(text,{echo,byVoice}); }
    }
    const content = extra.length ? text + '\n\n[已上传到工作区：' + extra.map(f=>f.path).join('、') + ']' : text;
    return interject(content, { thumbs:extra.filter(f=>f.image).map(f=>({src:f.image.thumb,path:f.path})) });
  }
  if (active) { active.ctrl.abort(); active = null; }
  speaker.cancel();
  speaker.unlock(); // 发送多由点击 / 回车触发：顺便启动音频上下文，云端语音才能播放

  // 持续聊天也保持有界；先重画已完成的历史，再追加本轮，避免重复消息。
  if (MOBILE && (historyViewEnd !== null || $('#transcript').querySelectorAll('.msg').length >= visibleHistory().limit)) replayTranscript();
  const files = attachments.splice(0);
  renderAttachments();
  const userText = files.length ? `${text}\n\n[已上传到工作区：${files.map((f) => f.path).join('、')}]` : text;
  const imgs = files.filter((f) => f.image).map((f) => f.image);
  const thumbs = files.filter(f => f.image).map(f => ({ src:f.image.thumb, path:f.path }));
  if (echo) transcript.add('user', userText, Date.now(), { thumbs }); // echo=false：这句话之前已经显示并记下了
  director.onUserText(text);
  hud.newTurn();
  hud.think(`◂ 收到：${text.slice(0, 30)}`);
  // 之前发过的图片（最近两条带图的消息）继续带给模型：追问“第二张图里……”时模型还看得到
  // 只在这句话提到图片时才带（不然后面每句闲聊都会被当成看图任务、多花流量）
  const refersToImage = !imgs.length && /图|截图|照片|相片|图片|表格|这张|那张|第.张|上面|刚才发的|picture|image|screenshot/i.test(text);
  // 长对话：已压缩进摘要的消息不再原样发送，其余（至少最近 20 条）原样发送，见 compress.js
  const recent = compress.unsummarized(history, session.summary);
  const withImages = new Set(refersToImage ? recent.filter((m) => m.role === 'user' && recentImages.has(m.ts)).slice(-2).map((m) => m.ts) : []);
  const llmHistory = recent.map(({ role, content, ts }) => ({ role, content, ...(withImages.has(ts) && { images: recentImages.get(ts) }) }));
  if (echo) rememberTurn('user', userText, thumbs.length ? { thumbs } : {});
  if (imgs.length) {
    recentImages.set(history.at(-1).ts, imgs.map(({ mime, data }) => ({ mime, data })));
    while (recentImages.size > 2) recentImages.delete(recentImages.keys().next().value);
  }

  if (machine.task !== 'listening') machine.beginUserTurn();
  const ctrl = new AbortController();
  const bubble = transcript.add('agent');
  liveBubble = bubble;
  bubble.el.classList.add('streaming');
  // 这一轮属于哪个会话：切到别的对话后在后台接着做，结果、文件都记回这个会话
  const turn = { ctrl, streamDone: false, bubble, session, files: new Set(), inbox: [], t0: now(), steps: 0, status: '', background: false };
  active = turn;
  setTask('processing', '思考中');
  // 手机：记下正在做的任务（App 被划掉时，下次打开接着做）
  const doneSteps = [];
  turn.checkpoint={text:userText,notes:[],inFlight:[],steps:[],files:[],status:'running'};
  if (MOBILE && !server) savePending(storage,session.id,{turnId:turn.t0,text:userText,title:session.title||'',ts:Date.now(),steps:[],files:[],checkpoint:turn.checkpoint});

  // 模型分工：按这句话的类型换模型；日常对话让推理模型少想一点（首字更快）
  const task = shouldTeam(text, settings.teamMode === 'auto' && !helperLlm() ? 'off' : settings.teamMode) ? 'reason' : classifyTask(text, { images: imgs.length + withImages.size });
  const route = routeFor(llmConfig, task);
  const { adapter, model, problem } = createAdapter(route.cfg, { gateway });
  if (COMPACT && isAuto(llmConfig) && model && !server) $('#model-chip-text').textContent = `自动 · ${model}`;
  // 日常闲聊少想一点（首字更快）；要查证、分析、算结果的不省
  const effort = effortFor(task, text, llmConfig);
  if (route.routed) hud.think(`◇ 模型分工：${TASKS[task].name} → ${route.model}`);
  // 服务器模式下电脑版：要动这台电脑的事（桌面、文件夹、打开软件……）留在本机做，其余交给服务器
  const here = Boolean(server && DESKTOP && needsComputer(text));
  turn.remote=Boolean(server&&!here);
  if (here) hud.think('◇ 这件事要操作这台电脑：在本机做');
  if (problem && (!server || here)) { // 服务器模式：用服务器上的模型设置
    bubble.append(problem);
    bubble.done();
    callouts?.set(followUpSuggestions({ error: true, userText: text }));
    active = null;
    setTask('error', '需要配置模型');
    showPanel('models');
    return;
  }

  // 备用模型：当前模型出错（重试后还不行）时自动换着用
  const fallbacks = fallbackRoutes(llmConfig, { provider: route.cfg.provider, model }).map((f) => ({ ...createAdapter(f.cfg, { gateway }), label: f.model })).filter((f) => !f.problem && f.adapter && f.model);
  let usedModel = model; // 换过备用模型时，回答下面写实际用的那个

  // 语音对话中、或者是说话提问的：念回答；打字提问只显示（设置里打开“打字提问也朗读”除外）
  const spoken = callActive || byVoice || settings.readTyped;
  const speech = makeSpeech(spoken);
  const cards = new Map();
  let firstToken = 0;
  let outMarked = false; // 崩溃记录：这一段在输出文字
  let textChunks = 0; // 回答分几次收到：1 次说明是整段一次性到的（中转站或网络没有边生成边给）
  let serverCard = null;
  const t0 = now();
  const usedTools = [];
  const madeFiles = turn.files;
  let shown = ''; // 这一轮已经显示出来的回答（中断时保留，点“继续”接着写）
  let ctxMs = null;
  callouts?.retract();
  // 内置演示模式下“自动”不触发（规则拆步效果有限），只认明确的“/团队 …”或“总是”
  const team = !server && shouldTeam(text, settings.teamMode === 'auto' && !helperLlm() ? 'off' : settings.teamMode);
  let teamCard = null;
  const releaseTask = taskKeeper.begin();
  try {
    // 服务器模式：服务器做，进度事件和本机一样显示（runRemote 的用法和 runAgent 一样）
    const serverRun = async (o) => {
      for (const f of files) await server.upload(f.path, await ws.readBlob(f.path)); // 发来的附件先传到服务器的工作区
      return runRemote(server, { sessionId: o.sessionId, userText: o.userText, images: o.images, voice: o.voice, emit: o.emit, signal: o.signal, onFile: (p) => pullServerFile(p, turn), onStarted:async remoteTask=>{
        turn.remoteId=remoteTask.id;
        for(const note of turn.inbox.splice(0)) {
          try { await server.appendTaskNote(remoteTask.id,note); }
          catch(e) { prompt.value += (prompt.value.trim()?'\n':'')+note; autosize(); toast('补充未送达原任务，已保留在输入框，请更新服务器或重新发送'); }
        }
      } });
    };
    const result = await (server && !here ? serverRun : team ? runTeam : runAgent)({
      llm: team ? helperLlm('reason') : undefined,
      pickModel: team ? modelForRole : undefined,
      effort,
      adapter, model, history: llmHistory, userText: team ? userText : await expandSlash(userText), signal: ctrl.signal,
      sessionId: session.id,
      summary: session.summary ?? null,
      requirements: collectRequirements(history, session.requirements),
      requirementText: userText, // 保留斜杠命令展开前的原话，避免当成缺失历史重复注入
      fallbacks,
      inbox: team ? null : turn.inbox,
      checkpoint: MOBILE&&!turn.remote ? async event=>{
        turn.checkpoint=checkpointEvent(turn.checkpoint,event);
        savePending(storage,turn.session.id,{checkpoint:turn.checkpoint,ts:Date.now(),files:[...turn.files]});
      }:null,
      // 语音对话：让模型用口语短答；“你好 / 谢谢”这类寒暄不带工具，回得快
      voice: callActive || byVoice,
      light: !files.length && isSmallTalk(text),
      maxSteps: DESKTOP ? 40 : 28, // 用鼠标键盘操作电脑、逐项联网核实时步数多
      images: imgs.map(({ mime, data }) => ({ mime, data })),
      tools: server && !here ? [] : await buildTools({ turn }),
      approve: (req) => {
        if (preApproved(req, { sessionKeys: sessionApprovals })) return true; // 危险命令每次都问
        setTask('processing', '等待你确认');
        const aborted = new Promise((r) => ctrl.signal.addEventListener('abort', () => r('deny'), { once: true }));
        return Promise.race([bubble.confirm(req), aborted]).then((v) => {
          if (v === 'session' && req.key) sessionApprovals.add(req.key);
          return v !== 'deny';
        });
      },
      emit: (e) => {
        if (e.type === 'tool_start' && e.name !== 'update_plan') { turn.steps++; turn.status = toolLabel(e.name); }
        else if (e.type === 'tool_progress') turn.status = e.text;
        else if (e.type === 'text') turn.status = '写回答';
        if (turn.background) {
          // 切到别的对话了：只把内容记在这一轮的气泡里（切回来时接上），不朗读、不改界面状态
          if (e.type === 'text') { bubble.append(e.delta); shown += e.delta; }
          else if (e.type === 'tool_start' && e.name !== 'update_plan') { cards.set(e.id, bubble.toolCard(e.name, e.args)); usedTools.push(e.name); }
          else if (e.type === 'tool_progress') cards.get(e.id)?.progress(e.text);
          else if (e.type === 'tool_end') cards.get(e.id)?.done(e.ok, e.output, e.ms);
          else if (e.type === 'plan') bubble.plan?.(e.steps);
          return;
        }
        if (active !== turn) return;
        if (e.type === 'text') {
          if(callActive&&callTiming?.recognizedAt&&!callTiming.firstTextAt)callTiming.firstTextAt=now();
          if (!firstToken) { firstToken = now(); hud.think('生成回答'); }
          if (!outMarked) { outMarked = true; markActivity(`正在输出回答${shown.length ? `（已 ${shown.length} 字）` : ''}`); }
          if (serverCard) { serverCard.done(true, '由模型服务端完成', Math.round(now() - serverCard.t0)); serverCard = null; }
          bubble.append(e.delta);
          shown += e.delta;
          textChunks++;
          machine.feedResponseText(e.delta);
          speech.push(e.delta);
        } else if (e.type === 'interjection_accepted') {
          speech.resume();
          bubble.status?.('已收到补充，正在调整…');
          if (callActive) callStatus('已收到，正在按补充要求处理…');
        } else if (e.type === 'fallback') {
          usedModel = e.to;
          const note = `${e.from} 出错（${e.reason}），已换成 ${e.to} 接着做`;
          hud.think(`⇄ ${note}`, 'sub');
          toast(note);
          setTask('processing', `已换成 ${e.to}`.slice(0, 30));
        } else if (e.type === 'retry') {
          const note = e.resume ? `网络中断，第 ${e.attempt} 次重连，接着刚才的地方写` : `连接出错，第 ${e.attempt} 次自动重试`;
          hud.think(`↻ ${note}`, 'sub');
          setTask('processing', note.slice(0, 30));
        } else if (e.type === 'emotion') { machine.setStreamHint(e.value); director.onEmotion(e.value); bubble.mood?.(e.value); }
        else if (e.type === 'state' && e.value !== 'done') setTask(e.value, e.value === 'listening' ? '生成回答' : '');
        else if (e.type === 'plan') bubble.plan?.(e.steps); // 任务清单：卡片里实时打勾
        else if ((e.type === 'tool_start' || e.type === 'tool_end') && e.name === 'update_plan') { /* 更新清单本身不单独占一张工具卡片 */ }
        else if (e.type === 'tool_start') {
          director.onToolStart(e.name);
          hud.toolStart(e.id, toolLabel(e.name));
          hud.think(`▸ ${toolLabel(e.name)}  ${summarizeArgs(e.name, e.args)}`);
          cards.set(e.id, bubble.toolCard(e.name, e.args));
          usedTools.push(e.name);
          bubble.status?.(`正在${toolLabel(e.name)}…`);
          setTask('processing', toolLabel(e.name));
          markActivity(`${toolLabel(e.name)} ${summarizeArgs(e.name, e.args)}`.slice(0, 80));
          outMarked = false;
        } else if (e.type === 'tool_progress') {
          cards.get(e.id)?.progress(e.text);
          hud.think(`  ${e.text}`, 'sub');
          setTask('processing', e.text.slice(0, 30));
        } else if (e.type === 'tool_end') {
          cards.get(e.id)?.done(e.ok, e.output, e.ms);
          hud.toolEnd(e.id, e.ok);
          if (MOBILE&&!turn.remote) { if(e.ok) doneSteps.push(toolLabel(e.name)); savePending(storage, turn.session.id, { ts: Date.now(), steps: doneSteps, files: [...turn.files] }); }
          if (!e.ok) hud.think(`✕ ${toolLabel(e.name)} 失败`, 'bad');
          if (/remember|forget|save_skill/.test(e.name)) panels.refreshMind();
        } else if (e.type === 'server_tool') {
          serverCard = Object.assign(bubble.toolCard('web_search', { query: `${searchBrand(model)}自带联网搜索` }), { t0: now() });
        } else if (e.type === 'sources') bubble.sources(e.items);
        else if (e.type === 'timing') ctxMs = e.contextMs;
        else if (e.type === 'team_plan') { hud.think(`团队分工 · ${e.steps.map((x) => x.roleName).join(' → ')}`); teamCard = bubble.teamCard(e.steps); setTask('processing', `团队分工 · ${e.steps.length} 步`); }
        else if (e.type === 'team_step') {
          teamCard?.step(e.index, e.status, e.note);
          if (e.status === 'running' || e.status === 'redo') setTask('processing', `第 ${e.index + 1} 步${e.status === 'redo' ? ' · 返工' : ''}`);
        } else if (e.type === 'team_review') { teamCard?.review(e); setTask('processing', e.pass ? '审核通过，汇总中' : '审核发现问题'); }
      }
    });
    if (turn.background) { finishBackground(turn, { text: result.text, shown, usedTools, files: madeFiles }); return; }
    if (active !== turn) return;
    speech.flush();
    const total = now() - t0;
    const modelTag = server && !here ? '服务器 · ' : here ? `本机 · ${model} · ` : providerById(llmConfig.provider)?.kind === 'mock' ? '' : usedModel !== model ? `${usedModel}（${model} 出错后换用） · ` : `${model}${route.routed ? `（${TASKS[task].name}）` : ''} · `;
    bubble.done(`${modelTag}${team ? `团队 ${result.steps} 步 · ` : ''}${ctxMs !== null && ctxMs >= 300 ? `准备 ${(ctxMs / 1000).toFixed(1)}s · ` : ''}${firstToken ? `首字 ${((firstToken - t0) / 1000).toFixed(1)}s · ` : ''}耗时 ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · 工具 ${result.toolCalls} 次` : ''}${MOBILE && textChunks ? ` · 分 ${textChunks} 次收到${globalThis.__jarvisNetVia?.(llmConfig.baseURLs?.[llmConfig.provider] || '') === 'native' ? '（原生网络）' : ''}` : ''}`, {
      onFeedback: async (kind, comment) => {
        if (kind === 'up') await agentMemory.noteTask(`获得好评：${text.slice(0, 30)}`);
        else {
          await agentMemory.addLesson(`关于「${text.slice(0, 40)}」的回答，用户不满意：${comment || '未说明原因，下次先确认需求再回答'}`, text);
          toast('已记下这条教训，之后遇到类似问题会注意');
        }
        panels.refreshMind();
      }
    });
    dashboard.setLatency(firstToken ? firstToken - t0 : null, total);
    hud.think(`✓ 完成 · ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · ${result.toolCalls} 个工具` : ''}`, 'ok');
    $('#hud-latency').textContent = firstToken ? `${Math.round(firstToken - t0)} ms` : '—';
    if (result.text) wp({ say: result.text.replace(/```[\s\S]*?```/g, '').replace(/[#*>`|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 4000) });
    rememberTurn('assistant', result.text || '（完成）', { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) }, turn.session);
    // 做完时人不在（App 在后台 / 窗口没在看）：发通知，点开就能看结果
    if (document.hidden) notify('未央做完了', `${(turn.session.title || text).slice(0, 30)}：${stripEmotionTags(result.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    // 在本机做的这一轮也记回服务器上的这段对话（手机上能看到）
    if (here) server.appendSession(turn.session.id, turn.session.messages.slice(-2).map(({ role, content, ts, tools }) => ({ role, content, ts, ...(tools && { tools }) }))).catch((e) => toast(`这一轮没能记到服务器上：${e.message}`));
    $('#mode-pill').classList.remove('offline');
    turn.streamDone = true;
    callouts?.set(followUpSuggestions({ tools: usedTools, userText: text, desktop: Boolean(DESKTOP) }));
    scheduleReflect();
    compressHistory();
    if (!speaker.speaking) finishTurn();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (turn.background) { finishBackground(turn, { error: friendlyError(String(err.message || err)), shown, usedTools, files: madeFiles }); return; }
    if (active !== turn) return;
    const msg = friendlyError(String(err.message || err));
    const cors = !MOBILE && /Failed to fetch|NetworkError|Load failed|CORS/i.test(msg);
    bubble.append(`\n（出错了：${msg}${cors ? '。多半是该服务商不允许网页直接调用：双击 jarvis 文件夹里的 启动.bat（或 start.sh）并保持窗口开着，本页面会自动连上本机网关，然后重试即可' : ''}）`);
    if (cors && !gateway) detectGateway();
    bubble.done();
    bubble.activity('error');
    $('#mode-pill').classList.add('offline');
    active = null;
    setTask('error', '请求失败');
    hud.think(`✕ ${msg.slice(0, 40)}`, 'bad');
    // 已经写了一部分或做了几步：记进对话，点“继续”从断开的地方接着做，而不是从头再来
    const resumable = Boolean(shown.trim() || usedTools.length);
    if (resumable) rememberTurn('assistant', `${shown.trim()}\n\n${INTERRUPTED_MARK}`, { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) }, turn.session);
    callouts?.set(followUpSuggestions({ error: true, resumable, userText: text, desktop: Boolean(DESKTOP) }));
  } finally {
    if (MOBILE) clearPending(storage, turn.session.id, turn.t0);
    await persistSession(turn.session);
    releaseTask();
    endControl();
    // 回答写完的一瞬间又收到的话（没来得及交给模型）：接着当一句新话处理
    const left = turn.inbox.splice(0);
    if(left.length&&turn.remote){prompt.value+=(prompt.value.trim()?'\n':'')+left.join('\n');autosize();toast('未送达的补充已放回输入框，没有另开任务');}
    else if (left.length && !ctrl.signal.aborted && !turn.background && session === turn.session) setTimeout(() => send(left.join('\n'), { echo: false }), 0);
  }
}

// 用户有动静：空闲漫游中的粒子体回到光核看着他
let lastPoke = 0;
const poke = () => { const t = performance.now(); if (t - lastPoke > 1000) { lastPoke = t; director.poke(); } };
addEventListener('pointermove', poke, { passive: true });
addEventListener('keydown', poke);

// —— 输入框：Enter 发送，Shift+Enter 换行；随内容自动增高
const prompt = $('#prompt');
function autosize() { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`; composer?.refresh(); }
$('#inputbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = prompt.value;
  prompt.value = '';
  autosize();
  send(v);
});
// 手机（触屏）键盘没有 Shift：回车就是换行，点发送按钮才发送；电脑上回车发送、Shift+回车换行
const enterSends = () => !MOBILE && !globalThis.matchMedia?.('(pointer: coarse)').matches;
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && enterSends()) {
    e.preventDefault();
    $('#inputbar').requestSubmit();
  }
});
prompt.addEventListener('input', (e) => {
  autosize();
  if (e.target.value && speaker.speaking) speaker.cancel(); // 开始打字即打断朗读
  if (e.target.value && !active && machine.task !== 'listening') machine.beginUserTurn();
});

// —— 常用指令：把开头写好放进输入框，接着补充再发
initQuickPrompts({
  button: $('#btn-quick'),
  onPick: (text) => {
    prompt.value = prompt.value.trim() ? `${text}${prompt.value}` : text;
    autosize();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }
});

// —— 附件：上传 / 拖入的文件放进工作区“上传/”目录，并附在下一条消息里
async function addFiles(list) {
  for (const f of list) {
    try {
      const r = await ws.write(`上传/${f.name}`, f);
      // 图片同时作为“看图”输入发给模型
      const image = isImageName(f.name) ? await prepareImage(f).catch(() => null) : null;
      attachments.push({ path: r.path, image });
      panels.markFresh(r.path);
    } catch (e) { toast(`${f.name}：${e.message}`); }
  }
  renderAttachments();
  panels.refreshFiles();
  prompt.focus();
}
function renderAttachments() {
  queueMicrotask(() => composer?.refresh());
  const box = $('#attach-list');
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((a, i) => {
    const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: '移除' });
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    const s = document.createElement('span');
    if (a.image) {
      s.className = 'has-thumb';
      s.append(imageButton(a.image.thumb, () => previewWorkspaceImage(a.path,a.image.thumb).catch(e => toast(e.message))));
    }
    const label = Object.assign(document.createElement('span'), { className:'attach-name', textContent:a.image ? '图片 · 已上传工作区' : a.path.split('/').pop(), title:a.path });
    s.append(label, x);
    return s;
  }));
}
// ＋菜单统一处理文件入口；原相机、文件上传处理器保留。
initCamera({ button: $('#btn-camera'), input: $('#camera-input'), native: MOBILE || /Android|iPhone|iPad/i.test(navigator.userAgent), onFiles: addFiles, onError: e => toast(e.message) });
addEventListener('jarvis:open-upload', e => { showPanel('workspace'); if (e.detail?.path) panels.openFile(e.detail.path); });
// 粘贴截图 / 图片
$('#prompt').addEventListener('paste', (e) => {
  const imgs = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
  if (!imgs.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  addFiles(imgs.map((f, i) => new File([f], `粘贴-${stamp}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
});
$('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------- 语音
// 唤醒词：未唤醒时只听不动——不打断正在进行的回答，不显示识别中的文字
const wake = new WakeWindow();
const asleep = () => settings.wakeWord && !wake.awake;
const DISMISS = /^(退下|没事了|休息吧|再见|就这样)[。.！!]*$/;
// 窄屏用短提示语，避免输入框被撑成好几行
const narrowPrompt = matchMedia('(max-width: 860px)');
const setPlaceholder = () => { $('#prompt').placeholder = narrowPrompt.matches ? '交给我一个任务……' : '交给我一个任务：写代码、做 PPT、分析文件、查资料……（Enter 发送，Shift+Enter 换行）'; };
narrowPrompt.addEventListener?.('change', setPlaceholder);
setPlaceholder();
setInterval(() => document.body.classList.toggle('awake', settings.wakeWord && wake.awake), 250);
function onWake() {
  wake.wake();
  const ctx = speaker.unlock();
  if (ctx?.state === 'running') playCue(ctx, 'start', 0.08);
  machine.beginUserTurn();
}

// 语音识别：网页版优先用浏览器自带识别；桌面版（Electron 没有浏览器识别）或用户指定时走云端转写
const browserSR = speechRecognitionSupported && !window.jarvisDesktop && !MOBILE; // 桌面版、手机 App 里的浏览器识别都用不了
const callStatus = text => { $('#voice-call-status').textContent = text; };
const sttEngine = () => resolveStt(llmConfig, { gateway, browserSupported: browserSR });
function recordedVoice() {
  return new RecordedVoice({ getTranscriber: () => { const id = sttEngine(); return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id,llmConfig,wav,{gateway,signal}); }, ...voiceHandlers });
}
const voiceHandlers = {
  onStatus: phase => { if(callActive&&phase==='speech')callTiming={};if(callActive&&phase==='processing'){callTiming??={};callTiming.stoppedAt=now();} recordVoiceEvent('识别阶段',phase); if (callActive) callStatus({ ready:'麦克风已开启，请说话', speech:'正在听你说话…', processing:'正在识别这句话…', popup:'尝试手机系统的语音窗口…' }[phase] || phase); },
  onUnavailable: async message => {
    recordVoiceEvent('系统识别不可用',message);
    if (!MOBILE || !callActive || callCloudFallback || /权限|permission/i.test(message) || sttEngine() === 'none') return;
    const gen = callGeneration; voiceSwitching = true; callCloudFallback = true;
    try {
      voice.disable(); await globalThis.__jarvisSpeech?.stop();
      if (!callActive || gen !== callGeneration) return;
      voice = recordedVoice(); callStatus('系统识别暂不可用，正在启用服务商转写…');
      await voice.enable({ silenceMs:SILENCE_BY_SENSITIVITY[settings.vadSensitivity] });
      if (gen !== callGeneration) voice.disable();
    } catch (e) { toast(`语音转写无法启动：${e.message}`); if (gen === callGeneration) await setVoiceCall(false); }
    finally { voiceSwitching = false; }
  },
  onConfirm: () => {
    if (callActive) callStatus('正在听你说话…');
    if (asleep()) return;
    live.voiceListening = true;
    if (!active) director.setState('voice');
    // 开口只打断朗读，不取消正在执行的任务；最终文字走同一套补充要求逻辑。
    if (active) active.muteSpeech = true;
    speaker.cancel();
    machine.beginUserTurn();
    dashboard.setTask('listening', '正在听');
    $('#vad-meter').classList.add('on');
  },
  onCancel: () => endListening(),
  onInterim: (t) => { if (!asleep() || matchWake(t).woke) transcript.interim(t); },
  onFinal: (t) => {
    if (dictating) {
      const text = String(t || '').trim();
      stopDictation();
      if (text) { prompt.value += (prompt.value.trim() ? ' ' : '') + text; autosize(); prompt.dispatchEvent(new Event('input',{bubbles:true})); prompt.focus(); }
      return;
    }
    if (callActive) {callTiming??={};callTiming.recognizedAt=now();callStatus('未央正在思考…');}
    endListening();
    transcript.clearInterim();
    if (!settings.wakeWord) return send(t, { byVoice: true });
    const m = matchWake(t);
    if (!wake.awake && !m.woke) return; // 没叫名字：忽略
    const cmd = m.woke ? m.rest : t;
    if (DISMISS.test(cmd)) {
      wake.sleep();
      speaker.speak('好的，有需要再叫我。');
      return;
    }
    onWake();
    if (!cmd) {
      if (active) { active.ctrl.abort(); active = null; }
      speaker.cancel();
      speaker.speak('我在。');
      setTask('listening', '已唤醒');
      return;
    }
    send(cmd, { byVoice: true });
  },
  onEnergy: (e) => {
    live.voiceEnergy = e;
    $('#inputbar').style.setProperty('--e', e.toFixed(2));
  },
  onMode: (m) => {
    if (m === 'off' && callActive && !callStarting && !voiceSwitching) queueMicrotask(() => { if (!voiceSwitching && callActive) setVoiceCall(false); });
    if (callActive) callStatus(m === 'off' ? '语音已停止' : m === 'loading' ? '正在准备语音…' : m === 'ptt' ? '按住麦克风说话，松开后回复' : '直接说话，未央在听');
    $('#voice-status').textContent = {
      off: '',
      loading: sttEngine() === 'qwen-realtime' ? '正在连接百炼实时识别…' : '正在加载本地语音活动检测模型…',
      vad: '已开启：直接说话即可，停顿后自动提交。',
      ptt: '语音活动检测不可用，已降级为“按下说话”：按住麦克风说话，松开提交。'
    }[m];
    $('#btn-mic').setAttribute('aria-pressed', String(m !== 'off'));
    body.classList.toggle('voice-on', m !== 'off');
    body.classList.toggle('voice-ptt', m === 'ptt');
    $('#btn-mic').title = dictating ? '停止语音转文字' : '语音转文字';
    $('#btn-mic').setAttribute('aria-label', dictating ? '停止语音转文字' : '语音转文字');
  },
  onError: (code) => {
    if (dictating) stopDictation();
    recordVoiceEvent('识别错误',code);
    if (callActive) callStatus(String(code));
    toast(code === 'not-allowed' ? '麦克风权限被拒绝' : /^语音识别/.test(code) ? code : `语音识别出错：${code}`);
  }
};
let voice = new (MOBILE ? RecordedVoice : VoiceInput)({
  allowBrowserSR: browserSR,
  getTranscriber: () => {
    const id = sttEngine();
    return id === 'browser' || id === 'none' ? null : (wav, signal) => transcribe(id, llmConfig, wav, { gateway, signal });
  },
  ...voiceHandlers
});
// 安卓 App：有系统语音识别就用它（免费、不用密钥、自己判断说完）；没有再走云端转写
const nativeVoiceReady = MOBILE && globalThis.__jarvisSpeech
  ? NativeVoice.available(globalThis.__jarvisSpeech).then((ok) => {
    globalThis.__jarvisNativeSpeechAvailable = ok; recordVoiceEvent('系统服务检测',String(ok));
    if (ok) voice = new NativeVoice({ plugin: globalThis.__jarvisSpeech, ...voiceHandlers });
    return ok;
  })
  : Promise.resolve(false);

function endListening() {
  if (!live.voiceListening) return;
  live.voiceListening = false;
  if (!active) director.setState('idle');
  live.voiceEnergy = 0;
  transcript.clearInterim();
  $('#vad-meter').classList.remove('on');
  // 识别被取消且没有发出请求：回到空闲；保持情绪不变以外的状态（no-speech 不触发警觉）
  if (!active && machine.task === 'listening') setTask('idle');
}

async function setDirectVoice(on) {
  const nativeAvailable = await nativeVoiceReady; // 手机上先确定用不用系统识别
  if (on && sttEngine() === 'qwen-realtime') {
    if (!(voice instanceof QwenVoice)) { voice.disable(); voice = new QwenVoice({ getConfig:()=>llmConfig, getGateway:()=>gateway, allowBargeIn:()=>callActive, ...voiceHandlers }); }
  } else if (on && voice instanceof QwenVoice) {
    voice.disable();
    voice = new (MOBILE ? RecordedVoice : VoiceInput)({ allowBrowserSR:browserSR, getTranscriber:()=>{const id=sttEngine();return id==='none'||id==='browser'?null:(wav,signal)=>transcribe(id,llmConfig,wav,{gateway,signal});}, ...voiceHandlers });
  }
  if (MOBILE && on) {
    const useNative = nativeAvailable && (llmConfig.stt?.engine || 'auto') === 'auto';
    if (useNative && !(voice instanceof NativeVoice)) { voice.disable(); voice = new NativeVoice({ plugin: globalThis.__jarvisSpeech, ...voiceHandlers }); }
    if (!useNative && voice instanceof NativeVoice) {
      voice.disable();
      voice = new RecordedVoice({ getTranscriber: () => { const id = sttEngine(); return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id, llmConfig, wav, { gateway, signal }); }, ...voiceHandlers });
    }
  }
  setSetting('directVoice', on);
  $('#set-voice').checked = on;
  if (on) {
    try {
      await voice.enable({ silenceMs: SILENCE_BY_SENSITIVITY[settings.vadSensitivity] });
    } catch (err) {
      recordVoiceEvent('启动失败',err.message); toast(err.message);
      if (/云端语音识别/.test(err.message)) showPanel('models');
      setSetting('directVoice', false);
      $('#set-voice').checked = false;
      return false;
    }
  } else {
    voice.disable();
    endListening();
  }
  return true;
}

/** 语音通话临时开启朗读并关闭唤醒词，结束后恢复原来的偏好。 */
async function setVoiceCall(on) {
  noteAction(on ? '开始语音对话' : '结束语音对话');
  if (on && (callStarting || callActive)) return;
  if (on && dictating) await stopDictation();
  const gen = ++callGeneration;
  if (!on) {
    callActive = false;
    $('#voice-call-panel').hidden = true;
    $('#btn-call').setAttribute('aria-pressed', 'false');
    $('#btn-call').setAttribute('aria-label', '开始语音对话');
    speaker.cancel();
    if (callRestore) {
      settings.speechOutput = callRestore.speechOutput;
      settings.wakeWord = callRestore.wakeWord;
      callRestore = null;
    }
    await setDirectVoice(false);
    return;
  }
  callStarting = true;
  callCloudFallback = false;
  callActive = true;
  callRestore = { speechOutput: settings.speechOutput, wakeWord: settings.wakeWord, directVoice: settings.directVoice };
  settings.speechOutput = true;
  settings.wakeWord = false;
  speaker.unlock();
  $('#voice-call-panel').hidden = false;
  $('#btn-call').setAttribute('aria-pressed', 'true');
  $('#btn-call').setAttribute('aria-label', '结束语音对话');
  recordVoiceEvent('通话','开始连接');
  callStatus('正在连接语音…');
  try {
    const ok = await setDirectVoice(true);
    if (gen !== callGeneration) { await setDirectVoice(false); return; }
    if (!ok) await setVoiceCall(false);
    else callStatus(voice.mode === 'ptt' ? '按住麦克风说话，松开后回复' : '直接说话，未央在听');
  } catch (e) {
    toast(`语音无法启动：${e.message || e}`);
    if (gen === callGeneration) await setVoiceCall(false);
  } finally { callStarting = false; }
}
$('#btn-call').addEventListener('click', () => setVoiceCall(!callActive));
$('#btn-call-end').addEventListener('click', () => setVoiceCall(false));
const voiceCheckButton = Object.assign(document.createElement('button'),{type:'button',className:'voice-diagnose',textContent:'检测语音'});
voiceCheckButton.onclick = async () => { await setVoiceCall(false); showPanel('settings'); await checkVoice(); };
$('#voice-call-panel').append(voiceCheckButton);
const takeFloor = Object.assign(document.createElement('button'), {type:'button',textContent:'我来说',id:'btn-call-listen'});
takeFloor.onclick = () => { if (active) active.muteSpeech=true; speaker.cancel(); voice.setSuppressed(false); callStatus('正在听你说话…'); };
$('#voice-call-panel').append(takeFloor);
const voiceLifecycle = createVoiceLifecycle({
  getState: () => ({ hidden:document.hidden, nativeActive:globalThis.__jarvisForeground !== false, starting:callStarting, systemDialog:Boolean(globalThis.__jarvisSystemSpeechDialog) }),
  onAudio: foreground => speaker.setForeground(foreground),
  onLeave: () => { if (dictating) { stopDictation(); return; } if (!MOBILE && !(voice instanceof QwenVoice)) return; if (callActive) { companion?.close(); setVoiceCall(false); } else if (voice.mode !== 'off') setDirectVoice(false); }
});
document.addEventListener('visibilitychange', () => voiceLifecycle.update());
addEventListener('jarvis:foreground', () => voiceLifecycle.update());
voiceLifecycle.update();

// “检测语音”：逐项检查麦克风 / 系统识别 / 云端转写 / 语音检测模型，告诉用户卡在哪一步
async function checkVoice() {
  const list = $('#voice-check');
  list.hidden = false;
  list.replaceChildren();
  const line = (ok, text) => { const li = document.createElement('li'); li.dataset.ok = ok === null ? 'wait' : ok ? '1' : '0'; li.textContent = text; list.append(li); return li; };
  await nativeVoiceReady;
  // 1. 麦克风
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    line(true, '麦克风：已允许');
  } catch (e) {
    line(false, `麦克风：不能用（${e.name === 'NotAllowedError' ? '权限被拒绝，请在系统设置里允许未央使用麦克风' : e.message || e.name}）`);
  }
  await checkRecognition(line);
  // 检测真正配置的声音，不能只检测手机系统朗读后声称云端女声正常。
  const tli = line(null,'实际声音服务：正在合成并试听…');
  try {
    const result = await speaker.test();
    tli.dataset.ok = '1'; tli.textContent = `实际声音：${result.engine} · ${result.voice || '服务默认'}（已解码并播放；请确认听感）`;
    recordVoiceEvent('声音检测成功',`${result.engine} ${result.voice}`);
  } catch (e) {
    tli.dataset.ok = '0'; tli.textContent = `实际声音服务不可用：${e.message}`; recordVoiceEvent('声音检测失败',e.message);
  }
  for (const event of readVoiceEvents().slice(-6)) line(null,`${new Date(event.time).toLocaleTimeString('zh-CN')} · ${event.stage}：${event.detail}`);

}

/** 语音自检里的“识别”部分 */
async function checkRecognition(line) {
  if (sttEngine() === 'qwen-realtime') {
    const li=line(null,'百炼实时识别：正在连接…');
    let session;
    try {
      session=await openQwenSession({model:QWEN_ASR,key:llmConfig.keys?.qwen||'',region:llmConfig.voice?.qwenRegion||'beijing',gateway,signal:AbortSignal.timeout(20000)});
      li.dataset.ok='1';li.textContent='百炼实时识别：会话配置成功；请实际说话验证，连接成功不代表已测识别准确率';
    } catch(e) {li.dataset.ok='0';li.textContent='百炼实时识别：'+e.message;}
    finally {session?.close();}
    return;
  }
  // 2. 识别方式
  if (voice instanceof NativeVoice) { line(true, '系统语音服务可发现；需实际说话验证，失败后尝试系统窗口或云端转写'); return; }
  if (MOBILE) line(false, '手机自带语音识别：这台手机没有可用的识别服务，改用云端转写');
  const id = sttEngine();
  if (id === 'browser') { line(true, '识别方式：浏览器自带语音识别'); return; }
  if (id === 'none') { line(false, '识别方式：没有可用的语音识别。请在“模型 → 声音”填硅基流动或 OpenAI 的 Key'); return; }
  // 3. 云端转写：发 1 秒静音试一下
  const li = line(null, `云端转写（${sttEngineById(id)?.name ?? id}）：检测中…`);
  try {
    await transcribe(id, llmConfig, encodeWav(new Float32Array(16000)), { gateway, signal: AbortSignal.timeout?.(20000) });
    li.dataset.ok = '1';
    li.textContent = `云端转写（${sttEngineById(id)?.name ?? id}）：接口连通（静音检测不代表实际识别准确）`;
  } catch (e) {
    li.dataset.ok = '0';
    li.textContent = `云端转写：${e.message}`;
  }
  if (MOBILE) { line(true, '语音切句：轻量录音模式，不需要下载语音检测模型'); return; }
  // 4. 语音检测模型（网页版云端转写靠它切分句子）
  const vli = line(null, '语音检测模型：检测中…');
  try {
    // 手机版打在 APK 里（本地服务不一定支持 HEAD，直接读）
    const r = await fetch(`${VAD.baseAssetPath}silero_vad_v5.onnx`, { method: MOBILE ? 'GET' : 'HEAD', signal: AbortSignal.timeout?.(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    vli.dataset.ok = '1';
    vli.textContent = MOBILE ? '语音检测模型：已内置' : '语音检测模型：能下载';
  } catch (e) {
    vli.dataset.ok = '0';
    vli.textContent = `语音检测模型：加载不了（${e.message}），说话后无法自动提交`;
  }
}
$('#btn-voice-check').addEventListener('click', () => checkVoice());

const mic = $('#btn-mic');
if (!browserSR && !window.jarvisDesktop && !MOBILE && sttEngine() === 'none') {
  // Firefox 等：隐藏语音输入，保留文本输入与语音输出（需求 6.1 / 10）
  mic.hidden = true;
  $('#row-voice').hidden = true;
  setSetting('directVoice', false);
}
async function stopDictation() {
  dictationGeneration++; dictating = false; clearTimeout(dictationTimer); dictationTimer = null;
  body.classList.remove('dictating'); await setDirectVoice(false); composer?.refresh();
}
async function toggleDictation() {
  if (dictating) return stopDictation();
  if (callActive) await setVoiceCall(false);
  speaker.cancel(); dictating = true; const gen = ++dictationGeneration; body.classList.add('dictating');
  dictationTimer = setTimeout(() => { if (dictating && gen === dictationGeneration) { stopDictation(); toast('本次转文字已结束，未发送消息'); } }, 45000);
  try { const ok = await setDirectVoice(true); if (gen !== dictationGeneration) { voice.disable(); return; } if (!ok) await stopDictation(); }
  catch (e) { if (gen === dictationGeneration) { await stopDictation(); toast(e.message); } }
}
mic.addEventListener('click', () => { if (voice.mode !== 'ptt') toggleDictation(); });
mic.addEventListener('pointerdown', (e) => {
  if (voice.mode !== 'ptt') return;
  e.preventDefault();
  mic.setPointerCapture(e.pointerId);
  mic.classList.add('ptt-active');
  voice.pttStart();
});
for (const ev of ['pointerup', 'pointercancel']) {
  mic.addEventListener(ev, () => {
    if (voice.mode !== 'ptt' || !mic.classList.contains('ptt-active')) return;
    mic.classList.remove('ptt-active');
    voice.pttEnd();
  });
}

// ---------------------------------------------------------------- 人脸跟随
let face = null;
async function setFaceFollow(on) {
  setSetting('faceFollow', on);
  $('#set-face').checked = on;
  const status = $('#face-status');
  if (!on) {
    face?.stop();
    live.face = null;
    status.textContent = '';
    return;
  }
  try {
    const { FaceTracker } = await import('./perception/faceTracker.js');
    face ??= new FaceTracker({
      onAngles: (a) => {
        if (!a) return;
        const t = followTarget(a);
        const had = live.face;
        live.face = t.inRange ? t : null;
        // 摄像头看到你回来了（之前 10 分钟以上没看到人）
        if (live.face) {
          if (!had && live.faceGoneAt && Date.now() - live.faceGoneAt >= 10 * 60_000) greetOnReturn({ awayMs: Date.now() - live.faceGoneAt, reason: 'face' });
          live.faceGoneAt = 0;
        } else if (had) live.faceGoneAt = Date.now();
      },
      onStatus: (s) => {
        status.textContent = {
          starting: '正在启动摄像头与本地模型…',
          tracking: '跟随中（15fps，本机推理）',
          degraded: '推理较慢，已降至 10fps / 320×240',
          lost: '未检测到人脸',
          off: ''
        }[s] ?? '';
        if (s === 'lost') { live.face = null; toast('未检测到人脸'); }
      }
    });
    await face.start();
  } catch (err) {
    face?.stop();
    setSetting('faceFollow', false);
    $('#set-face').checked = false;
    status.textContent = '';
    toast(err.name === 'NotAllowedError' ? '摄像头权限被拒绝' : `人脸跟随不可用：${err.message}`);
  }
}


// ---------------------------------------------------------------- 右侧面板
const PANES = ['sessions', 'workspace', 'knowledge', 'mind', 'skills', 'models', 'system', 'settings'];
let currentPane = null;
const narrow = matchMedia('(max-width: 860px)');
function showPanel(name, { toggle = false } = {}) {
  noteAction(`打开面板：${name}`);
  if (toggle && name === currentPane && (narrow.matches ? body.classList.contains('side-open') : !body.classList.contains('side-closed'))) {
    body.classList.add('side-closed');
    body.classList.remove('side-open');
    currentPane = null;
    return;
  }
  currentPane = name;
  body.classList.remove('wb-connections');
  body.classList.remove('side-closed');
  body.classList.add('side-open');
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  for (const b of document.querySelectorAll('.rail-btn')) b.classList.toggle('active', b.dataset.panel === name);
  try { localStorage.setItem('jarvis.pane', name); } catch { /* ignore */ }
  if (name === 'workspace') panels.refreshFiles();
  if (name === 'knowledge') panels.refreshKb();
  if (name === 'mind') panels.refreshMind();
  if (name === 'models') { panels.refreshModels(); voicePanel.render(); localModels.refresh(); routingPanel.render(); }
  if (name === 'skills') { skillsPanel.refresh(); mcpPanel.refresh(); }
  if (name === 'sessions') sessionsPanel?.refresh();
  if (name === 'system') schedulesPanel?.refresh();
  if (name === 'settings') renderHabits();
  dispatchEvent(new CustomEvent('jarvis:panel', { detail: name })); // 面板打开时各自刷新（如服务器模式的网络耗时）
}
for (const b of document.querySelectorAll('.rail-btn')) b.addEventListener('click', () => showPanel(b.dataset.panel, { toggle: true }));
for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => showPanel(b.dataset.open));

/** 模型分工面板（下面创建；配置变化时刷新） */
let routingPanel = null;
const panels = initPanels({
  toast: (t) => toast(t),
  settings,
  getGateway: () => gateway,
  searchFetch: () => fetchViaGateway(),
  getHistory: () => history,
  onConfigChange: (cfg) => { llmConfig = cfg; updateModelLabels(); syncMemoryEngine(); updateOrbitStatus(); routingPanel?.render(); pushConfigToServer(); },
  onReflect: () => reflectNow({ manual: true }),
  onAutoMemory: (on) => { setSetting('autoMemory', on); if (!on) clearTimeout(reflectTimer); },
});
const voicePanel = initVoicePanel({ panels, speaker, getGateway: () => gateway });
routingPanel = initRoutingPanel({
  getConfig: () => panels.config,
  patchConfig: (fn) => panels.patchConfig(fn),
  getGateway: () => gateway,
  toast: (t) => toast(t)
});
const modelPicker = initModelPicker({
  getConfig: () => panels.config,
  patchConfig: (fn) => panels.patchConfig(fn),
  getGateway: () => gateway,
  toast: (t) => toast(t),
  openSettings: () => showPanel('models')
});
$('#model-chip').addEventListener('click', () => modelPicker.open());
// 聊天模型误选成了画图模型（如 gpt-image-2）：自动挪到“画图用”，聊天换回能对话的模型
{
  const was = modelOf(panels.config);
  const fixed = repairChatModel(panels.config);
  if (fixed) { panels.patchConfig(() => fixed); toast(`“${was}”不能用来聊天${fixed.imageModel === was ? '，已改为画图用' : fixed.videoModel === was ? '，已改为视频用' : ''}；聊天用 ${fixed.models[fixed.provider] || '默认模型'}`); }
}
const localModels = initLocalModelsPanel({
  getGateway: () => gateway,
  getConfig: () => panels.config,
  useModel: (p, m) => panels.useModel(p, m),
  patchConfig: (fn) => panels.patchConfig(fn),
  toast: (t) => toast(t)
});
const mcpPanel = initMcpPanel({
  getGateway: () => gateway,
  toast: (t) => toast(t),
  onChange: (servers) => {
    const ready = servers.filter((x) => x.status === 'ready');
    $('#hud-mcp').textContent = ready.length ? `${ready.length} 个 · ${ready.reduce((n, x) => n + x.tools.length, 0)} 工具` : '未连接';
  }
});
const skillsPanel = initSkillsPanel({
  toast: (t) => toast(t),
  onUse: (name) => {
    $('#prompt').value = `/${name} `;
    if (body.classList.contains('workbench')) body.classList.add('side-closed');
    if (narrow.matches) body.classList.remove('side-open');
    $('#prompt').focus();
  },
  onChange: (list) => {
    panels.refreshMind();
    $('#hud-skills').textContent = `${list.filter((p) => p.enabled).length} 个启用`;
  }
});

// ---------------------------------------------------------------- 欢迎页、HUD 时钟、命令面板
const QUICK = [
  { icon: '⌘', title: '写一个网页', desc: '写代码并在工作区实时预览', prompt: '帮我写一个网页' },
  { icon: '▤', title: '做汇报 PPT', desc: '结论先行，一页一个观点', prompt: '做一个PPT' },
  { icon: '⌕', title: '深度调研', desc: '多轮搜索、读网页，写带出处的报告', fill: '深度调研：' },
  { icon: '▦', title: '分析表格', desc: '上传 Excel / CSV，找趋势与异常', upload: true },
  { icon: '◎', title: '导入知识库', desc: 'PDF、Word、PPT 都能读', panel: 'knowledge' },
  { icon: 'ϟ', title: '安装技能', desc: '一键获得新的做事方法', panel: 'skills' },
  { icon: '◉', title: '记住偏好', desc: '告诉我你的习惯，越用越懂你', prompt: '记住我喜欢简洁的回答' }
];
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}
let homeView;
const homeWeather=createWeatherClient({direct:MOBILE||STANDALONE});
function renderWelcome() {
  if (document.querySelector('#transcript .msg')) return;
  if(COMPACT){
    homeView?.destroy();document.querySelector('#transcript .wy-home')?.remove();
    homeView=createHome({weather:homeWeather,send,fill:text=>{$('#prompt').value=text;$('#prompt').focus();},openPanel:showPanel});
    $('#transcript').prepend(homeView.root);$('#transcript').scrollTop=0;return;
  }
  const cards = QUICK.map((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quick';
    b.innerHTML = '<span class="quick-icon"></span><span class="quick-title"></span><span class="quick-desc"></span>';
    b.querySelector('.quick-icon').textContent = q.icon;
    b.querySelector('.quick-title').textContent = q.title;
    b.querySelector('.quick-desc').textContent = q.desc;
    b.addEventListener('click', () => {
      if (q.prompt) send(q.prompt);
      else if (q.fill) { $('#prompt').value = q.fill; $('#prompt').focus(); }
      else if (q.panel) showPanel(q.panel);
      else if (q.upload) $('#btn-attach')?.click();
    });
    return b;
  });
  const w = document.createElement('div');
  w.className = 'welcome';
  const h = document.createElement('h1');
  h.textContent = `${greeting()}，我是未央`;
  const p = document.createElement('p');
  p.textContent = narrow.matches ? '交给我一个任务，或者试试下面这些。输入 / 可以点名技能。' : '交给我一个任务，或者试试下面这些。输入 / 可以点名技能，Ctrl + K 搜索任何操作。';
  const grid = document.createElement('div');
  grid.className = 'quick-grid';
  grid.append(...cards);
  if (COMPACT) {
    // 手机首页：会浮动的云朵 + 问候 + 日期，下面是“未央为你准备了”三条，可以换一换
    const hero = document.createElement('div');
    hero.className = 'welcome-hero';
    hero.setAttribute('aria-hidden', 'true');
    hero.innerHTML = '<i class="halo"></i><i class="halo b"></i><i class="cloud"></i>';
    const d = new Date();
    const pill = document.createElement('div');
    pill.className = 'welcome-pill';
    pill.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]} · 有事交给我`;
    w.append(hero, h, pill, picksCard());
  } else w.append(h, p, grid);
  $('#transcript').prepend(w);
}

// 手机首页的推荐：每次显示 3 条，点“换一换”轮换
const PICKS = [
  { t: '今天有哪些重点新闻', k: 'news', h: 210, prompt: '今天的重点新闻' },
  { t: '明天天气怎么样，要不要带伞', k: 'sun', h: 35, prompt: '明天天气怎么样，要带伞吗' },
  { t: '帮我写一份本周工作周报', k: 'doc', h: 255, fill: '帮我写一份本周工作周报，本周做了：' },
  { t: '做一个汇报 PPT', k: 'ppt', h: 15, prompt: '做一个PPT' },
  { t: '深度调研一个话题，带出处', k: 'search', h: 190, fill: '深度调研：' },
  { t: '分析一个 Excel 表格', k: 'table', h: 150, upload: true },
  { t: '写一个实时时钟网页', k: 'code', h: 280, prompt: '写一个实时时钟网页' },
  { t: '把一段话翻译成地道的英文', k: 'chat', h: 320, fill: '把这段话翻译成地道的英文：' },
  { t: '给我装一个新技能', k: 'spark', h: 45, panel: 'skills' },
  { t: '导入资料做成知识库', k: 'book', h: 170, panel: 'knowledge' }
];
const PICK_ICON = {
  news: '<path d="M5 5h11v14H6a1 1 0 0 1-1-1z"/><path d="M16 9h3v9a1 1 0 0 1-1 1h-2M8 9h5M8 12h5M8 15h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 15h5M10 18h3"/>',
  ppt: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 17v3M8 20h8M8 13l3-3 2 2 3-3"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  table: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4M13 6l-2 12"/>',
  chat: '<path d="M5 6h14v9H10l-4 3v-3H5z"/><path d="M9 10h6"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5z"/>',
  book: '<path d="M4 5c3-1 6-1 8 1v14c-2-2-5-2-8-1zM20 5c-3-1-6-1-8 1v14c2-2 5-2 8-1z"/>'
};
let pickAt = 0;
function picksCard() {
  const card = document.createElement('section');
  card.className = 'picks';
  card.innerHTML = '<div class="picks-head"><b><svg viewBox="0 0 24 24"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>未央为你准备了</b><button type="button" class="picks-more"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4M5 3v4h4M19 21v-4h-4"/></svg>换一换</button></div><div class="picks-list"></div>';
  const list = card.querySelector('.picks-list');
  const fill = () => {
    list.replaceChildren(...[0, 1, 2].map((i) => {
      const q = PICKS[(pickAt + i) % PICKS.length];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick';
      b.style.setProperty('--h', q.h);
      b.innerHTML = `<span class="pick-icon"><svg viewBox="0 0 24 24">${PICK_ICON[q.k]}</svg></span><span class="pick-t"></span><svg class="pick-go" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`;
      b.querySelector('.pick-t').textContent = q.t;
      b.addEventListener('click', () => {
        if (q.prompt) send(q.prompt);
        else if (q.fill) { $('#prompt').value = q.fill; $('#prompt').focus(); }
        else if (q.panel) showPanel(q.panel);
        else if (q.upload) $('#btn-attach')?.click();
      });
      return b;
    }));
  };
  card.querySelector('.picks-more').addEventListener('click', () => {
    pickAt = (pickAt + 3) % PICKS.length;
    list.classList.remove('swap'); void list.offsetWidth; list.classList.add('swap');
    fill();
  });
  fill();
  return card;
}

const WEEK = '日一二三四五六';
function tickClock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('#hud-time').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('#hud-date').textContent = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} · 星期${WEEK[d.getDay()]}`;
}
tickClock();
setInterval(tickClock, 1000);

const PANE_TITLE = { sessions: '对话', workspace: '工作区', knowledge: '知识库', mind: '记忆与进化', skills: '技能', models: '模型与声音', system: '系统与定时任务', settings: '设置' };
const palette = initPalette({
  commands: () => {
    const toggle = (id, title) => ({ id: `t-${id}`, group: '开关', title: `${$(`#${id}`).checked ? '关闭' : '开启'}${title}`, run: () => $(`#${id}`).click() });
    return [
      ...QUICK.filter((q) => q.prompt || q.fill).map((q) => ({ id: `q-${q.title}`, group: '常用任务', title: q.title, hint: q.desc, run: () => { if (q.prompt) send(q.prompt); else { $('#prompt').value = q.fill; $('#prompt').focus(); } } })),
      ...skillsPanel.installed.filter((p) => p.enabled).map((p) => ({ id: `s-${p.name}`, group: '技能', title: `/${p.name}`, hint: p.description, run: () => { $('#prompt').value = `/${p.name} `; $('#prompt').focus(); } })),
      ...PANES.map((p, i) => ({ id: `p-${p}`, group: '面板', title: `打开${PANE_TITLE[p]}`, keys: `Alt ${i + 1}`, run: () => showPanel(p) })),
      toggle('set-tts', '打字也朗读'),
      ...(!mic.hidden ? [toggle('set-voice', '直接对话'), toggle('set-wake', '唤醒词')] : []),
      toggle('set-face', '人脸跟随'),
      { id: 'focus', group: '开关', title: body.classList.contains('focus-view') ? '退出专注视图' : '进入专注视图', keys: 'Alt F', run: () => $('#btn-focus').click() },
      { id: 'theme', group: '开关', title: document.documentElement.dataset.theme === 'light' ? '切换为夜间界面' : '切换为白天界面', run: () => $('#btn-theme').click() },
      { id: 'team', group: '操作', title: '交给团队完成…', hint: '规划员拆步骤，多个角色分工执行，审核员把关', run: () => { $('#prompt').value = '/团队 '; $('#prompt').focus(); } },
      { id: 'new', group: '操作', title: '新对话', hint: '开始一段新对话（之前的对话保存在“对话”面板里）', keys: 'Ctrl Shift O', run: () => newSession() },
      { id: 'sessions', group: '操作', title: '历史对话', hint: '查看、搜索之前的对话', run: () => showPanel('sessions') },
      { id: 'stop', group: '操作', title: '打断 / 停止当前任务', keys: 'Esc', run: () => interrupt() },
      { id: 'preview-voice', group: '操作', title: '试听当前声音', run: () => speaker.preview() },
      { id: 'fullscreen', group: '操作', title: '全屏', run: () => $('#btn-fullscreen').click() }
    ];
  }
});
palette.onFallback = (text) => send(text);
$('#btn-palette').addEventListener('click', () => palette.open());
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $('#palette-kbd').textContent = '⌘K';
$('#set-quality').addEventListener('change', (e) => {
  setSetting('quality', e.target.value);
  applyFpsCap();
});

function setFocusView(on) {
  setSetting('focusView', on);
  body.classList.toggle('focus-view', on);
  $('#set-focus').checked = on;
  $('#btn-focus').setAttribute('aria-pressed', String(on));
  applyFpsCap();
  updateStageMode();
}
$('#btn-focus').addEventListener('click', () => setFocusView(!settings.focusView));
$('#btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});


$('#set-face').addEventListener('change', (e) => setFaceFollow(e.target.checked));
$('#set-voice').addEventListener('change', (e) => callActive && !e.target.checked ? setVoiceCall(false) : setDirectVoice(e.target.checked));
$('#set-wake').addEventListener('change', (e) => { setSetting('wakeWord', e.target.checked); wake.sleep(); });
$('#set-tts').addEventListener('change', (e) => {
  setSetting('readTyped', e.target.checked);
  if (!e.target.checked) speaker.cancel();
});
// 自动更新：顶栏显示下载进度 / “重启更新”（电脑）/ “安装新版本”（手机）/ “去下载”
const APP_UPDATER = globalThis.__jarvisAppUpdater; // 手机 App（mobile/appUpdate.js）
if (DESKTOP?.onUpdate || APP_UPDATER) {
  const pill = $('#update-pill');
  const note = $('#update-note');
  const show = (u) => {
    $('#row-version').hidden = false;
    $('#app-version').textContent = `当前 ${u.current ?? DESKTOP?.version ?? ''}`;
    pill.hidden = !['downloading', 'ready', 'available'].includes(u.state);
    pill.dataset.state = u.state;
    pill.style.setProperty('--p', `${u.state === 'downloading' ? u.percent ?? 0 : 0}%`); // 下载进度条
    pill.textContent = u.state === 'downloading' ? `新版本下载中 ${u.percent ?? 0}%` : u.state === 'ready' ? (u.mobile ? `安装新版本 ${u.version}` : `重启以更新到 ${u.version}`) : u.state === 'available' ? (u.mobile ? `新版本 ${u.version} · 下载` : `新版本 ${u.version} · 去下载`) : '';
    note.textContent = u.hint || ({
      checking: '正在检查…',
      latest: '已经是最新版本',
      downloading: u.mobile ? `正在后台下载 ${u.version ?? ''}（约 11 MB）` : `正在后台下载 ${u.version ?? ''}（只下载改动的部分）`,
      ready: u.mobile ? `${u.version} 已下载好，点顶栏的“安装新版本”，在系统界面点“安装”即可（对话和设置都保留）` : `${u.version} 已下载好，点顶栏的“重启以更新”或下次启动时自动安装`,
      available: u.mobile ? `有新版本 ${u.version}。正在用流量，点顶栏按钮下载（约 11 MB）` : `有新版本 ${u.version}。${u.manual ? '这个版本（免安装版 / Mac）不能自动安装，请到下载页下载' : ''}`,
      error: `检查更新失败：${u.error ?? ''}`,
      dev: u.mobile ? '调试版，不检查更新' : '从源码运行，不检查更新'
    }[u.state] ?? '');
    if (u.state === 'ready' && !show.toldReady) { show.toldReady = true; toast(u.mobile ? `新版本 ${u.version} 已下载好，点顶栏“安装新版本”即可更新` : `新版本 ${u.version} 已下载好，点顶栏按钮重启即可更新`); }
  };
  if (APP_UPDATER) {
    // 上次闪退的记录（mobile/boot.js 存的）：显示在版本这一栏，方便截图
    let crash = '';
    try { crash = localStorage.getItem('jarvis.lastCrash') || ''; } catch { /* 读不到就不显示 */ }
    if (crash) {
      const p = Object.assign(document.createElement('p'), { className: 'muted small', textContent: `最近一次异常退出：\n${crash.slice(-800)}` });
      p.style.whiteSpace = 'pre-line';
      $('#row-version').append(p);
    }
    APP_UPDATER.onUpdate(show);
    show(APP_UPDATER.state);
    APP_UPDATER.start();
    pill.addEventListener('click', () => APP_UPDATER.act().catch((e) => toast(e.message)));
    $('#btn-update-check').addEventListener('click', () => APP_UPDATER.check().catch((e) => toast(e.message)));
  } else {
    DESKTOP.onUpdate(show);
    DESKTOP.invoke('updateState').then((u) => show(u.packaged ? u : { ...u, state: 'dev' })).catch(() => {});
    pill.addEventListener('click', () => {
      if (pill.dataset.state === 'ready') DESKTOP.invoke('updateInstall');
      else if (pill.dataset.state === 'available') DESKTOP.invoke('openReleases');
    });
    $('#btn-update-check').addEventListener('click', () => DESKTOP.invoke('updateCheck').then(show).catch((e) => toast(e.message)));
  }
}

// 界面明暗
const lightMql = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = resolveTheme(settings.theme, { prefersLight: lightMql.matches });
  document.documentElement.dataset.theme = t;
  for (const b of document.querySelectorAll('#set-theme button')) b.setAttribute('aria-checked', String(b.dataset.v === settings.theme));
  $('#btn-theme').title = `${t === 'light' ? '白天' : '夜间'}界面（${THEMES[settings.theme]}）· 点击切换`;
}
function setTheme(mode) { setSetting('theme', mode); applyTheme(); }
// 桌面版：右上角系统按钮的底色 / 图标色 / 高度跟随顶栏
function syncTitleBar() {
  if (!DESKTOP?.setTitleBar) return;
  requestAnimationFrame(() => {
    if (document.body.classList.contains('workbench')) { dispatchEvent(new Event('jarvis:sync-titlebar')); return; }
    const css = getComputedStyle(document.body);
    const color = css.getPropertyValue('--titlebar').trim();
    const symbolColor = css.getPropertyValue('--titlebar-symbol').trim();
    const height = 32;
    DESKTOP.setTitleBar({ color: '#ffffff', symbolColor: '#72727d', height }).catch(() => {});
  });
}
new MutationObserver(syncTitleBar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
addEventListener('load', syncTitleBar);
applyTheme();
syncTitleBar();
lightMql.addEventListener?.('change', applyTheme);
setInterval(() => { if (settings.theme === 'time') applyTheme(); }, 60_000);
$('#btn-theme').addEventListener('click', () => {
  setTheme(toggled(document.documentElement.dataset.theme));
  toast(document.documentElement.dataset.theme === 'light' ? '已切换为白天界面' : '已切换为夜间界面');
});
for (const b of document.querySelectorAll('#set-theme button')) b.addEventListener('click', () => setTheme(b.dataset.v));

// 主动问好 / 桌面背景
$('#set-greet').checked = settings.greetOnReturn !== false;
$('#set-greet').addEventListener('change', (e) => setSetting('greetOnReturn', e.target.checked));
if (DESKTOP) {
  $('#row-wallpaper').hidden = false;
  DESKTOP.invoke('wallpaperState').then((r) => { $('#set-wallpaper').checked = r.on; }).catch(() => {});
  $('#set-wallpaper').addEventListener('change', async (e) => {
    try {
      const r = await DESKTOP.invoke('setWallpaper', { on: e.target.checked });
      toast(r.on ? '已开启全息陪伴桌面：可以摸摸未央，或直接打字聊天' : '已关闭桌面背景');
    } catch (err) { toast(err.message); e.target.checked = false; }
  });
}
if (DESKTOP) {
  $('#row-habits').hidden = false;
  DESKTOP.invoke('habitTrackingState').then((r) => { $('#set-habits').checked = r.on; }).catch(() => {});
  renderHabits();
  $('#set-habits').addEventListener('change', async (e) => {
    try {
      const r = await DESKTOP.invoke('setHabitTracking', { on: e.target.checked });
      toast(r.on ? '开始学习你的使用习惯：只记录前台程序名和时间，数据只在这台电脑上' : '已暂停习惯学习');
    } catch (err) { toast(err.message); e.target.checked = false; }
  });
  $('#btn-habits-memorize').addEventListener('click', async () => { await habits.flush(); await memorizeHabits({ manual: true }); renderHabits(); });
  $('#btn-habits-clear').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '确认清除'; setTimeout(() => { b.dataset.armed = ''; b.textContent = '清除记录'; }, 3000); return; }
    await habits.clear();
    b.dataset.armed = ''; b.textContent = '清除记录';
    renderHabits();
    toast('已清除习惯记录（已写进记忆的习惯可在“记忆与进化”里删除）');
  });
}
for (const b of document.querySelectorAll('#set-team button')) {
  b.setAttribute('aria-checked', String(b.dataset.v === settings.teamMode));
  b.addEventListener('click', () => {
    setSetting('teamMode', b.dataset.v);
    for (const x of document.querySelectorAll('#set-team button')) x.setAttribute('aria-checked', String(x === b));
  });
}
for (const b of document.querySelectorAll('#set-vad button')) {
  b.addEventListener('click', () => {
    setSetting('vadSensitivity', b.dataset.v);
    voice.setSilenceMs(SILENCE_BY_SENSITIVITY[b.dataset.v]);
    for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x === b));
  });
}
$('#set-emotion').addEventListener('change', (e) => applyEmotionOverride(e.target.value));
$('#set-focus').addEventListener('change', (e) => setFocusView(e.target.checked));
$('#set-motion').addEventListener('change', (e) => {
  setSetting('reducedMotion', e.target.value);
  applyMotionMode();
});

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, Math.max(2600, String(text).length * 110));
}
globalThis.__jarvisToast = toast; // 手机原生保存文件时的进度提示

// ---------------------------------------------------------------- 编辑重发 / 重新生成
/**
 * 回到某句话之前重新来：
 *   edit  把你的这句话放回输入框，改好再发（这句话和它后面的都去掉）
 *   retry 去掉这条回答（和它后面的），把它前面那句话重新发一次
 */
async function rewindAndResend(kind, text) {
  if (active) { toast('等这一轮做完再改'); return; }
  const said = (m) => String(m.content).replace(/\n*\[已上传到工作区：[^\]]+\]$/, '').trim();
  let at = -1;
  if (kind === 'edit') at = history.findLastIndex((m) => m.role === 'user' && said(m) === text.trim());
  else {
    const reply = history.findLastIndex((m) => m.role === 'assistant' && stripEmotionTags(m.content).trim() === text.trim());
    if (reply > 0) for (let i = reply - 1; i >= 0; i--) if (history[i].role === 'user') { at = i; break; }
  }
  if (at < 0) { toast('找不到这条消息（可能已经翻页或改过）'); return; }
  const later = history.length - at - 1;
  let ok = true;
  if (later > 1) { try { ok = globalThis.confirm(`这句话后面还有 ${later} 条消息，会一起去掉。继续吗？`); } catch { /* 不支持弹窗就直接继续 */ } }
  if (!ok) return;
  const question = said(history[at]);
  if (server) {
    try { await server.truncateSession(session.id, at); } catch (e) { toast(`没改成：${e.message}`); return; }
  }
  history.splice(at);
  session.updatedAt = Date.now();
  // 本机模式下截成空的：空对话不会存盘，旧记录会留着；先删掉，重新发的时候再存
  if (!server && !history.length) sessionsApi.remove(session.id).catch(() => {}); else persistSession();
  replayTranscript();
  if (kind === 'edit') {
    prompt.value = question;
    autosize();
    prompt.focus();
    toast('改好后点发送');
  } else send(question);
}

// ---------------------------------------------------------------- 每条消息下面的“引用 / 朗读”（复制在 transcript.js 里直接做）
let readingBtn = null;
transcript.onAction = (kind, text, btn) => {
  if (kind === 'quote') {
    // 引用：把这条的开头放进输入框（“> ……”），接着打字问
    const plainText = toPlainText(text).replace(/\s+/g, ' ').trim();
    const excerpt = plainText.length > 100 ? `${plainText.slice(0, 100)}…` : plainText;
    prompt.value = `> ${excerpt}\n${prompt.value.replace(/^> .*\n/, '')}`;
    autosize();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    return;
  }
  if (kind === 'edit' || kind === 'retry') { rewindAndResend(kind, text); return; }
  if (kind === 'speak') {
    // 朗读这一条：再点一下停；只念正文，代码和表格不念
    const again = readingBtn === btn && speaker.speaking;
    speaker.cancel();
    if (readingBtn) { setActionIcon(readingBtn, 'speak'); readingBtn.removeAttribute('aria-pressed'); readingBtn = null; }
    if (again) return;
    speaker.unlock();
    noteAction('朗读一条回答');
    const chunker = new SentenceChunker();
    for (const s of [...chunker.push(toSpeech(text)), ...chunker.flush()]) speaker.speak(s);
    readingBtn = btn;
    setActionIcon(btn, 'stop');
    btn.setAttribute('aria-pressed', 'true');
    const watch = setInterval(() => {
      if (readingBtn !== btn || (!speaker.speaking && !speaker.pending)) {
        clearInterval(watch);
        if (readingBtn === btn) { setActionIcon(btn, 'speak'); btn.removeAttribute('aria-pressed'); readingBtn = null; }
      }
    }, 600);
  }
};

// ---------------------------------------------------------------- 恢复上次的设置
$('#set-tts').checked = settings.readTyped;
$('#set-wake').checked = settings.wakeWord;
$('#set-quality').value = settings.quality;
dashboard.setTurns(history.filter((m) => m.role === 'user').length);
$('#set-motion').value = settings.reducedMotion;
for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x.dataset.v === settings.vadSensitivity));
setFocusView(settings.focusView);
applyEmotionOverride(settings.emotionOverride);
applyMotionMode();
// 摄像头 / 麦克风不随页面加载申请权限：上次开着的开关，只有在浏览器已授予权限（不会弹窗）时才自动恢复，
// 否则复位为关闭，等用户再次主动开启
async function restoreDevice(permission, key, enable) {
  if (!settings[key]) return;
  let granted = false;
  try {
    granted = (await navigator.permissions.query({ name: permission })).state === 'granted';
  } catch { /* 不支持查询该权限：按未授权处理 */ }
  if (granted) enable(true);
  else setSetting(key, false);
}
restoreDevice('camera', 'faceFollow', setFaceFollow);
// 兼容显示（上次界面崩过）时不自动开麦克风：先让界面稳稳打开，需要时再手动开
if (!mic.hidden && !(MOBILE && document.documentElement.classList.contains('safe-render'))) restoreDevice('microphone', 'directVoice', setDirectVoice);


// ---------------------------------------------------------------- 启动
updateModelLabels();
detectGateway();
panels.refreshMind();
let startPane = 'workspace';
try { startPane = localStorage.getItem('jarvis.pane') || startPane; } catch { /* ignore */ }
if (narrow.matches) body.classList.add('side-closed');
showPanel(PANES.includes(startPane) ? startPane : 'workspace');
if (narrow.matches) body.classList.remove('side-open');
setTask('idle');
renderWelcome();
syncMemoryEngine();
sessionsPanel = initSessionsPanel({
  getCurrentId: () => session.id,
  onOpen: (id) => openSession(id),
  onNew: () => newSession(),
  onDeleted: (id) => { if (id === session.id) switchTo(sessionsApi.create()); },
  settings,
  onSaveChange: (on) => {
    setSetting('saveSessions', on);
    if (on) persistSession();
    toast(on ? '对话会保存在本机，可在“对话”里找回' : '新的对话不再保存（已保存的不受影响）');
  }
});
// ---------------------------------------------------------------- 多设备同步（阿里云 OSS，端到端加密）
const syncController = createSyncController({
  storage,
  getGateway: () => gateway,
  loadConfig,
  saveConfig,
  beforeSync: () => habits.flush(),
  afterSync: async (r) => {
    if (r.memory?.changedLocal) { await habits.reload(); panels.refreshMind(); skillPacks.changed(); }
    if (r.config?.changedLocal) panels.reloadConfig();
    if (r.sessions?.changedLocal) {
      sessionsPanel.refresh();
      // 当前对话在另一台设备上接着聊过：没在回答时换成合并后的版本
      const fresh = !active && history.length ? await sessionsApi.get(session.id) : null;
      if (fresh && fresh.messages.length !== history.length) {
        session = fresh;
        history = session.messages;
        reflectFrom = history.length;
        replayTranscript();
      }
    }
  },
  onState: ({ state, result, error, manual }) => {
    syncPanel?.render();
    if (state === 'done' && !manual && Object.values(result).some((g) => g.pulled)) toast(`已从其他设备同步：${describeResult(result)}`);
    if (state === 'error' && !manual) console.warn('[同步]', error);
  }
});
const syncPanel = initSyncPanel({ controller: syncController, toast: (t) => toast(t) });
initServerPanel({ getLlmConfig: () => llmConfig, toast: (t) => toast(t), onConfigSaved: () => refreshServerModel(), onImported: () => { sessionsPanel?.refresh(); drawer?.refresh?.(); } });
syncController.start();

// 手机：底部菜单改成左侧抽屉（新对话 · 功能 · 历史对话）；面板全屏打开，左上角“返回对话”
let drawer = null;
if (COMPACT) {
  const icons = Object.fromEntries([...document.querySelectorAll('.rail-btn')].map((b) => [b.dataset.panel, b.querySelector('svg').outerHTML]));
  drawer = initDrawer({
    icons,
    onNew: () => { newSession(); closeSide(); },
    onOpenSession: (id) => { openSession(id); closeSide(); },
    onPanel: (name) => showPanel(name),
    listSessions: () => sessionsApi.list(),
    cachedSessions: () => sessionsApi.cachedList(),
    currentId: () => session.id,
    onRename: async (id, title) => {
      await sessionsApi.rename(id, title);
      if (id === session.id) { session.title = title; session.titleSet = true; showChatTitle(); }
      sessionsPanel?.refresh();
    },
    onPin: async (id, pinned) => { await sessionsApi.setPinned(id, pinned); if (id === session.id) session.pinned = pinned; sessionsPanel?.refresh(); },
    onExport: (id, kind) => exportSession(id, kind),
    searchContent: (q) => sessionsApi.searchContent(q),
    onDelete: async (id) => {
      await sessionsApi.remove(id);
      if (id === session.id) switchTo(sessionsApi.create());
      sessionsPanel?.refresh();
      toast('已删除');
    }
  });
  $('#btn-menu').hidden = false;
  $('#btn-menu').addEventListener('click', () => drawer.open());
  $('#btn-side-back').hidden = false;
  $('#btn-side-back').addEventListener('click', () => closeSide());
}
function closeSide() {
  body.classList.remove('side-open');
  currentPane = null;
}

schedulesPanel = initSchedulesPanel({
  toast: (t) => toast(t),
  runNow: async (s) => { if (schedulerBusy) { toast('有任务正在运行，稍后再试'); return; } schedulerBusy = true; try { const sess = await runScheduled(s); await openSession(sess.id); } finally { schedulerBusy = false; } },
  openSession: (id) => openSession(id)
});
setInterval(schedulerTick, 30_000);
setTimeout(schedulerTick, 4000);
// 旧版的单条对话流迁移成会话；最近 6 小时内的对话自动接着聊
(async () => {
  // 本地数据库打不开（比如另一个标签页还开着旧版、挡住了升级）：告诉用户，并且不做迁移，免得旧数据迁到临时存储里丢掉
  const problem = await storageProblem().catch(() => '');
  if (problem) { toast(problem); return; }
  if (settings.persistMemory) {
    await sessionsApi.migrateLegacy(loadMemory(storage)).catch(() => null);
    clearMemory(storage);
    setSetting('persistMemory', false);
  }
  const [recent] = await sessionsApi.list().catch(() => []);
  // 手机：上次 App 被关掉时有任务做到一半：回到那个对话接着做
  const left = MOBILE ? takePending(storage) : null;
  const leftSession = left && await sessionsApi.get(left.sessionId).catch(() => null);
  if(left&&(!leftSession||history.length))savePending(storage,left.sessionId,left);
  if (leftSession && !history.length) {
    await switchTo(leftSession);
    if(checkpointNeedsReview(left.checkpoint)) {
      savePending(storage,left.sessionId,left);
      const card=document.createElement('section');card.className='task-recovery';card.setAttribute('role','status');
      const note=document.createElement('p');note.textContent='上次退出时有操作的结果未确认，先核对再继续，避免重复执行。';
      const resume=document.createElement('button');resume.type='button';resume.textContent='核对并继续';resume.onclick=()=>{card.remove();send(resumeText(left));};
      const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='不再继续';dismiss.onclick=()=>{clearPending(storage,left.sessionId,left.turnId);card.remove();};
      card.append(note,resume,dismiss);$('#transcript').append(card);
    } else {
      toast('上次退出时任务还没做完，正在核对进度后继续');send(resumeText(left));
    }
    sessionsPanel.refresh();
    return;
  }
  // 手机：只有刷新页面、或界面崩溃后自动重开时才接回刚才的对话；从后台关掉再打开就停在首页
  const reopened = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' || globalThis.__jarvisRecentCrash === true;
  if ((!COMPACT || reopened) && recent && Date.now() - recent.updatedAt < 6 * 3600_000 && !history.length) {
    if (server) await openSession(recent.id); // 服务器的列表不带消息：先显示副本，再取完整的
    else await switchTo(recent);
  }
  sessionsPanel.refresh();
})();
agentMemory.maintain().catch(() => {});

// ---------------------------------------------------------------- 光核旁的建议标注
// 开机序列：每次打开（同一标签页内刷新不重复）播放约 2 秒的系统自检；减少动画时跳过
(async () => {
  let seen = false;
  try { seen = sessionStorage.getItem('jarvis.booted') === '1'; sessionStorage.setItem('jarvis.booted', '1'); } catch { /* 隐私模式 */ }
  const boot = $('#boot');
  if (seen || COMPACT || body.classList.contains('reduced-motion') || !boot) { boot?.remove(); return; }
  const all = await agentMemory.listAll().catch(() => null);
  const lines = [
    ['神经粒子核心', `${lowEnd ? 6000 : 14000} 粒子`],
    ['长期记忆', all ? `${all.memories.length} 条` : '在线'],
    ['习得技能 / 教训', all ? `${all.skills.length} / ${all.lessons.length}` : '在线'],
    ['对话历史', `${(await sessionsApi.list().catch(() => [])).length} 段`],
    ['模型链路', displayName(llmConfig)],
    ['系统', '全部就绪']
  ];
  $('#boot-lines').replaceChildren(...lines.map(([k, v], i) => {
    const d = document.createElement('div');
    d.style.animationDelay = `${150 + i * 210}ms`;
    d.textContent = `> ${k} `;
    const b = document.createElement('b');
    b.textContent = v;
    d.append(b);
    return d;
  }));
  setTimeout(() => boot.classList.add('out'), 1900);
  setTimeout(() => boot.remove(), 2500);
})();

// 有对话时舞台收成迷你状态条（桌面版），给对话留空间；点一下展开 / 收起
function updateStageMode() {
  // 工作台的“工作室”视图要大舞台；“对话”视图里舞台隐藏，迷你模式只为把建议放到输入框上方
  const mini = !COMPACT && body.classList.contains('has-convo') && !settings.stageOpen && !body.classList.contains('focus-view') && !body.classList.contains('wb-studio');
  const label = $('#btn-stage-toggle span');
  if (label) label.textContent = settings.stageOpen ? '收起' : '展开';
  body.classList.toggle('stage-mini', mini); // 工作台切到“工作室”时会自己去掉这个类，所以用变量记上一次的状态
  if (mini === stageMiniWas) return;
  stageMiniWas = mini;
  callouts?.relocate?.();
}
function setStageOpen(open) { setSetting('stageOpen', open); updateStageMode(); }
addEventListener('resize', () => updateStageMode()); // 工作台切换“对话 / 工作室”时会发 resize
new MutationObserver(() => {
  body.classList.toggle('has-convo', Boolean(document.querySelector('#transcript .msg')));
  updateStageMode();
}).observe($('#transcript'), { childList: true });
$('#btn-stage-toggle').addEventListener('click', (e) => { e.stopPropagation(); setStageOpen(!settings.stageOpen); });
$('#stage-wrap').addEventListener('click', (e) => { if (body.classList.contains('stage-mini') && !e.target.closest('button, a, .callout')) setStageOpen(true); });

orbit = COMPACT ? null : initOrbitHud({ root: $('#stage-wrap'), getAnchor: () => stage?.anchor?.() ?? null, reducedMotion: () => body.classList.contains('reduced-motion') });
updateOrbitStatus();
orbit?.think('系统就绪 · 粒子核心在线');
/** 桌面版：大舞台时建议在光核旁边，迷你状态条时改到输入框上方；两边接口一样，这里按当前模式转发 */
function dualSuggestions(full, chips, useChips) {
  let items = [];
  const cur = () => (useChips() ? chips : full);
  return {
    set(next) { items = next || []; (useChips() ? full : chips).retract(); cur().set(items); },
    show: () => cur().show(),
    retract() { full.retract(); chips.retract(); },
    get items() { return cur().items; },
    get visible() { return cur().visible; },
    pick: (i) => cur().pick(i),
    relocate() {
      const wasVisible = full.visible || chips.visible;
      full.retract();
      chips.retract();
      if (!items.length) return;
      cur().set(items);
      if (!wasVisible) cur().retract();
    }
  };
}
const suggestionOpts = {
  root: $('#stage-wrap'),
  getAnchor: () => stage?.anchor?.() ?? null,
  reducedMotion: () => body.classList.contains('reduced-motion'),
  // 鼠标移到建议上：光核的眼睛看向它
  onHover: (point, orb) => {
    if (point && orb) {
      const clamp = (v, m) => Math.max(-m, Math.min(m, v));
      live.glance = { yaw: clamp(((point.x - orb.x) / Math.max(orb.r, 1)) * 7, 26), pitch: clamp(((orb.y - point.y) / Math.max(orb.r, 1)) * 5, 14) };
      live.nextGlance = Infinity;
    } else {
      live.glance = { yaw: 0, pitch: 0 };
      live.nextGlance = now() + 1500;
    }
  },
  // 点击：光点飞进光核后，光核闪一下，再执行
  onPick: (item) => {
    live.pulse = 1;
    live.glance = { yaw: 0, pitch: 0 };
    live.nextGlance = now() + 1500;
    if (item.panel) { showPanel(item.panel); callouts?.show(); return; }
    setTimeout(() => send(item.prompt), 160);
  }
};
callouts = COMPACT ? initChips(suggestionOpts) : dualSuggestions(initCallouts(suggestionOpts), initChips(suggestionOpts), () => body.classList.contains('stage-mini'));
updateStageMode();
callouts.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills: false }));
if (!history.length) openingCallouts(false);

// ---------------------------------------------------------------- 键盘快捷键
//   Esc 打断   /  聚焦输入框   Alt+1..6 面板   Alt+F 专注视图   Alt+V 直接对话
//   Alt+O / Alt+H / Alt+W 光核 / 胸像 / 线框   按住空格：按下说话（降级模式、焦点不在输入框时）
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (interrupt()) { e.preventDefault(); toast('已打断'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyO') {
    e.preventDefault();
    newSession();
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.code;
    const n = /^Digit([1-8])$/.exec(k)?.[1];
    if (n) showPanel(PANES[n - 1]);
    else if (k === 'KeyF') setFocusView(!settings.focusView);
    else if (k === 'KeyV' && !mic.hidden) toggleDictation();
    else return;
    e.preventDefault();
    return;
  }
  if (typing(document.activeElement)) return;
  if (e.key === '/') {
    e.preventDefault();
    prompt.focus();
  } else if (e.code === 'Space' && voice.mode === 'ptt' && !e.repeat) {
    e.preventDefault();
    mic.classList.add('ptt-active');
    voice.pttStart();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && voice.mode === 'ptt' && mic.classList.contains('ptt-active')) {
    mic.classList.remove('ptt-active');
    voice.pttEnd();
  }
});

// 调试 / 自动化测试入口
window.__jarvis = {
  machine,
  speaker,
  get voice() { return voice; },
  get skills() { return skillsPanel; },
  get palette() { return palette; },
  get mcp() { return mcpPanel; },
  get localModels() { return localModels; },
  greetOnReturn,
  habits,
  memorizeHabits,
  director,
  get callouts() { return callouts; },
  schedulerTick,
  reflectNow,
  settings,
  live,
  get stage() { return stage; },
  get config() { return llmConfig; },
  get gateway() { return gateway; },
  panels,
  send,
  interrupt,
  showPanel,
  newSession,
  openSession,
  get sessionId() { return session.id; },
  sessionGet: (id) => sessionsApi.get(id),
  get quality() { return quality; },
  workspace: ws
};

// 工作台界面只用在电脑上；手机 App 保留自己的界面（底部输入、左侧抽屉菜单、整页面板）
if (!COMPACT) initWorkbench({showPanel,newSession,openSession,getSession:()=>session,getRunning:()=>active && !active.streamDone ? session.id : null,openFile:openInWorkspace});
mascots = initMascots();
companion = initCompanion({ send, startVoice: async () => { await setVoiceCall(true); return callActive; }, stopVoice: () => setVoiceCall(false), speak: text => { speaker.unlock(); speaker.speak(text); } });
const hologram = initHologramCompanion({send:async text=>{if(active)throw new Error('当前任务还在进行，请稍等完成后再发送。');await send(text);},onFull:()=>{body.classList.add('side-closed');body.classList.remove('side-open');document.querySelector('.wb-tabs button')?.click();},wallpaper:MOBILE?async()=>{const {registerPlugin}=await import('@capacitor/core');await registerPlugin('CompanionWallpaper').open();}:null});
const holoEntry=Object.assign(document.createElement('button'),{type:'button',className:'wy-hologram-entry',textContent:'✧ 全息陪伴'});
holoEntry.onclick=()=>{companion.close();hologram.open();};document.querySelector('.wy-companion-head span').after(holoEntry);
if(DESKTOP?.onWallpaperRequest)DESKTOP.onWallpaperRequest(async request=>{
  if(request.open){hologram.open();return;}
  if(!request.text)return;
  try{if(active)throw new Error('当前任务还在进行，请稍等完成后再发送。');await send(request.text);const reply=[...document.querySelectorAll('#transcript .msg.agent')].at(-1);const text=[...(reply?.querySelectorAll('.body')||[])].map(el=>el.textContent).join('\n');wp({say:text||'本轮已结束，可以打开完整对话查看结果。',requestId:request.id});}
  catch(error){wp({say:`这次没有完成：${error.message||error}`,requestId:request.id,error:true});}
});
if(MOBILE){import('@capacitor/core').then(({registerPlugin})=>{const plugin=registerPlugin('CompanionWallpaper');const check=async()=>{try{const r=await plugin.consumeOpen();if(r.open)hologram.open();}catch{}};check();document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});}).catch(()=>{});}
composer = initConversationComposer({cancelDictation:()=>stopDictation()});
initCompanionAppearance();
initRenderHealthPanel({ mobile: MOBILE, toast, onChange: () => { if (!active) replayTranscript(); } });

// 手机启动页：界面准备好、并且至少显示了 2 秒后淡出（太快一闪而过不像 App）
{
  const splash = document.getElementById('app-splash');
  if (splash) {
    const wait = MOBILE ? Math.max(0, 2000 - performance.now()) : 0;
    setTimeout(() => { splash.classList.add('out'); setTimeout(() => splash.remove(), 420); }, wait);
  }
}


// 本机其他未完成任务仍可查看，不因恢复最新一条而丢失。
if(MOBILE){
  const recovery=document.createElement('section');recovery.className='pending-recovery-list';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='btn';toggle.textContent='查看未完成任务';
  const list=document.createElement('div');list.hidden=true;recovery.append(toggle,list);document.querySelector('[data-pane="settings"]').append(recovery);
  const draw=()=>{list.replaceChildren();const rows=listPending(storage);if(!rows.length){list.textContent='没有保留的未完成任务。';return;}
    for(const rec of rows){const card=document.createElement('div'),title=document.createElement('p');title.textContent=rec.title||String(rec.text||'未完成任务').slice(0,40);
      const open=document.createElement('button');open.type='button';open.className='btn sm';open.textContent='查看并继续';open.onclick=async()=>{await openSession(rec.sessionId);prompt.value=resumeText(rec);autosize();showPanel('settings',{toggle:true});prompt.focus();};
      const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='btn ghost sm';dismiss.textContent='不再继续';dismiss.onclick=()=>{clearPending(storage,rec.sessionId,rec.turnId);draw();};card.append(title,open,dismiss);list.append(card);
    }
  };toggle.onclick=()=>{list.hidden=!list.hidden;if(!list.hidden)draw();};
}
