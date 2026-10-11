/**
 * 贾维斯前端入口：状态管理层 + 渲染策略控制器。
 *
 *   感知（人脸 / VAD / 识别） ─┐
 *   对话流（SSE）             ─┼─▶ EmotionMachine ─▶ ParamTween(400ms) ─┐
 *   注入事件（SSE）           ─┘                                        ├─▶ stage.frame()
 *   形态模式 / 情绪基线 ─────────▶ ScalarTween(1.2s, easeInOutCubic) ───┘
 *
 * 减少动画：在初始化 WebGL 之前判断，命中则根本不 import three.js、不下载点云。
 */
import { EmotionMachine } from './core/emotionMachine.js';
import { EMOTION_PARAMS } from './core/emotions.js';
import { ParamTween, ScalarTween, clamp } from './core/tween.js';
import { followTarget, smoothToward, followEnabled } from './core/faceMath.js';
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
import { HUMAN_POINTS_URL } from './config.js';

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
    updateMorphTarget();
  }
});
setInterval(() => machine.tick(), 100);

// ---------------------------------------------------------------- 形态
const morph = new ScalarTween(EMOTION_PARAMS.平静.morph, 1200);
const live = {
  voiceListening: false, // VAD 确认用户在说话
  voiceEnergy: 0,
  face: null, // 跟随目标 { yaw, pitch }（度）
  yaw: 0,
  pitch: 0,
  spinAngle: 0,
  breath: 0
};

function morphTarget() {
  if (settings.formMode === 'human') return 0;
  if (settings.formMode === 'particle') return 1;
  if (live.voiceListening) return 0.45;
  return EMOTION_PARAMS[machine.state].morph;
}
function updateMorphTarget() {
  morph.set(morphTarget(), now());
}

// ---------------------------------------------------------------- 渲染策略
let stage = null;
let stageLoading = null;
let humanPoints = null;
const DEG = Math.PI / 180;

function frame(dt, t) {
  const p = tween.update(t);
  const m = morph.update(t);

  // 角速度：情绪表 → 说话时降到 0.12（需求 6.3） → 手动粒子形态时不低于 0.3（需求 3.3）
  let omega = p.spin;
  if (live.voiceListening) omega = 0.12;
  if (settings.formMode === 'particle') omega = Math.max(omega, 0.3);
  live.spinAngle += omega * (dt / 1000);

  // 人脸跟随：只在人形区域（morph ≤ 0.6）生效，否则平滑回正
  const tgt = settings.faceFollow && followEnabled(m) && live.face ? live.face : { yaw: 0, pitch: 0 };
  live.yaw = smoothToward(live.yaw, tgt.yaw, 0.12, dt || 16.7);
  live.pitch = smoothToward(live.pitch, tgt.pitch, 0.12, dt || 16.7);

  // 向心流速：接近粒子核心时出现，“专注”时加快
  const near = clamp((m - 0.7) / 0.3, 0, 1);
  const inward = 0.03 + 0.07 * near + (machine.state === '专注' ? 0.14 : 0);

  // 呼吸：只在聆听且用户正在说话时随音量包络起伏
  const breathTarget = live.voiceListening ? live.voiceEnergy * 0.12 : 0;
  live.breath += (breathTarget - live.breath) * 0.2;

  return {
    morph: m,
    hue: p.hue,
    glow: p.glow,
    jitter: p.jitter,
    spinAngle: live.spinAngle,
    yaw: live.yaw * DEG,
    pitch: live.pitch * DEG,
    inward,
    breath: live.breath,
    motion: 1
  };
}

async function ensureStage() {
  if (stage || stageLoading) return stageLoading;
  stageLoading = (async () => {
    try {
      const [{ createStage }, points] = await Promise.all([
        import('./render/stage.js'),
        humanPoints ?? fetch(HUMAN_POINTS_URL).then((r) => {
          if (!r.ok) throw new Error(`点云加载失败 ${r.status}`);
          return r.arrayBuffer();
        }).then((b) => new Float32Array(b))
      ]);
      humanPoints = points;
      if (wantsReducedMotion(settings, reducedMql)) return null; // 加载期间切换成了减少动画
      stage = createStage($('#stage'), {
        humanPoints,
        lowEnd,
        onContextChange: (s, ms) => console.info(`[stage] WebGL 上下文${s === 'lost' ? '丢失' : `已恢复（${Math.round(ms)}ms）`}`)
      });
      stage.onFrame(frame);
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

function applyFpsCap() {
  stage?.setFpsCap(settings.focusView ? 20 : isMobile ? 30 : 60);
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
const history = [];
let turns = 0;
let active = null; // { ctrl, streamDone }

const speaker = new Speaker({
  onStart: () => voice.setSuppressed(true),
  onIdle: () => {
    voice.setSuppressed(false);
    if (active?.streamDone) finishTurn();
  }
});
speaker.enabled = settings.speechOutput;

function setTask(state, sub) {
  machine.setTaskState(state);
  dashboard.setTask(state, sub);
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
  history.push({ role: 'user', content: text });

  if (machine.task !== 'listening') machine.beginUserTurn();
  setTask('processing', '请求已发出');

  const ctrl = new AbortController();
  const turn = { ctrl, streamDone: false };
  active = turn;
  const bubble = transcript.add('agent');
  bubble.el.classList.add('streaming');
  const chunker = new SentenceChunker();
  let reply = '';
  let firstToken = 0;
  const t0 = now();

  try {
    await streamChat({
      messages: history.slice(-12),
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
    bubble.done(firstToken ? `首字 ${Math.round(firstToken - t0)}ms` : '');
    history.push({ role: 'assistant', content: reply || '（空回复）' });
    $('#mode-pill').classList.remove('offline');
    turn.streamDone = true;
    if (!speaker.speaking) finishTurn();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (active !== turn) return;
    bubble.done();
    bubble.append(reply ? '' : `（连接失败：${err.message}）`);
    history.pop();
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
    updateMorphTarget();
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
    $('#vad-meter').style.setProperty('--e', e.toFixed(2));
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
  updateMorphTarget();
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
  const list = $('#memory-list');
  list.replaceChildren(...history.slice(-24).map((m) => {
    const li = document.createElement('li');
    li.textContent = `${m.role === 'user' ? '你' : '贾维斯'}：${m.content.slice(0, 80)}${m.content.length > 80 ? '…' : ''}`;
    return li;
  }));
  if (!history.length) list.innerHTML = '<li class="muted">暂无</li>';
}
$('#btn-clear-memory').addEventListener('click', () => {
  history.length = 0;
  renderMemory();
  toast('记忆已清空');
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

function setFormMode(mode) {
  setSetting('formMode', mode);
  for (const c of document.querySelectorAll('[data-form]')) c.setAttribute('aria-checked', String(c.dataset.form === mode));
  updateMorphTarget();
}
for (const c of document.querySelectorAll('[data-form]')) c.addEventListener('click', () => setFormMode(c.dataset.form));

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
$('#set-motion').value = settings.reducedMotion;
for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x.dataset.v === settings.vadSensitivity));
setFormMode(settings.formMode);
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

// 调试 / 自动化测试入口
window.__jarvis = {
  machine,
  settings,
  live,
  get stage() { return stage; },
  get morph() { return morph.value; },
  send
};
