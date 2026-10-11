/**
 * 贾维斯前端入口：状态管理层 + 渲染策略控制器。
 *
 *   感知（人脸 / VAD / 识别） ─┐
 *   对话流（SSE）             ─┼─▶ EmotionMachine ─▶ ParamTween(400ms) ─┐
 *   注入事件（SSE）           ─┘                                        ├─▶ stage.frame()
 *   人脸角度 / 麦克风包络 / 播报包络 ─────────────────────────────────┘
 *
 * 主视觉是全息胸像（全息 / 线框 / 点阵 三种样式）。情绪通过颜色、轮廓光强度、扫描速度、
 * 光环转速和故障强度表达。
 * 减少动画：在初始化 WebGL 之前判断，命中则根本不 import three.js、不下载网格。
 */
import { EmotionMachine } from './core/emotionMachine.js';
import { EMOTION_PARAMS } from './core/emotions.js';
import { ParamTween } from './core/tween.js';
import { followTarget, smoothToward } from './core/faceMath.js';
import { SentenceChunker } from './core/sentenceChunker.js';
import { SILENCE_BY_SENSITIVITY } from './core/vadGate.js';
import { loadSettings, saveSettings, wantsReducedMotion } from './core/settings.js';
import { streamChat } from './api/chat.js';
import { MetricsPoller } from './api/metrics.js';
import { subscribeAgentEvents } from './api/agentEvents.js';
import { Dashboard } from './ui/dashboard.js';
import { Transcript } from './ui/transcript.js';
import { Speaker } from './perception/speaker.js';
import { VoiceInput, speechRecognitionSupported } from './perception/voiceInput.js';
import { FIGURE } from './config.js';
import { resolveQuality } from './core/quality.js';
import { loadMemory, saveMemory, clearMemory, groupByDay } from './core/memoryStore.js';

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
const tween = new ParamTween({ ...EMOTION_PARAMS.平静 }, { duration: 400 });
const machine = new EmotionMachine({
  onChange: (emotion) => {
    tween.set(EMOTION_PARAMS[emotion], now());
    document.documentElement.style.setProperty('--hue', String(EMOTION_PARAMS[emotion].hue));
    dashboard.setEmotion(emotion, EMOTION_PARAMS[emotion].hue);
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
  burstUntil: 0 // 随机故障闪烁截止时间
};

// ---------------------------------------------------------------- 渲染策略
let stage = null;
let stageLoading = null;
let figurePromise = null;

function loadFigure() {
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

  // 人脸跟随：只转头，肩膀不动（着色器按高度混合）
  const tgt = settings.faceFollow && live.face ? live.face : { yaw: 0, pitch: 0 };
  live.yaw = smoothToward(live.yaw, tgt.yaw, 0.12, dt || 16.7);
  live.pitch = smoothToward(live.pitch, tgt.pitch, 0.12, dt || 16.7);

  // 输入：用户说话时胸像表面随麦克风包络起伏
  const breathTarget = live.voiceListening ? live.voiceEnergy * 1.6 : 0;
  live.breath += (breathTarget - live.breath) * 0.2;

  // 输出：播报时由词边界事件“敲”一下再衰减；语音包不发边界事件时用合成起伏兜底。
  // 输入驱动表面起伏，输出驱动轮廓光、眼睛与底座 —— 两者分开，一眼能看出是谁在说话
  let speakTarget = 0;
  if (speaker.speaking) {
    const since = t - live.boundaryAt;
    speakTarget = since < 600
      ? 0.45 + 0.55 * Math.exp(-since / 140)
      : 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(t / 95)) * (0.5 + 0.5 * Math.sin(t / 333));
  }
  live.speak += (speakTarget - live.speak) * (speakTarget > live.speak ? 0.5 : 0.12);

  // 故障：基础强度来自情绪的抖动档位，另外每隔几秒随机闪一下（全息信号不稳的质感）
  if (t > live.burstUntil + 2500 && Math.random() < dt / 4000) live.burstUntil = t + 120 + Math.random() * 160;
  const glitch = Math.min(1, p.jitter * 1.6 + (t < live.burstUntil ? 0.55 : 0));

  return {
    hue: p.hue,
    glow: p.glow,
    spin: omega,
    scanSpeed: 0.05 + omega * 0.3,
    glitch,
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
      stage.setStyle(settings.style);
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

// ---------------------------------------------------------------- 对话
const transcript = new Transcript($('#transcript'));
// 记忆：开启“跨会话保存”时从 localStorage 恢复；每条带时间戳，按天分组显示
const storage = (() => { try { return localStorage; } catch { return null; } })();
const history = settings.persistMemory ? loadMemory(storage) : [];
function remember(role, content) {
  history.push({ role, content, ts: Date.now() });
  if (settings.persistMemory) saveMemory(history, storage);
}
let turns = 0;
let active = null; // { ctrl, streamDone }

const speaker = new Speaker({
  onStart: () => {
    voice.setSuppressed(true);
    body.classList.add('speaking');
  },
  onIdle: () => {
    voice.setSuppressed(false);
    body.classList.remove('speaking');
    if (active?.streamDone) finishTurn();
  },
  onBoundary: () => { live.boundaryAt = now(); }
});

/** 打断（barge-in）：停止播报并中止正在生成的回复 */
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
speaker.enabled = settings.speechOutput;

function setTask(state, sub) {
  machine.setTaskState(state);
  dashboard.setTask(state, sub);
  body.classList.toggle('generating', Boolean(active) && state !== 'done');
}

function finishTurn() {
  if (!active) return;
  active = null;
  turns++;
  dashboard.setTurns(turns);
  setTask('done');
  setTimeout(() => { if (!active) dashboard.setTask('idle'); }, 3000);
  renderMemory();
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  if (active) {
    active.ctrl.abort();
    active = null;
  }
  speaker.cancel();
  transcript.add('user', text);
  remember('user', text);

  if (machine.task !== 'listening') machine.beginUserTurn();
  setTask('processing', '请求已发出');

  const ctrl = new AbortController();
  const bubble = transcript.add('agent');
  bubble.el.classList.add('streaming');
  const turn = { ctrl, streamDone: false, bubble };
  active = turn;
  const chunker = new SentenceChunker();
  let reply = '';
  let firstToken = 0;
  const t0 = now();

  try {
    await streamChat({
      messages: history.slice(-12).map(({ role, content }) => ({ role, content })),
      signal: ctrl.signal,
      onMessage: (msg) => {
        if (active !== turn) return;
        if (msg.emotion_hint) machine.setStreamHint(msg.emotion_hint);
        if (msg.task_state && msg.task_state !== 'done') {
          setTask(msg.task_state, msg.tool ? `调用 ${msg.tool}` : msg.task_state === 'listening' ? '生成回复' : '');
        }
        if (msg.delta) {
          if (!firstToken) firstToken = now();
          reply += msg.delta;
          bubble.append(msg.delta);
          machine.feedResponseText(msg.delta);
          for (const s of chunker.push(msg.delta)) speaker.speak(s);
        }
      }
    });
    if (active !== turn) return;
    for (const s of chunker.flush()) speaker.speak(s);
    const total = now() - t0;
    const latency = firstToken ? `首字 ${Math.round(firstToken - t0)}ms · 生成 ${(total / 1000).toFixed(1)}s` : '';
    bubble.done(latency);
    dashboard.setLatency(firstToken ? firstToken - t0 : null, total);
    remember('assistant', reply || '（空回复）');
    $('#mode-pill').classList.remove('offline');
    turn.streamDone = true;
    if (!speaker.speaking) finishTurn();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (active !== turn) return;
    if (!reply) bubble.append(`（连接失败：${err.message}）`);
    bubble.done();
    history.pop();
    if (settings.persistMemory) saveMemory(history, storage);
    $('#mode-pill').classList.add('offline');
    active = null;
    setTask('error', '对话接口不可用');
  }
}

$('#inputbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#prompt');
  const v = input.value;
  input.value = '';
  send(v);
});
// 用户开始输入 → 聆听（由输入事件触发，而不是关键词）
$('#prompt').addEventListener('input', (e) => {
  if (e.target.value && speaker.speaking) speaker.cancel(); // 开始打字即打断播报
  if (e.target.value && !active && machine.task !== 'listening') machine.beginUserTurn();
  dashboard.setTask(machine.task);
});

fetch('/api/health').then((r) => r.json()).then((h) => {
  $('#mode-pill').title = h.backend === 'claude' ? `对话后端：Claude（${h.model}）` : '对话后端：本地演示智能体（未配置 ANTHROPIC_API_KEY）';
}).catch(() => $('#mode-pill').classList.add('offline'));

// ---------------------------------------------------------------- 语音
const voice = new VoiceInput({
  onConfirm: () => {
    live.voiceListening = true;
    if (active) { active.ctrl.abort(); active = null; speaker.cancel(); }
    machine.beginUserTurn();
    dashboard.setTask('listening', '正在听');
    $('#vad-meter').classList.add('on');
  },
  onCancel: () => endListening(),
  onInterim: (t) => transcript.interim(t),
  onFinal: (t) => {
    endListening();
    transcript.clearInterim();
    send(t);
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

// ---------------------------------------------------------------- 视图与设置面板
function setView(view) {
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === view);
  body.classList.toggle('view-chat', view === 'chat');
  $('#drawer-memory').hidden = view !== 'memory';
  $('#drawer-settings').hidden = view !== 'settings';
  if (view === 'memory') renderMemory();
}
for (const b of document.querySelectorAll('.nav-item')) {
  b.addEventListener('click', () => setView(b.classList.contains('active') && b.dataset.view !== 'console' ? 'console' : b.dataset.view));
}
$('#btn-nav').addEventListener('click', () => body.classList.toggle('nav-collapsed'));

function renderMemory() {
  const root = $('#memory-list');
  if (!history.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '暂无';
    root.replaceChildren(p);
    return;
  }
  root.replaceChildren(...groupByDay(history).map((g) => {
    const day = document.createElement('details');
    day.open = g.label === '今天';
    const sum = document.createElement('summary');
    sum.textContent = `${g.label} · ${g.items.filter((m) => m.role === 'user').length} 轮`;
    const ol = document.createElement('ol');
    for (const m of g.items) {
      const li = document.createElement('li');
      li.className = m.role;
      const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      li.textContent = `${time} ${m.role === 'user' ? '你' : '贾维斯'}：${m.content.slice(0, 90)}${m.content.length > 90 ? '…' : ''}`;
      ol.append(li);
    }
    day.append(sum, ol);
    return day;
  }));
}
$('#btn-clear-memory').addEventListener('click', () => {
  history.length = 0;
  clearMemory(storage);
  renderMemory();
  toast('记忆已清空');
});
$('#set-persist').addEventListener('change', (e) => {
  setSetting('persistMemory', e.target.checked);
  if (e.target.checked) saveMemory(history, storage);
  else clearMemory(storage);
  toast(e.target.checked ? '记忆将保存在本机浏览器中' : '已停止保存，并删除本机保存的记忆');
});
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
  if (!['holo', 'wire', 'dots'].includes(style)) style = 'holo';
  setSetting('style', style);
  for (const c of document.querySelectorAll('[data-style]')) c.setAttribute('aria-checked', String(c.dataset.style === style));
  stage?.setStyle(style);
}
for (const c of document.querySelectorAll('[data-style]')) c.addEventListener('click', () => setStyle(c.dataset.style));

$('#set-face').addEventListener('change', (e) => setFaceFollow(e.target.checked));
$('#set-voice').addEventListener('change', (e) => setDirectVoice(e.target.checked));
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
$('#set-quality').value = settings.quality;
$('#set-persist').checked = settings.persistMemory;
dashboard.setTurns(history.filter((m) => m.role === 'user').length);
$('#set-motion').value = settings.reducedMotion;
for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x.dataset.v === settings.vadSensitivity));
setStyle(settings.style);
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
renderMemory();

