/** 语音自检、人脸跟随及已授权设备恢复；实际用到时才取app上的语音状态。 */
import { MOBILE, VAD } from '../config.js';
import { transcribe, encodeWav, sttEngineById } from '../perception/stt.js';
import { openQwenSession, QWEN_ASR } from '../perception/qwenRealtime.js';
import { NativeVoice } from '../mobile/nativeVoice.js';
import { recordVoiceEvent, readVoiceEvents } from '../mobile/voiceDiagnostics.js';
import { followTarget } from '../core/faceMath.js';
import { $, toast } from './env.js';

export function createVoiceDevices(app) {
  const voiceCheckButton = Object.assign(document.createElement('button'), { type: 'button', className: 'voice-diagnose', textContent: '检测语音' });
  voiceCheckButton.onclick = async () => {
    await app.setVoiceCall(false);
    app.showPanel('settings');
    await checkVoice();
  };
  $('#voice-call-panel').insertBefore(voiceCheckButton, $('#btn-call-listen'));
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
    await app.nativeVoiceReady;
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
      const result = await app.speaker.test();
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
    if (app.sttEngine() === 'qwen-realtime') {
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
    if (app.voice instanceof NativeVoice) {
      line(true, '系统语音服务可发现；需实际说话验证，失败后尝试系统窗口或云端转写');
      return;
    }
    if (MOBILE) line(false, '手机自带语音识别：这台手机没有可用的识别服务，改用云端转写');
    const id = app.sttEngine();
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

  // ---------------------------------------------------------------- 人脸跟随
  let face = null;
  async function setFaceFollow(on) {
    app.setSetting('faceFollow', on);
    $('#set-face').checked = on;
    const faceStatus = $('#face-faceStatus');
    if (!on) {
      face?.stop();
      app.live.face = null;
      faceStatus.textContent = '';
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
          faceStatus.textContent =
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
      faceStatus.textContent = '';
      toast(err.name === 'NotAllowedError' ? '摄像头权限被拒绝' : `人脸跟随不可用：${err.message}`);
    }
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

  $('#set-face').addEventListener('change', (e) => setFaceFollow(e.target.checked));
  return {
    checkVoice,
    setFaceFollow,
    restoreDevice,
    get face() {
      return face;
    }
  };
}
