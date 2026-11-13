import { VoiceInput } from './voiceInput.js';
import { QwenVoice } from './qwenVoice.js';
import { transcribe } from './stt.js';
import { NativeVoice } from '../mobile/nativeVoice.js';
import { RecordedVoice } from '../mobile/recordedVoice.js';

/** 自动模式保留免费系统识别；失败后按真实协议选云端，实时识别不能当文件转写调用。 */
export function chooseVoiceInput({ mobile, nativeAvailable, requested = 'auto', resolved, nativeFailed = false }) {
  if (mobile && nativeAvailable && requested === 'auto' && !nativeFailed) return 'native';
  if (resolved === 'qwen-realtime') return 'qwen';
  return mobile ? 'recorded' : 'browser';
}

export function createVoiceInput(kind, { getConfig, getGateway, getEngine, browserSupported, plugin, allowBargeIn, handlers }) {
  if (kind === 'native') return new NativeVoice({ plugin, ...handlers });
  if (kind === 'qwen') return new QwenVoice({ getConfig, getGateway, allowBargeIn, ...handlers });
  return new (kind === 'recorded' ? RecordedVoice : VoiceInput)({
    allowBrowserSR: browserSupported,
    getTranscriber: () => {
      const id = getEngine();
      return ['none', 'browser', 'qwen-realtime'].includes(id)
        ? null
        : (wav, signal) => transcribe(id, getConfig(), wav, { gateway: getGateway(), signal });
    },
    ...handlers
  });
}
