/**
 * 声音：朗读（Speaker）、语音识别（浏览器 / 系统 / 云端转写 / 百炼实时）、唤醒词、语音对话（通话）、
 * 语音转文字（听写）、按住说话、语音自检、人脸跟随，以及设置里的语音开关。
 */
import { MOBILE, VAD } from '../config.js';
import { resolveVoice } from '../llm/config.js';
import { Speaker } from '../perception/speaker.js';
import { VoiceInput, speechRecognitionSupported } from '../perception/voiceInput.js';
import { resolveStt, transcribe, encodeWav, sttEngineById } from '../perception/stt.js';
import { openQwenSession, QWEN_ASR } from '../perception/qwenRealtime.js';
import { QwenVoice } from '../perception/qwenVoice.js';
import { playCue } from '../perception/voiceFx.js';
import { NativeVoice } from '../mobile/nativeVoice.js';
import { RecordedVoice } from '../mobile/recordedVoice.js';
import { createVoiceLifecycle } from '../mobile/voiceLifecycle.js';
import { recordVoiceEvent, readVoiceEvents } from '../mobile/voiceDiagnostics.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { matchWake, WakeWindow } from '../core/wakeWord.js';
import { SILENCE_BY_SENSITIVITY } from '../core/vadGate.js';
import { followTarget } from '../core/faceMath.js';
import { $, body, now, toast } from './env.js';

