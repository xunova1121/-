import { describe, it, expect, vi, afterEach } from 'vitest';
import { actionFromText } from '../src/ui/companion.js';
import { resolveStt, transcribe } from '../src/perception/stt.js';
import { resolveVoice, loadConfig, DEFAULT_VOICE } from '../src/llm/config.js';
import { synthesize } from '../src/perception/tts.js';
import { NativeVoice } from '../src/mobile/nativeVoice.js';
import { RecordedVoice } from '../src/mobile/recordedVoice.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('未央居中互动', () => {
  it('识别十种动作，同时把复杂任务留给模型', () => {
    expect(['挥挥手','未央眨眼睛','搓搓手','请转个圈','狂奔','笑一个','睡觉','害羞','给我比个心','跳个舞'].map(t => actionFromText(t)?.[0])).toEqual(['wave','wink','rub','spin','run','happy','sleep','shy','love','dance']);
    expect(actionFromText('帮我查今天的天气')).toBeNull();
    expect(actionFromText('睡眠报告')).toBeNull();
    expect(actionFromText('转圈后查天气')).toBeNull();
    expect(actionFromText('请分析睡眠情况并生成一份完整详细的报告')).toBeNull();
  });
});

describe('安卓语音修复', () => {
  const relay = { provider: 'relay-multi', stt: { engine: 'auto' }, keys: { 'relay-multi': 'test' }, baseURLs: { 'relay-multi': 'https://relay.invalid/v1' } };
  it('多协议中转也能复用已有密钥进行转写', async () => {
    expect(resolveStt(relay, { browserSupported: false })).toBe('provider');
    const fetchImpl = vi.fn(async () => new Response('{"text":"转个圈"}'));
    expect(await transcribe('provider', relay, new Blob(['audio']), { fetchImpl })).toBe('转个圈');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://relay.invalid/v1/audio/transcriptions');
  });
  it('系统可用性检查超时会退出，不让语音按钮一直无响应', async () => {
    vi.useFakeTimers();
    const pending = NativeVoice.available({ available: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toBe(false);
  });
  it('真正的识别错误连续三次后释放麦克风并停止重试', async () => {
    vi.useFakeTimers();
    const p = { checkPermissions: async () => ({ speechRecognition: 'granted' }), start: vi.fn(async () => { throw new Error('network'); }), stop: vi.fn(async () => {}) };
    const v = new NativeVoice({ plugin: p });
    await v.enable(); await vi.advanceTimersByTimeAsync(5000);
    expect(p.start).toHaveBeenCalledTimes(3); expect(v.mode).toBe('off');
  });
  it('轻量录音关闭时停止所有音轨和音频上下文', async () => {
    const track = { stop: vi.fn() }, processor = { connect: vi.fn(), disconnect: vi.fn() }, source = { connect: vi.fn(), disconnect: vi.fn() };
    const context = { resume: async () => {}, close: vi.fn(async () => {}), createMediaStreamSource: () => source, createScriptProcessor: () => processor };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    const v = new RecordedVoice({ getTranscriber: () => async () => '' });
    await v.enable(); expect(v.mode).toBe('vad'); v.disable();
    expect(track.stop).toHaveBeenCalledTimes(1); expect(processor.onaudioprocess).toBeNull(); expect(context.close).toHaveBeenCalledTimes(1);
  });
  it('安卓默认女声直接通过原生朗读，无需本机网关', async () => {
    const plugin = { synthesize: vi.fn(async () => ({ audio: btoa('mp3') })), cancel: vi.fn(async () => {}) };
    vi.stubGlobal('__jarvisEdgeSpeech', plugin);
    expect(resolveVoice({ keys: {}, voice: DEFAULT_VOICE }).engine).toBe('edge');
    const audio = await synthesize({ ...DEFAULT_VOICE, engine: 'edge' }, {}, '你好');
    expect(new TextDecoder().decode(audio)).toBe('mp3');
    expect(plugin.synthesize.mock.calls[0][0].voice).toBe('zh-CN-XiaoyiNeural');
  });
  it('取消原生合成会关闭对应连接，显式系统声音仍然保留', async () => {
    const ctrl = new AbortController();
    const plugin = { synthesize: vi.fn(async () => { ctrl.abort(); return { audio: btoa('mp3') }; }), cancel: vi.fn(async () => {}) };
    vi.stubGlobal('__jarvisEdgeSpeech', plugin);
    await expect(synthesize({ ...DEFAULT_VOICE, engine: 'edge' }, {}, '你好', { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(plugin.cancel).toHaveBeenCalledTimes(1);
    expect(resolveVoice({ voice: { engine: 'browser' } }).engine).toBe('browser');
  });
});
