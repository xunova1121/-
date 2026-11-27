import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeVoice } from '../src/mobile/nativeVoice.js';
import { RecordedVoice } from '../src/mobile/recordedVoice.js';
import { QwenVoice } from '../src/perception/qwenVoice.js';
import { chooseVoiceInput, createVoiceInput } from '../src/perception/voiceInputFactory.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function native(start = () => new Promise(() => {})) {
  const events = {};
  return {
    events,
    checkPermissions: vi.fn(async () => ({ speechRecognition: 'granted' })),
    addListener: vi.fn(async (name, fn) => { events[name] = fn; return { remove: vi.fn() }; }),
    start: vi.fn(start), stop: vi.fn(async () => {})
  };
}

describe('手机语音从失败的系统识别恢复', () => {
  it('自动模式先用系统；失败后百炼走实时收音器，不调用文件转写', () => {
    const options = { mobile: true, nativeAvailable: true, requested: 'auto', resolved: 'qwen-realtime' };
    expect(chooseVoiceInput(options)).toBe('native');
    const kind = chooseVoiceInput({ ...options, nativeFailed: true });
    expect(kind).toBe('qwen');
    expect(createVoiceInput(kind, { getConfig: () => ({}), handlers: {} })).toBeInstanceOf(QwenVoice);
    expect(chooseVoiceInput({ ...options, requested: 'qwen-realtime' })).toBe('qwen');
    expect(chooseVoiceInput({ ...options, resolved: 'siliconflow', nativeFailed: true })).toBe('recorded');
  });
  it('未返回任何收音状态时8秒结束等待，切换一次，不再假装正在听', async () => {
    vi.useFakeTimers();
    let finish;
    const p = native(() => new Promise(resolve => { finish = resolve; }));
    const fallback = vi.fn(), final = vi.fn();
    const v = new NativeVoice({ plugin: p, canFallback: () => true, onUnavailable: fallback, onFinal: final });
    await v.enable(); await vi.advanceTimersByTimeAsync(8001);
    expect(v.mode).toBe('off'); expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toContain('没有开始收音');
    expect(p.stop).toHaveBeenCalled();
    finish({ matches: ['迟到的结果'] }); await vi.advanceTimersByTimeAsync(40000);
    expect(final).not.toHaveBeenCalled(); expect(p.start).toHaveBeenCalledTimes(1);
  });
  it('收到真实ready后可以继续听，不能被启动超时误杀；结果仍有上限', async () => {
    vi.useFakeTimers();
    const p = native(), fallback = vi.fn();
    const v = new NativeVoice({ plugin: p, canFallback: () => true, onUnavailable: fallback });
    await v.enable(); await vi.advanceTimersByTimeAsync(1);
    p.events.state({ phase: 'ready' });
    await vi.advanceTimersByTimeAsync(9000);
    expect(v.mode).toBe('vad'); expect(fallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(26000);
    expect(fallback).toHaveBeenCalledTimes(1); expect(fallback.mock.calls[0][0]).toContain('没有返回识别结果');
  });
  it('连续无结果不能无限重启识别器，有配置时切云端', async () => {
    vi.useFakeTimers();
    const p = native(async () => { throw new Error('No speech'); });
    const fallback = vi.fn();
    const v = new NativeVoice({ plugin: p, canFallback: () => true, onUnavailable: fallback });
    await v.enable(); await vi.advanceTimersByTimeAsync(5000);
    expect(p.start).toHaveBeenCalledTimes(3); expect(fallback).toHaveBeenCalledTimes(1); expect(v.mode).toBe('off');
  });
  it('没有云端配置时给出可操作原因，不能静默停住', async () => {
    vi.useFakeTimers();
    const p = native(async () => ({ matches: [] })), error = vi.fn();
    const v = new NativeVoice({ plugin: p, onError: error });
    await v.enable(); await vi.advanceTimersByTimeAsync(2000);
    expect(v.mode).toBe('off'); expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('检查麦克风');
  });
  it('权限拒绝不能偷偷改用云端继续采集', async () => {
    vi.useFakeTimers();
    const p = native(async () => { throw new Error('麦克风权限被拒绝'); }), fallback = vi.fn();
    const v = new NativeVoice({ plugin: p, canFallback: () => true, onUnavailable: fallback });
    await v.enable(); await vi.advanceTimersByTimeAsync(10);
    expect(v.mode).toBe('off');
    expect(fallback).not.toHaveBeenCalled(); expect(p.start).toHaveBeenCalledTimes(1);
  });
  it('在权限检查期间挂断，迟到的授权结果不能重新开启麦克风', async () => {
    vi.useFakeTimers();
    let authorize;
    const p = native(); p.checkPermissions = () => new Promise(resolve => { authorize = resolve; });
    const v = new NativeVoice({ plugin: p });
    const enabled = v.enable(); v.disable(); authorize({ speechRecognition: 'granted' });
    expect(await enabled).toBe('off'); await vi.advanceTimersByTimeAsync(1000);
    expect(p.start).not.toHaveBeenCalled(); expect(v.mode).toBe('off');
  });
  it('挂断后再打开解除旧朗读抑制，能重新开始收音', async () => {
    vi.useFakeTimers();
    const p = native(), v = new NativeVoice({ plugin: p });
    await v.enable(); v.setSuppressed(true); v.disable(); await v.enable();
    await vi.advanceTimersByTimeAsync(1); expect(p.start).toHaveBeenCalledTimes(1); v.disable();
  });
});

function recorder(transcriber, handlers = {}) {
  const track = { stop: vi.fn() }, processor = { connect() {}, disconnect() {} };
  const context = { sampleRate: 16000, resume: async () => {}, close: async () => {}, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createScriptProcessor: () => processor };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  return { voice: new RecordedVoice({ getTranscriber: () => transcriber, ...handlers }), processor, track };
}
describe('手机文件转写的收音及结果等待', () => {
  it('拿到权限但没有PCM帧，报明原因并关闭麦克风', async () => {
    vi.useFakeTimers(); const error = vi.fn();
    const { voice, track } = recorder(async () => '', { onError: error });
    await voice.enable(); await vi.advanceTimersByTimeAsync(8000);
    expect(voice.mode).toBe('off'); expect(track.stop).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('没有返回音频');
  });
  it('静音帧证明采集已工作，不把用户尚未说话误报为麦克风故障', async () => {
    vi.useFakeTimers(); const error = vi.fn();
    const { voice } = recorder(async () => '', { onError: error });
    await voice.enable(); voice.process(new Float32Array(4096));
    await vi.advanceTimersByTimeAsync(9000);
    expect(error).not.toHaveBeenCalled(); expect(voice.mode).toBe('vad'); voice.disable();
  });
  it('文件转写无响应30秒退出等待并取消请求，后续可重新说话', async () => {
    vi.useFakeTimers(); const error = vi.fn(), phases = [], transcriber = vi.fn(() => new Promise(() => {}));
    const { voice } = recorder(transcriber, { onError: error, onStatus: p => phases.push(p) });
    await voice.enable(); voice.process(new Float32Array(4096)); voice.frames = [new Float32Array(1600).fill(.1)];
    const pending = voice.commit(); await vi.advanceTimersByTimeAsync(30000); await pending;
    expect(error.mock.calls[0][0]).toContain('转写超时'); expect(transcriber.mock.calls[0][1].aborted).toBe(true);
    expect(voice.busy).toBe(false); expect(phases).toEqual(['ready', 'processing', 'ready']); voice.disable();
  });
});