export function createVoice(app) {
  let dictating = false,
    dictationTimer = null,
    dictationGeneration = 0;
  let callTiming = null;
  let callActive = false;
  let callStarting = false;
  let callGeneration = 0;
  let callRestore = null;
  let voiceSwitching = false,
    callCloudFallback = false;

  const speaker = new Speaker({
    onAudioScheduled: ({ engine, delayMs }) => {
      if (callActive && callTiming?.recognizedAt && !callTiming.audioAt) {
        callTiming.audioAt = now() + delayMs;
        recordVoiceEvent(
          '通话分段耗时',
          JSON.stringify({
            engine,
            recognitionMs: callTiming.stoppedAt ? Math.round(callTiming.recognizedAt - callTiming.stoppedAt) : null,
            modelFirstTextMs: callTiming.firstTextAt ? Math.round(callTiming.firstTextAt - callTiming.recognizedAt) : null,
            audioScheduledMs: Math.round(callTiming.audioAt - callTiming.recognizedAt)
          })
        );
      }
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
      if (app.active?.streamDone) app.finishTurn();
    },
    onBoundary: () => {
      app.live.boundaryAt = now();
    },
    onError: (e) =>
      toast(
        resolveVoice(app.llmConfig, app.gateway).engine === 'qwen-realtime'
          ? `${e.message}（所选百炼声音未播放，请检查声音设置）`
          : `${e.message}（先用系统自带声音朗读，5 分钟后再试）`
      ),
    getVoiceConfig: () => resolveVoice(app.llmConfig, app.gateway),
    getKeys: () => app.llmConfig.keys,
    getConfig: () => app.llmConfig,
    onEngine: (engine, fallback) => {
      const el = document.querySelector('#tts-status');
      if (el) el.textContent = fallback ? '当前已回退系统声音（不是目标女孩童声），请检测语音服务' : `实际播放引擎：${engine}`;
      if (fallback && callActive) callStatus('在线声音失败，当前为系统声；请检测声音服务');
    },
    getGateway: () => app.gateway
  });
  // 念不念由每一轮自己决定（见 makeSpeech）：语音对话、说话提问时念，打字提问默认不念
  speaker.enabled = true;

  // ---------------------------------------------------------------- 语音
  // 唤醒词：未唤醒时只听不动——不打断正在进行的回答，不显示识别中的文字
  const wake = new WakeWindow();
  const asleep = () => app.settings.wakeWord && !wake.awake;
  const DISMISS = /^(退下|没事了|休息吧|再见|就这样)[。.！!]*$/;
  setInterval(() => document.body.classList.toggle('awake', app.settings.wakeWord && wake.awake), 250);
  function onWake() {
    wake.wake();
    const ctx = speaker.unlock();
    if (ctx?.state === 'running') playCue(ctx, 'start', 0.08);
    app.machine.beginUserTurn();
  }

  // 语音识别：网页版优先用浏览器自带识别；桌面版（Electron 没有浏览器识别）或用户指定时走云端转写
  const browserSR = speechRecognitionSupported && !window.jarvisDesktop && !MOBILE; // 桌面版、手机 App 里的浏览器识别都用不了
  const callStatus = (text) => {
    $('#voice-call-status').textContent = text;
  };
  const sttEngine = () => resolveStt(app.llmConfig, { gateway: app.gateway, browserSupported: browserSR });
  function recordedVoice() {
    return new RecordedVoice({
      getTranscriber: () => {
        const id = sttEngine();
        return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id, app.llmConfig, wav, { gateway: app.gateway, signal });
      },
      ...voiceHandlers
    });
  }
  const voiceHandlers = {
    onStatus: (phase) => {
      if (callActive && phase === 'speech') callTiming = {};
      if (callActive && phase === 'processing') {
        callTiming ??= {};
        callTiming.stoppedAt = now();
      }
      recordVoiceEvent('识别阶段', phase);
      if (callActive)
        callStatus({ ready: '麦克风已开启，请说话', speech: '正在听你说话…', processing: '正在识别这句话…', popup: '尝试手机系统的语音窗口…' }[phase] || phase);
    },
    onUnavailable: async (message) => {
      recordVoiceEvent('系统识别不可用', message);
      if (!MOBILE || !callActive || callCloudFallback || /权限|permission/i.test(message) || sttEngine() === 'none') return;
      const gen = callGeneration;
      voiceSwitching = true;
      callCloudFallback = true;
      try {
        voice.disable();
        await globalThis.__jarvisSpeech?.stop();
        if (!callActive || gen !== callGeneration) return;
        voice = recordedVoice();
        callStatus('系统识别暂不可用，正在启用服务商转写…');
        await voice.enable({ silenceMs: SILENCE_BY_SENSITIVITY[app.settings.vadSensitivity] });
        if (gen !== callGeneration) voice.disable();
      } catch (e) {
        toast(`语音转写无法启动：${e.message}`);
        if (gen === callGeneration) await setVoiceCall(false);
      } finally {
        voiceSwitching = false;
      }
    },
    onConfirm: () => {
      if (callActive) callStatus('正在听你说话…');
      if (asleep()) return;
      app.live.voiceListening = true;
      if (!app.active) app.director.setState('voice');
      // 开口只打断朗读，不取消正在执行的任务；最终文字走同一套补充要求逻辑。
      if (app.active) app.active.muteSpeech = true;
      speaker.cancel();
      app.machine.beginUserTurn();
      app.dashboard.setTask('listening', '正在听');
      $('#vad-meter').classList.add('on');
    },
    onCancel: () => endListening(),
    onInterim: (t) => {
      if (!asleep() || matchWake(t).woke) app.transcript.interim(t);
    },
    onFinal: (t) => {
      if (dictating) {
        const text = String(t || '').trim();
        stopDictation();
        if (text) {
          app.prompt.value += (app.prompt.value.trim() ? ' ' : '') + text;
          app.autosize();
          app.prompt.dispatchEvent(new Event('input', { bubbles: true }));
          app.prompt.focus();
        }
        return;
      }
      if (callActive) {
        callTiming ??= {};
        callTiming.recognizedAt = now();
        callStatus('未央正在思考…');
      }
      endListening();
      app.transcript.clearInterim();
      if (!app.settings.wakeWord) return app.send(t, { byVoice: true });
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
        if (app.active) {
          app.active.ctrl.abort();
          app.active = null;
        }
        speaker.cancel();
        speaker.speak('我在。');
        app.setTask('listening', '已唤醒');
        return;
      }
      app.send(cmd, { byVoice: true });
    },
    onEnergy: (e) => {
      app.live.voiceEnergy = e;
      $('#inputbar').style.setProperty('--e', e.toFixed(2));
    },
    onMode: (m) => {
      if (m === 'off' && callActive && !callStarting && !voiceSwitching)
        queueMicrotask(() => {
          if (!voiceSwitching && callActive) setVoiceCall(false);
        });
      if (callActive)
        callStatus(m === 'off' ? '语音已停止' : m === 'loading' ? '正在准备语音…' : m === 'ptt' ? '按住麦克风说话，松开后回复' : '直接说话，未央在听');
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
      recordVoiceEvent('识别错误', code);
      if (callActive) callStatus(String(code));
      toast(code === 'not-allowed' ? '麦克风权限被拒绝' : /^语音识别/.test(code) ? code : `语音识别出错：${code}`);
    }
  };
  let voice = new (MOBILE ? RecordedVoice : VoiceInput)({
    allowBrowserSR: browserSR,
    getTranscriber: () => {
      const id = sttEngine();
      return id === 'browser' || id === 'none' ? null : (wav, signal) => transcribe(id, app.llmConfig, wav, { gateway: app.gateway, signal });
    },
    ...voiceHandlers
  });
  // 安卓 App：有系统语音识别就用它（免费、不用密钥、自己判断说完）；没有再走云端转写
  const nativeVoiceReady =
    MOBILE && globalThis.__jarvisSpeech
      ? NativeVoice.available(globalThis.__jarvisSpeech).then((ok) => {
          globalThis.__jarvisNativeSpeechAvailable = ok;
          recordVoiceEvent('系统服务检测', String(ok));
          if (ok) voice = new NativeVoice({ plugin: globalThis.__jarvisSpeech, ...voiceHandlers });
          return ok;
        })
      : Promise.resolve(false);

  function endListening() {
    app.transcript.clearInterim();
    if (!app.live.voiceListening) return;
    app.live.voiceListening = false;
    if (!app.active) app.director.setState('idle');
    app.live.voiceEnergy = 0;
    app.transcript.clearInterim();
    $('#vad-meter').classList.remove('on');
    // 识别被取消且没有发出请求：回到空闲；保持情绪不变以外的状态（no-speech 不触发警觉）
    if (!app.active && app.machine.task === 'listening') app.setTask('idle');
  }

  async function setDirectVoice(on) {
    const nativeAvailable = await nativeVoiceReady; // 手机上先确定用不用系统识别
    if (on && sttEngine() === 'qwen-realtime') {
      if (!(voice instanceof QwenVoice)) {
        voice.disable();
        voice = new QwenVoice({ getConfig: () => app.llmConfig, getGateway: () => app.gateway, allowBargeIn: () => callActive, ...voiceHandlers });
      }
    } else if (on && voice instanceof QwenVoice) {
      voice.disable();
      voice = new (MOBILE ? RecordedVoice : VoiceInput)({
        allowBrowserSR: browserSR,
        getTranscriber: () => {
          const id = sttEngine();
          return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id, app.llmConfig, wav, { gateway: app.gateway, signal });
        },
        ...voiceHandlers
      });
    }
    if (MOBILE && on) {
      const useNative = nativeAvailable && (app.llmConfig.stt?.engine || 'auto') === 'auto';
      if (useNative && !(voice instanceof NativeVoice)) {
        voice.disable();
        voice = new NativeVoice({ plugin: globalThis.__jarvisSpeech, ...voiceHandlers });
      }
      if (!useNative && voice instanceof NativeVoice) {
        voice.disable();
        voice = new RecordedVoice({
          getTranscriber: () => {
            const id = sttEngine();
            return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id, app.llmConfig, wav, { gateway: app.gateway, signal });
          },
          ...voiceHandlers
        });
      }
    }
    app.setSetting('directVoice', on);
    $('#set-voice').checked = on;
    if (on) {
      try {
        await voice.enable({ silenceMs: SILENCE_BY_SENSITIVITY[app.settings.vadSensitivity] });
      } catch (err) {
        recordVoiceEvent('启动失败', err.message);
        toast(err.message);
        if (/云端语音识别/.test(err.message)) app.showPanel('models');
        app.setSetting('directVoice', false);
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
        app.settings.speechOutput = callRestore.speechOutput;
        app.settings.wakeWord = callRestore.wakeWord;
        callRestore = null;
      }
      await setDirectVoice(false);
      return;
    }
    callStarting = true;
    callCloudFallback = false;
    callActive = true;
    callRestore = { speechOutput: app.settings.speechOutput, wakeWord: app.settings.wakeWord, directVoice: app.settings.directVoice };
    app.settings.speechOutput = true;
    app.settings.wakeWord = false;
    speaker.unlock();
    $('#voice-call-panel').hidden = false;
    $('#btn-call').setAttribute('aria-pressed', 'true');
    $('#btn-call').setAttribute('aria-label', '结束语音对话');
    recordVoiceEvent('通话', '开始连接');
    callStatus('正在连接语音…');
    try {
      const ok = await setDirectVoice(true);
      if (gen !== callGeneration) {
        await setDirectVoice(false);
        return;
      }
      if (!ok) await setVoiceCall(false);
      else callStatus(voice.mode === 'ptt' ? '按住麦克风说话，松开后回复' : '直接说话，未央在听');
    } catch (e) {
      toast(`语音无法启动：${e.message || e}`);
      if (gen === callGeneration) await setVoiceCall(false);
    } finally {
      callStarting = false;
    }
  }
  $('#btn-call').addEventListener('click', () => setVoiceCall(!callActive));
  $('#btn-call-end').addEventListener('click', () => setVoiceCall(false));
  const voiceCheckButton = Object.assign(document.createElement('button'), { type: 'button', className: 'voice-diagnose', textContent: '检测语音' });
  voiceCheckButton.onclick = async () => {
    await setVoiceCall(false);
    app.showPanel('settings');
    await checkVoice();
  };
  $('#voice-call-panel').append(voiceCheckButton);
  const takeFloor = Object.assign(document.createElement('button'), { type: 'button', textContent: '我来说', id: 'btn-call-listen' });
  takeFloor.onclick = () => {
    if (app.active) app.active.muteSpeech = true;
    speaker.cancel();
    voice.setSuppressed(false);
    callStatus('正在听你说话…');
  };
  $('#voice-call-panel').append(takeFloor);
  const voiceLifecycle = createVoiceLifecycle({
    getState: () => ({
      hidden: document.hidden,
      nativeActive: globalThis.__jarvisForeground !== false,
      starting: callStarting,
      systemDialog: Boolean(globalThis.__jarvisSystemSpeechDialog)
    }),
    onAudio: (foreground) => speaker.setForeground(foreground),
    onLeave: () => {
      if (dictating) {
        stopDictation();
        return;
      }
      if (!MOBILE && !(voice instanceof QwenVoice)) return;
      if (callActive) {
        app.companion?.close();
        setVoiceCall(false);
      } else if (voice.mode !== 'off') setDirectVoice(false);
    }
  });
  document.addEventListener('visibilitychange', () => voiceLifecycle.update());
  addEventListener('jarvis:foreground', () => voiceLifecycle.update());
  voiceLifecycle.update();

  // “检测语音”：逐项检查麦克风 / 系统识别 / 云端转写 / 语音检测模型，告诉用户卡在哪一步
  async function checkVoice() {
    const list = $('#voice-check');
    list.hidden = false;
    list.replaceChildren();
    const line = (ok, text) => {
      const li = document.createElement('li');
      li.dataset.ok = ok === null ? 'wait' : ok ? '1' : '0';
      li.textContent = text;
      list.append(li);
      return li;
    };
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
    const tli = line(null, '实际声音服务：正在合成并试听…');
    try {
      const result = await speaker.test();
      tli.dataset.ok = '1';
      tli.textContent = `实际声音：${result.engine} · ${result.voice || '服务默认'}（已解码并播放；请确认听感）`;
      recordVoiceEvent('声音检测成功', `${result.engine} ${result.voice}`);
    } catch (e) {
      tli.dataset.ok = '0';
      tli.textContent = `实际声音服务不可用：${e.message}`;
      recordVoiceEvent('声音检测失败', e.message);
    }
    for (const event of readVoiceEvents().slice(-6)) line(null, `${new Date(event.time).toLocaleTimeString('zh-CN')} · ${event.stage}：${event.detail}`);
  }

  /** 语音自检里的“识别”部分 */
  async function checkRecognition(line) {
    if (sttEngine() === 'qwen-realtime') {
      const li = line(null, '百炼实时识别：正在连接…');
      let session;
      try {
        session = await openQwenSession({
          model: QWEN_ASR,
          key: app.llmConfig.keys?.qwen || '',
          region: app.llmConfig.voice?.qwenRegion || 'beijing',
          gateway: app.gateway,
          signal: AbortSignal.timeout(20000)
        });
        li.dataset.ok = '1';
        li.textContent = '百炼实时识别：会话配置成功；请实际说话验证，连接成功不代表已测识别准确率';
      } catch (e) {
        li.dataset.ok = '0';
        li.textContent = '百炼实时识别：' + e.message;
      } finally {
        session?.close();
      }
      return;
    }
    // 2. 识别方式
    if (voice instanceof NativeVoice) {
      line(true, '系统语音服务可发现；需实际说话验证，失败后尝试系统窗口或云端转写');
      return;
    }
    if (MOBILE) line(false, '手机自带语音识别：这台手机没有可用的识别服务，改用云端转写');
    const id = sttEngine();
    if (id === 'browser') {
      line(true, '识别方式：浏览器自带语音识别');
      return;
    }
    if (id === 'none') {
      line(false, '识别方式：没有可用的语音识别。请在“模型 → 声音”填硅基流动或 OpenAI 的 Key');
      return;
    }
    // 3. 云端转写：发 1 秒静音试一下
    const li = line(null, `云端转写（${sttEngineById(id)?.name ?? id}）：检测中…`);
    try {
      await transcribe(id, app.llmConfig, encodeWav(new Float32Array(16000)), { gateway: app.gateway, signal: AbortSignal.timeout?.(20000) });
      li.dataset.ok = '1';
      li.textContent = `云端转写（${sttEngineById(id)?.name ?? id}）：接口连通（静音检测不代表实际识别准确）`;
    } catch (e) {
      li.dataset.ok = '0';
      li.textContent = `云端转写：${e.message}`;
    }
    if (MOBILE) {
      line(true, '语音切句：轻量录音模式，不需要下载语音检测模型');
      return;
    }
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
    app.setSetting('directVoice', false);
  }
  async function stopDictation() {
    dictationGeneration++;
    dictating = false;
    clearTimeout(dictationTimer);
    dictationTimer = null;
    body.classList.remove('dictating');
    await setDirectVoice(false);
    app.composer?.refresh();
  }
  async function toggleDictation() {
    if (dictating) return stopDictation();
    if (callActive) await setVoiceCall(false);
    speaker.cancel();
    dictating = true;
    const gen = ++dictationGeneration;
    body.classList.add('dictating');
    dictationTimer = setTimeout(() => {
      if (dictating && gen === dictationGeneration) {
        stopDictation();
        toast('本次转文字已结束，未发送消息');
      }
    }, 45000);
    try {
      const ok = await setDirectVoice(true);
      if (gen !== dictationGeneration) {
        voice.disable();
        return;
      }
      if (!ok) await stopDictation();
    } catch (e) {
      if (gen === dictationGeneration) {
        await stopDictation();
        toast(e.message);
      }
    }
  }
  mic.addEventListener('click', () => {
    if (voice.mode !== 'ptt') toggleDictation();
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
    app.setSetting('faceFollow', on);
    $('#set-face').checked = on;
    const status = $('#face-status');
    if (!on) {
      face?.stop();
      app.live.face = null;
      status.textContent = '';
      return;
    }
    try {
      const { FaceTracker } = await import('../perception/faceTracker.js');
      face ??= new FaceTracker({
        onAngles: (a) => {
          if (!a) return;
          const t = followTarget(a);
          const had = app.live.face;
          app.live.face = t.inRange ? t : null;
          // 摄像头看到你回来了（之前 10 分钟以上没看到人）
          if (app.live.face) {
            if (!had && app.live.faceGoneAt && Date.now() - app.live.faceGoneAt >= 10 * 60_000)
              app.greetOnReturn({ awayMs: Date.now() - app.live.faceGoneAt, reason: 'face' });
            app.live.faceGoneAt = 0;
          } else if (had) app.live.faceGoneAt = Date.now();
        },
        onStatus: (s) => {
          status.textContent =
            {
              starting: '正在启动摄像头与本地模型…',
              tracking: '跟随中（15fps，本机推理）',
              degraded: '推理较慢，已降至 10fps / 320×240',
              lost: '未检测到人脸',
              off: ''
            }[s] ?? '';
          if (s === 'lost') {
            app.live.face = null;
            toast('未检测到人脸');
          }
        }
      });
      await face.start();
    } catch (err) {
      face?.stop();
      app.setSetting('faceFollow', false);
      $('#set-face').checked = false;
      status.textContent = '';
      toast(err.name === 'NotAllowedError' ? '摄像头权限被拒绝' : `人脸跟随不可用：${err.message}`);
    }
  }

  // ---------------------------------------------------------------- 设置里的语音开关
  $('#set-face').addEventListener('change', (e) => setFaceFollow(e.target.checked));
  $('#set-voice').addEventListener('change', (e) => (callActive && !e.target.checked ? setVoiceCall(false) : setDirectVoice(e.target.checked)));
  $('#set-wake').addEventListener('change', (e) => {
    app.setSetting('wakeWord', e.target.checked);
    wake.sleep();
  });
  $('#set-tts').addEventListener('change', (e) => {
    app.setSetting('readTyped', e.target.checked);
    if (!e.target.checked) speaker.cancel();
  });
  for (const b of document.querySelectorAll('#set-vad button')) {
    b.addEventListener('click', () => {
      app.setSetting('vadSensitivity', b.dataset.v);
      voice.setSilenceMs(SILENCE_BY_SENSITIVITY[b.dataset.v]);
      for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x === b));
    });
  }

  // 摄像头 / 麦克风不随页面加载申请权限：上次开着的开关，只有在浏览器已授予权限（不会弹窗）时才自动恢复，
  // 否则复位为关闭，等用户再次主动开启
  async function restoreDevice(permission, key, enable) {
    if (!app.settings[key]) return;
    let granted = false;
    try {
      granted = (await navigator.permissions.query({ name: permission })).state === 'granted';
    } catch {
      /* 不支持查询该权限：按未授权处理 */
    }
    if (granted) enable(true);
    else app.setSetting(key, false);
  }

  return {
    speaker,
    endListening,
    setDirectVoice,
    setVoiceCall,
    checkVoice,
    stopDictation,
    toggleDictation,
    setFaceFollow,
    restoreDevice,
    callStatus,
    mic,
    get voice() {
      return voice;
    },
    get face() {
      return face;
    },
    get callActive() {
      return callActive;
    },
    get callTiming() {
      return callTiming;
    },
    get callRestore() {
      return callRestore;
    }
  };
}
