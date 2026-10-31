/**
 * 声音：朗读（Speaker）、语音识别（浏览器 / 系统 / 云端转写 / 百炼实时）、唤醒词、语音对话（通话）、
 * 语音转文字（听写）、按住说话、语音自检、人脸跟随，以及设置里的语音开关。
 */
import { MOBILE } from '../config.js';
import { resolveVoice } from '../llm/config.js';
import { Speaker } from '../perception/speaker.js';
import { VoiceInput, speechRecognitionSupported } from '../perception/voiceInput.js';
import { resolveStt, transcribe } from '../perception/stt.js';
import { QwenVoice } from '../perception/qwenVoice.js';
import { playCue } from '../perception/voiceFx.js';
import { NativeVoice } from '../mobile/nativeVoice.js';
import { RecordedVoice } from '../mobile/recordedVoice.js';
import { createVoiceLifecycle } from '../mobile/voiceLifecycle.js';
import { recordVoiceEvent } from '../mobile/voiceDiagnostics.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { matchWake, WakeWindow } from '../core/wakeWord.js';
import { SILENCE_BY_SENSITIVITY } from '../core/vadGate.js';
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

  // ---------------------------------------------------------------- 设置里的语音开关
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

  return {
    speaker,
    sttEngine,
    nativeVoiceReady,
    endListening,
    setDirectVoice,
    setVoiceCall,
    stopDictation,
    toggleDictation,
    callStatus,
    mic,
    get voice() {
      return voice;
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
