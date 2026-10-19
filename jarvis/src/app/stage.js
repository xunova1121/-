/**
 * 主视觉与状态显示：光核 / 粒子体舞台（WebGL）、情绪、实时量（说话起伏、眨眼、张望）、仪表盘、
 * 轨道 HUD、光核旁的建议标注、顶栏“执行中 / 完成”状态。
 *
 *   感知（人脸 / VAD / 识别） ─┐
 *   智能体事件（agent.js）     ─┼─▶ EmotionMachine ─▶ ParamTween(400ms) ─┐
 *   注入事件（SSE）           ─┘                                        ├─▶ stage.frame()
 *   人脸角度 / 麦克风包络 / 播报包络 ─────────────────────────────────┘
 *
 * 减少动画：在初始化 WebGL 之前判断，命中则根本不 import three.js、不下载网格。
 */
import { EmotionMachine } from '../core/emotionMachine.js';
import { EMOTION_PARAMS, EYE_SHAPES } from '../core/emotions.js';
import { ParamTween } from '../core/tween.js';
import { smoothToward } from '../core/faceMath.js';
import { wantsReducedMotion } from '../core/settings.js';
import { createFormDirector } from '../core/formDirector.js';
import { FORMS } from '../render/formations.js';
import { resolveQuality } from '../core/quality.js';
import { MetricsPoller } from '../api/metrics.js';
import { subscribeAgentEvents } from '../api/agentEvents.js';
import { Dashboard } from '../ui/dashboard.js';
import { initOrbitHud } from '../ui/orbitHud.js';
import { initCallouts } from '../ui/callouts.js';
import { initChips } from '../ui/chips.js';
import { $, body, now, COMPACT, lowEnd, isMobile, reducedMql, wp } from './env.js';

