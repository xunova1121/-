/**
 * 贾维斯前端入口：状态管理层 + 渲染策略控制器。
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
import { EmotionMachine } from './core/emotionMachine.js';
import { EMOTION_PARAMS, EYE_SHAPES } from './core/emotions.js';
import { ParamTween } from './core/tween.js';
import { followTarget, smoothToward } from './core/faceMath.js';
import { SentenceChunker } from './core/sentenceChunker.js';
import { SILENCE_BY_SENSITIVITY } from './core/vadGate.js';
import { loadSettings, saveSettings, wantsReducedMotion } from './core/settings.js';
import { browserMetrics } from './api/browserMetrics.js';
import { runAgent } from './agent/agent.js';
import { createTools } from './agent/tools.js';
import * as ws from './agent/workspace.js';
import * as agentMemory from './agent/memory.js';
import { initPanels } from './ui/panels.js';
import { loadConfig, saveConfig, createAdapter, displayName, providerById, resolveVoice } from './llm/config.js';
import { initVoicePanel } from './ui/voicePanel.js';
import { matchWake, WakeWindow } from './core/wakeWord.js';
import { playCue } from './perception/voiceFx.js';
import { MetricsPoller } from './api/metrics.js';
import { subscribeAgentEvents } from './api/agentEvents.js';
import { Dashboard } from './ui/dashboard.js';
import { Transcript } from './ui/transcript.js';
import { Speaker } from './perception/speaker.js';
import { VoiceInput, speechRecognitionSupported } from './perception/voiceInput.js';
import { FIGURE, STANDALONE } from './config.js';
import { resolveQuality } from './core/quality.js';
import { loadMemory, saveMemory, clearMemory } from './core/memoryStore.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const now = () => performance.now();

// ---------------------------------------------------------------- 设置
const settings = loadSettings();
function setSetting(key, value) {
  settings[key] = value;
  saveSettings(settings);
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
  }
});
setInterval(() => machine.tick(), 100);

// ---------------------------------------------------------------- 实时量
const live = {
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
let stage = null;
let stageLoading = null;
let figurePromise = null;

function loadFigure() {
  // 单文件版：网格以 data URL 内联在页面里，元数据直接打包进脚本
  if (STANDALONE) {
    figurePromise ??= Promise.all([
      import('../public/models/bust-mesh.bin?inline').then((m) => fetch(m.default)).then((r) => r.arrayBuffer()),
      import('../public/models/bust.json').then((m) => m.default)
    ]).then(([mesh, meta]) => ({ mesh, meta }));
    return figurePromise;
  }
  figurePromise ??= Promise.all([
    fetch(FIGURE.mesh).then((r) => {
      if (!r.ok) throw new Error(`网格加载失败 ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(FIGURE.meta).then((r) => {
      if (!r.ok) throw new Error(`元数据加载失败 ${r.status}`);
      return r.json();
    })
  ]).then(([mesh, meta]) => ({ mesh, meta })).catch((err) => {
    figurePromise = null;
    throw err;
  });
  return figurePromise;
}
const DEG = Math.PI / 180;

function frame(dt, t) {
  const p = tween.update(t);

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
  if (stage || stageLoading) return stageLoading;
  stageLoading = (async () => {
    try {
      const [{ createStage }, figure] = await Promise.all([import('./render/stage.js'), loadFigure()]);
      if (wantsReducedMotion(settings, reducedMql)) return null; // 加载期间切换成了减少动画
      stage = createStage($('#stage'), {
        figure,
        lowEnd,
        onContextChange: (s, ms) => console.info(`[stage] WebGL 上下文${s === 'lost' ? '丢失' : `已恢复（${Math.round(ms)}ms）`}`)
      });
      stage.onFrame(frame);
      stage.setStyle(settings.look);
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
  quality = resolveQuality(settings.quality, { lowEnd, isMobile, focusView: settings.focusView });
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
  else poller.start();
  face?.setPaused(hidden);
});

// ---------------------------------------------------------------- 仪表
const dashboard = new Dashboard($('#dashboard'), {
  onEmotionPick: (v) => applyEmotionOverride(v)
});
const poller = new MetricsPoller({
  onData: (m) => dashboard.setMetrics(m),
  onError: () => dashboard.setDisconnected()
});
if (!document.hidden) poller.start();

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
      const url = local ? `${LOCAL_GATEWAY}/api/health` : '/api/health';
      const h = await (await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout?.(1500) })).json();
      if (!h?.ok) throw new Error('not a gateway');
      const found = !gateway;
      gateway = { origin: local ? LOCAL_GATEWAY : location.origin, keys: h.gatewayKeys ?? [], cors: Boolean(h.cors) };
      if (local && found) toast('已连接本机网关：所有服务商和自定义接口都可以用了');
    } catch {
      gateway = null;
    }
    panels.refreshModels();
    voicePanel.render();
    updateModelLabels();
  })().finally(() => { probing = null; });
  return probing;
}
// 单文件版：回到页面时再找一次网关（用户可能刚双击了 启动.bat）
if (STANDALONE || location.protocol === 'file:') {
  let last = 0;
  addEventListener('focus', () => { if (!gateway && Date.now() - last > 5000) { last = Date.now(); detectGateway(); } });
}

function updateModelLabels() {
  const name = displayName(llmConfig);
  $('#mode-text').textContent = name;
  $('#model-chip-text').textContent = name;
  $('#mode-pill').title = `当前模型：${name}${gateway ? '（经本机网关）' : ''}。点击切换`;
}

const metrics = () => (gateway ? fetch(`${gateway.origin}/api/local/metrics`).then((r) => r.json()) : browserMetrics());
// 网页读取只对完整版开放（单文件版跨域连网关时网关不提供 /api/fetch）
const fetchViaGateway = () => (gateway && !gateway.cors
  ? (url, init) => (url.startsWith('https://api.tavily.com/')
    ? fetch(`/api/llm/tavily/${url.slice('https://api.tavily.com/'.length)}`, init)
    : fetch(`/api/fetch?url=${encodeURIComponent(url)}`))
  : null);

// ---------------------------------------------------------------- 对话
const transcript = new Transcript($('#transcript'));
const storage = (() => { try { return localStorage; } catch { return null; } })();
const history = settings.persistMemory ? loadMemory(storage) : [];
function rememberTurn(role, content) {
  history.push({ role, content, ts: Date.now() });
  if (settings.persistMemory) saveMemory(history, storage);
}
let turns = 0;
let active = null; // { ctrl, streamDone, bubble }
const attachments = [];

const speaker = new Speaker({
  onStart: () => {
    voice.setSuppressed(true);
    body.classList.add('speaking');
  },
  onIdle: () => {
    if (wake.awake) wake.wake(); // 回答说完后重新计时，方便接着问
    voice.setSuppressed(false);
    body.classList.remove('speaking');
    if (active?.streamDone) finishTurn();
  },
  onBoundary: () => { live.boundaryAt = now(); },
  onError: (e) => toast(`${e.message}（这句先用浏览器声音朗读）`),
  getVoiceConfig: () => resolveVoice(llmConfig, gateway),
  getKeys: () => llmConfig.keys,
  getGateway: () => gateway
});
speaker.enabled = settings.speechOutput;

/** 打断（barge-in）：停止朗读并中止正在执行的任务 */
function interrupt() {
  const had = speaker.speaking || active;
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
function setTask(state, sub = '') {
  machine.setTaskState(state === 'listening' && !live.voiceListening ? 'listening' : state);
  dashboard.setTask(state, sub);
  const label = sub || TASK_LABEL[state] || state;
  $('#hud-task').textContent = label;
  $('#task-text').textContent = label;
  body.classList.toggle('generating', Boolean(active) && state !== 'done' && state !== 'error' && state !== 'idle');
  $('#mode-pill').classList.toggle('busy', Boolean(active) && state !== 'done');
}

function finishTurn() {
  if (!active) return;
  active = null;
  turns++;
  dashboard.setTurns(turns);
  setTask('done');
  setTimeout(() => { if (!active) setTask('idle'); }, 3000);
  panels.refreshMind();
}

/** 朗读只读正文：代码块（``` 包围的部分，包括还没闭合的）不读 */
function makeSpeech() {
  const chunker = new SentenceChunker();
  let full = '';
  let fed = 0;
  return {
    push(delta) {
      full += delta;
      const spoken = full.replace(/```[\s\S]*?```/g, '\n').replace(/```[\s\S]*$/, '');
      if (spoken.length > fed) {
        for (const s of chunker.push(spoken.slice(fed))) speaker.speak(s);
        fed = spoken.length;
      }
    },
    flush() { for (const s of chunker.flush()) speaker.speak(s); }
  };
}

async function send(text) {
  text = String(text || '').trim();
  if (!text && !attachments.length) return;
  if (active) { active.ctrl.abort(); active = null; }
  speaker.cancel();
  speaker.unlock(); // 发送多由点击 / 回车触发：顺便启动音频上下文，云端语音才能播放

  const files = attachments.splice(0);
  renderAttachments();
  const userText = files.length ? `${text}\n\n[已上传到工作区：${files.join('、')}]` : text;
  transcript.add('user', userText);
  const llmHistory = history.slice(-20).map(({ role, content }) => ({ role, content }));
  rememberTurn('user', userText);

  if (machine.task !== 'listening') machine.beginUserTurn();
  const ctrl = new AbortController();
  const bubble = transcript.add('agent');
  bubble.el.classList.add('streaming');
  const turn = { ctrl, streamDone: false, bubble };
  active = turn;
  setTask('processing', '思考中');

  const { adapter, model, problem } = createAdapter(llmConfig, { gateway });
  if (problem) {
    bubble.append(problem);
    bubble.done();
    active = null;
    setTask('error', '需要配置模型');
    showPanel('models');
    return;
  }

  const speech = makeSpeech();
  const cards = new Map();
  let firstToken = 0;
  let serverCard = null;
  const t0 = now();
  try {
    const result = await runAgent({
      adapter, model, history: llmHistory, userText, signal: ctrl.signal,
      tools: createTools({
        metrics,
        tavilyKey: llmConfig.tavilyKey,
        fetchViaGateway: fetchViaGateway(),
        onPreview: (path) => { showPanel('workspace'); panels.openFile(path); },
        onFileChanged: (path) => { panels.markFresh(path); panels.refreshFiles(); }
      }),
      emit: (e) => {
        if (active !== turn) return;
        if (e.type === 'text') {
          if (!firstToken) firstToken = now();
          if (serverCard) { serverCard.done(true, '由 Claude 服务端完成', Math.round(now() - serverCard.t0)); serverCard = null; }
          bubble.append(e.delta);
          machine.feedResponseText(e.delta);
          speech.push(e.delta);
        } else if (e.type === 'emotion') machine.setStreamHint(e.value);
        else if (e.type === 'state' && e.value !== 'done') setTask(e.value, e.value === 'listening' ? '生成回答' : '');
        else if (e.type === 'tool_start') {
          cards.set(e.id, bubble.toolCard(e.name, e.args));
          setTask('processing', `${e.name}`);
        } else if (e.type === 'tool_end') {
          cards.get(e.id)?.done(e.ok, e.output, e.ms);
          if (/remember|forget|save_skill/.test(e.name)) panels.refreshMind();
        } else if (e.type === 'server_tool') {
          serverCard = Object.assign(bubble.toolCard('web_search', { query: 'Claude 联网搜索' }), { t0: now() });
        } else if (e.type === 'sources') bubble.sources(e.items);
      }
    });
    if (active !== turn) return;
    speech.flush();
    const total = now() - t0;
    bubble.done(`${firstToken ? `首字 ${Math.round(firstToken - t0)}ms · ` : ''}耗时 ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · 工具 ${result.toolCalls} 次` : ''}`, {
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
    rememberTurn('assistant', result.text || '（完成）');
    $('#mode-pill').classList.remove('offline');
    turn.streamDone = true;
    if (!speaker.speaking) finishTurn();
  } catch (err) {
    if (err.name === 'AbortError' || active !== turn) return;
    const msg = String(err.message || err);
    const cors = /Failed to fetch|NetworkError|Load failed|CORS/i.test(msg);
    bubble.append(`\n（出错了：${msg}${cors ? '。多半是该服务商不允许网页直接调用：双击 jarvis 文件夹里的 启动.bat（或 start.sh）并保持窗口开着，本页面会自动连上本机网关，然后重试即可' : ''}）`);
    if (cors && !gateway) detectGateway();
    bubble.done();
    $('#mode-pill').classList.add('offline');
    active = null;
    setTask('error', '请求失败');
  }
}

// —— 输入框：Enter 发送，Shift+Enter 换行；随内容自动增高
const prompt = $('#prompt');
function autosize() { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 200)}px`; }
$('#inputbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = prompt.value;
  prompt.value = '';
  autosize();
  send(v);
});
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#inputbar').requestSubmit();
  }
});
prompt.addEventListener('input', (e) => {
  autosize();
  if (e.target.value && speaker.speaking) speaker.cancel(); // 开始打字即打断朗读
  if (e.target.value && !active && machine.task !== 'listening') machine.beginUserTurn();
});

// —— 附件：上传 / 拖入的文件放进工作区“上传/”目录，并附在下一条消息里
async function addFiles(list) {
  for (const f of list) {
    try {
      const r = await ws.write(`上传/${f.name}`, f);
      attachments.push(r.path);
      panels.markFresh(r.path);
    } catch (e) { toast(`${f.name}：${e.message}`); }
  }
  renderAttachments();
  panels.refreshFiles();
  prompt.focus();
}
function renderAttachments() {
  const box = $('#attach-list');
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((p, i) => {
    const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: '移除' });
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    const s = document.createElement('span');
    s.append(p.replace(/^上传\//, ''), x);
    return s;
  }));
}
$('#btn-attach').addEventListener('click', () => $('#file-input').click());
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
setInterval(() => document.body.classList.toggle('awake', settings.wakeWord && wake.awake), 250);
function onWake() {
  wake.wake();
  const ctx = speaker.unlock();
  if (ctx?.state === 'running') playCue(ctx, 'start', 0.08);
  machine.beginUserTurn();
}

const voice = new VoiceInput({
  onConfirm: () => {
    if (asleep()) return;
    live.voiceListening = true;
    if (active) { active.ctrl.abort(); active = null; speaker.cancel(); }
    machine.beginUserTurn();
    dashboard.setTask('listening', '正在听');
    $('#vad-meter').classList.add('on');
  },
  onCancel: () => endListening(),
  onInterim: (t) => { if (!asleep() || matchWake(t).woke) transcript.interim(t); },
  onFinal: (t) => {
    endListening();
    transcript.clearInterim();
    if (!settings.wakeWord) return send(t);
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
    send(cmd);
  },
  onEnergy: (e) => {
    live.voiceEnergy = e;
    $('#inputbar').style.setProperty('--e', e.toFixed(2));
  },
  onMode: (m) => {
    $('#voice-status').textContent = {
      off: '',
      loading: '正在加载本地语音活动检测模型…',
      vad: '已开启：直接说话即可，停顿后自动提交。',
      ptt: '语音活动检测不可用，已降级为“按下说话”：按住麦克风说话，松开提交。'
    }[m];
    $('#btn-mic').setAttribute('aria-pressed', String(m !== 'off'));
    body.classList.toggle('voice-on', m !== 'off');
    $('#btn-mic').title = m === 'ptt' ? '按住说话' : '直接对话';
  },
  onError: (code) => {
    toast(code === 'not-allowed' ? '麦克风权限被拒绝' : `语音识别出错：${code}`);
  }
});

function endListening() {
  if (!live.voiceListening) return;
  live.voiceListening = false;
  live.voiceEnergy = 0;
  transcript.clearInterim();
  $('#vad-meter').classList.remove('on');
  // 识别被取消且没有发出请求：回到空闲；保持情绪不变以外的状态（no-speech 不触发警觉）
  if (!active && machine.task === 'listening') setTask('idle');
}

async function setDirectVoice(on) {
  setSetting('directVoice', on);
  $('#set-voice').checked = on;
  if (on) {
    try {
      await voice.enable({ silenceMs: SILENCE_BY_SENSITIVITY[settings.vadSensitivity] });
    } catch (err) {
      toast(err.message);
      setSetting('directVoice', false);
      $('#set-voice').checked = false;
    }
  } else {
    voice.disable();
    endListening();
  }
}

const mic = $('#btn-mic');
if (!speechRecognitionSupported) {
  // Firefox 等：隐藏语音输入，保留文本输入与语音输出（需求 6.1 / 10）
  mic.hidden = true;
  $('#row-voice').hidden = true;
  setSetting('directVoice', false);
}
mic.addEventListener('click', () => {
  if (voice.mode === 'ptt') return;
  setDirectVoice(voice.mode === 'off');
});
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
        live.face = t.inRange ? t : null;
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
const PANES = ['workspace', 'knowledge', 'mind', 'models', 'system', 'settings'];
let currentPane = null;
const narrow = matchMedia('(max-width: 860px)');
function showPanel(name, { toggle = false } = {}) {
  if (toggle && name === currentPane && (narrow.matches ? body.classList.contains('side-open') : !body.classList.contains('side-closed'))) {
    body.classList.add('side-closed');
    body.classList.remove('side-open');
    currentPane = null;
    return;
  }
  currentPane = name;
  body.classList.remove('side-closed');
  body.classList.add('side-open');
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  for (const b of document.querySelectorAll('.rail-btn')) b.classList.toggle('active', b.dataset.panel === name);
  try { localStorage.setItem('jarvis.pane', name); } catch { /* ignore */ }
  if (name === 'workspace') panels.refreshFiles();
  if (name === 'knowledge') panels.refreshKb();
  if (name === 'mind') panels.refreshMind();
  if (name === 'models') { panels.refreshModels(); voicePanel.render(); }
}
for (const b of document.querySelectorAll('.rail-btn')) b.addEventListener('click', () => showPanel(b.dataset.panel, { toggle: true }));
for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => showPanel(b.dataset.open));

const panels = initPanels({
  toast: (t) => toast(t),
  settings,
  getGateway: () => gateway,
  getHistory: () => history,
  onConfigChange: (cfg) => { llmConfig = cfg; updateModelLabels(); },
  onClearHistory: () => { history.length = 0; clearMemory(storage); toast('对话记录已清空'); },
  onPersistChange: (on) => {
    setSetting('persistMemory', on);
    if (on) saveMemory(history, storage);
    else clearMemory(storage);
    toast(on ? '对话记录将保存在本机浏览器中' : '已停止保存，并删除本机保存的对话记录');
  }
});
const voicePanel = initVoicePanel({ panels, speaker, getGateway: () => gateway });
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
}
$('#btn-focus').addEventListener('click', () => setFocusView(!settings.focusView));
$('#btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

function setStyle(style) {
  if (!['orb', 'holo', 'wire'].includes(style)) style = 'orb';
  setSetting('look', style);
  for (const c of document.querySelectorAll('[data-style]')) c.setAttribute('aria-checked', String(c.dataset.style === style));
  stage?.setStyle(style);
}
for (const c of document.querySelectorAll('[data-style]')) c.addEventListener('click', () => setStyle(c.dataset.style));

$('#set-face').addEventListener('change', (e) => setFaceFollow(e.target.checked));
$('#set-voice').addEventListener('change', (e) => setDirectVoice(e.target.checked));
$('#set-wake').addEventListener('change', (e) => { setSetting('wakeWord', e.target.checked); wake.sleep(); });
$('#set-tts').addEventListener('change', (e) => {
  setSetting('speechOutput', e.target.checked);
  speaker.enabled = e.target.checked;
  if (!e.target.checked) speaker.cancel();
});
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
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------------------------------------------------------- 恢复上次的设置
$('#set-tts').checked = settings.speechOutput;
$('#set-wake').checked = settings.wakeWord;
$('#set-quality').value = settings.quality;
dashboard.setTurns(history.filter((m) => m.role === 'user').length);
$('#set-motion').value = settings.reducedMotion;
for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x.dataset.v === settings.vadSensitivity));
setStyle(settings.look);
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
if (speechRecognitionSupported) restoreDevice('microphone', 'directVoice', setDirectVoice);


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

// ---------------------------------------------------------------- 键盘快捷键
//   Esc 打断   /  聚焦输入框   Alt+1..6 面板   Alt+F 专注视图   Alt+V 直接对话
//   Alt+O / Alt+H / Alt+W 光核 / 胸像 / 线框   按住空格：按下说话（降级模式、焦点不在输入框时）
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (interrupt()) { e.preventDefault(); toast('已打断'); }
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.code;
    const n = /^Digit([1-6])$/.exec(k)?.[1];
    if (n) showPanel(PANES[n - 1]);
    else if (k === 'KeyF') setFocusView(!settings.focusView);
    else if (k === 'KeyV' && speechRecognitionSupported) setDirectVoice(voice.mode === 'off');
    else if (k === 'KeyO') setStyle('orb');
    else if (k === 'KeyH') setStyle('holo');
    else if (k === 'KeyW') setStyle('wire');
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
  settings,
  live,
  get stage() { return stage; },
  get config() { return llmConfig; },
  get gateway() { return gateway; },
  panels,
  send,
  interrupt,
  showPanel,
  get quality() { return quality; }
};