// ---------------------------------------------------------------- 键盘快捷键
//   Esc 打断播报/生成   /  聚焦输入框   Alt+1..4 切换视图   Alt+F 专注视图   Alt+V 直接对话
//   Alt+H / Alt+W / Alt+D 全息 / 线框 / 点阵   按住空格：按下说话（降级模式、焦点不在输入框时）
const VIEWS = ['console', 'chat', 'memory', 'settings'];
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (interrupt()) { e.preventDefault(); toast('已打断'); return; }
    if (!$('#drawer-settings').hidden || !$('#drawer-memory').hidden) setView('console');
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.code;
    const n = /^Digit([1-4])$/.exec(k)?.[1];
    if (n) setView(VIEWS[n - 1]);
    else if (k === 'KeyF') setFocusView(!settings.focusView);
    else if (k === 'KeyV' && speechRecognitionSupported) setDirectVoice(voice.mode === 'off');
    else if (k === 'KeyH') setStyle('holo');
    else if (k === 'KeyW') setStyle('wire');
    else if (k === 'KeyD') setStyle('dots');
    else return;
    e.preventDefault();
    return;
  }
  if (typing(document.activeElement)) return;
  if (e.key === '/') {
    e.preventDefault();
    $('#prompt').focus();
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
  settings,
  live,
  get stage() { return stage; },
  send,
  interrupt,
  get quality() { return quality; }
};