export function createStage(app) {
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
  /** 光核旁的建议标注（启动末尾创建） */
  let callouts = null;
  let stageMiniWas = false; // 舞台上一次是不是迷你状态（updateStageMode 用）

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
    const tgt = app.settings.faceFollow && live.face ? live.face : live.glance;
    live.yaw = smoothToward(live.yaw, tgt.yaw, 0.12, dt || 16.7);
    live.pitch = smoothToward(live.pitch, tgt.pitch, 0.12, dt || 16.7);

    // 输入：用户说话时胸像表面随麦克风包络起伏
    const breathTarget = live.voiceListening ? live.voiceEnergy * 1.6 : 0;
    live.breath += (breathTarget - live.breath) * 0.2;

    // 输出：播报时由词边界事件“敲”一下再衰减；语音包不发边界事件时用合成起伏兜底。
    // 输入驱动表面起伏，输出驱动轮廓光、眼睛与底座 —— 两者分开，一眼能看出是谁在说话
    let speakTarget = 0;
    const audioLevel = app.speaker.speaking ? app.speaker.level() : null;
    if (audioLevel !== null) {
      // 云端语音：由真实音量驱动
      speakTarget = 0.3 + 0.7 * audioLevel;
    } else if (app.speaker.speaking) {
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
        const { createStage } = await import('../render/stage.js');
        if (wantsReducedMotion(app.settings, reducedMql)) return null; // 加载期间切换成了减少动画
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

  let quality = resolveQuality(app.settings.quality, { lowEnd, isMobile, focusView: app.settings.focusView });
  function applyFpsCap() {
    quality = resolveQuality(app.settings.quality, { lowEnd, isMobile, focusView: app.settings.focusView, softwareRenderer: Boolean(stage?.stats.softwareRenderer) });
    stage?.setFpsCap(quality.fps);
    stage?.setQuality({ bloom: quality.bloom, stars: quality.stars });
    body.classList.toggle('eco', quality.tier === 'eco');
  }

  function applyMotionMode() {
    const reduced = wantsReducedMotion(app.settings, reducedMql);
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
    app.face?.setPaused(hidden);
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
    app.setSetting('emotionOverride', v);
    machine.setManual(v === 'auto' ? null : v);
    dashboard.setManualEmotion(v);
    $('#set-emotion').value = v;
  }

  const hud = {
    think(text, kind) { orbit?.think(text, kind); wp({ think: text }); },
    toolStart(id, label) { orbit?.toolStart(id, label); wp({ tool: { id, label } }); },
    toolEnd(id, ok) { orbit?.toolEnd(id, ok); wp({ toolDone: { id, ok } }); },
    newTurn() { orbit?.newTurn(); wp({ newTurn: true }); }
  };
  function updateOrbitStatus() {
    orbit?.setStatus(`${(FORMS[director.form]?.id ?? director.form).toUpperCase()} · LINK ${window.jarvisDesktop ? 'DESKTOP' : app.gateway ? 'GATEWAY' : 'LOCAL'}`);
  }

  const TASK_LABEL = { idle: '待命', listening: '生成中', processing: '执行中', error: '出错', done: '完成' };
  const DIRECTOR_STATE = { processing: 'processing', listening: 'speaking', done: 'speaking', idle: 'idle', error: 'error' };
  const ENERGY = { processing: 0.85, listening: 0.25 };
  function setTask(state, sub = '') {
    app.mascots?.task(state, sub);
    app.active?.bubble?.activity(state, sub);
    machine.setTaskState(state === 'listening' && !live.voiceListening ? 'listening' : state);
    if (DIRECTOR_STATE[state]) director.setState(DIRECTOR_STATE[state]);
    stage?.setActivity({ energy: ENERGY[state] ?? 0 });
    dashboard.setTask(state, sub);
    const label = sub || TASK_LABEL[state] || state;
    $('#hud-task').textContent = label;
    $('#task-text').textContent = label;
    body.classList.toggle('generating', Boolean(app.active) && state !== 'done' && state !== 'error' && state !== 'idle');
    $('#mode-pill').classList.toggle('busy', Boolean(app.active) && state !== 'done');
  }

  // 用户有动静：空闲漫游中的粒子体回到光核看着他
  let lastPoke = 0;
  const poke = () => { const t = performance.now(); if (t - lastPoke > 1000) { lastPoke = t; director.poke(); } };
  addEventListener('pointermove', poke, { passive: true });
  addEventListener('keydown', poke);

  // 有对话时舞台收成迷你状态条（桌面版），给对话留空间；点一下展开 / 收起
  function updateStageMode() {
    // 工作台的“工作室”视图要大舞台；“对话”视图里舞台隐藏，迷你模式只为把建议放到输入框上方
    const mini = !COMPACT && body.classList.contains('has-convo') && !app.settings.stageOpen && !body.classList.contains('focus-view') && !body.classList.contains('wb-studio');
    const label = $('#btn-stage-toggle span');
    if (label) label.textContent = app.settings.stageOpen ? '收起' : '展开';
    body.classList.toggle('stage-mini', mini); // 工作台切到“工作室”时会自己去掉这个类，所以用变量记上一次的状态
    if (mini === stageMiniWas) return;
    stageMiniWas = mini;
    callouts?.relocate?.();
  }
  function setStageOpen(open) { app.setSetting('stageOpen', open); updateStageMode(); }
  addEventListener('resize', () => updateStageMode()); // 工作台切换“对话 / 工作室”时会发 resize
  new MutationObserver(() => {
    body.classList.toggle('has-convo', Boolean(document.querySelector('#transcript .msg')));
    updateStageMode();
  }).observe($('#transcript'), { childList: true });
  $('#btn-stage-toggle').addEventListener('click', (e) => { e.stopPropagation(); setStageOpen(!app.settings.stageOpen); });
  $('#stage-wrap').addEventListener('click', (e) => { if (body.classList.contains('stage-mini') && !e.target.closest('button, a, .callout')) setStageOpen(true); });

  /** 启动末尾：建轨道 HUD 和光核旁的建议标注（要等对话区、工作台都建好） */
  function initSuggestions() {
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
        if (item.panel) { app.showPanel(item.panel); callouts?.show(); return; }
        setTimeout(() => app.send(item.prompt), 160);
      }
    };
    callouts = COMPACT ? initChips(suggestionOpts) : dualSuggestions(initCallouts(suggestionOpts), initChips(suggestionOpts), () => body.classList.contains('stage-mini'));
  }

  return {
    live, machine, director, dashboard, hud,
    get stage() { return stage; },
    get quality() { return quality; },
    get callouts() { return callouts; },
    ensureStage, applyFpsCap, applyMotionMode, applyEmotionOverride,
    setTask, updateOrbitStatus, updateStageMode, setStageOpen, initSuggestions
  };
}
