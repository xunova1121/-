import { describe, it, expect, vi } from 'vitest';
import { resolveStt, transcribe } from '../src/perception/stt.js';
import { NativeVoice } from '../src/mobile/nativeVoice.js';

const relay = { provider: 'custom', keys: { custom: 'sk-1' }, baseURLs: { custom: 'https://teamorouter.com/v1' }, models: { custom: 'gpt-6.1-sol' } };

describe('语音转写引擎选择', () => {
  it('没有专门的语音密钥时，用当前模型服务商转写', () => {
    expect(resolveStt(relay, { browserSupported: false })).toBe('provider');
    expect(resolveStt({ ...relay, keys: { ...relay.keys, siliconflow: 's' } }, { browserSupported: false })).toBe('siliconflow');
    expect(resolveStt({ provider: 'mock', keys: {} }, { browserSupported: false })).toBe('none');
    expect(resolveStt(relay, { browserSupported: true })).toBe('browser');
  });

  it('依次试转写模型，记住能用的；都不支持时说清楚', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push([url, init.body.get('model')]);
      return init.body.get('model') === 'whisper-1'
        ? new Response(JSON.stringify({ text: '打开周报' }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    };
    const wav = new Blob([new Uint8Array(10)], { type: 'audio/wav' });
    expect(await transcribe('provider', relay, wav, { fetchImpl })).toBe('打开周报');
    expect(calls).toEqual([['https://teamorouter.com/v1/audio/transcriptions', 'gpt-4o-mini-transcribe'], ['https://teamorouter.com/v1/audio/transcriptions', 'whisper-1']]);
    calls.length = 0;
    await transcribe('provider', relay, wav, { fetchImpl });
    expect(calls.map((c) => c[1])).toEqual(['whisper-1']);
    const none = async () => new Response('{"error":{"message":"not supported"}}', { status: 404 });
    await expect(transcribe('provider', { ...relay, baseURLs: { custom: 'https://other/v1' } }, wav, { fetchImpl: none })).rejects.toThrow('不支持语音转写');
  });
});

describe('手机系统语音识别', () => {
  const plugin = (results) => ({
    available: async () => ({ available: true }),
    checkPermissions: async () => ({ speechRecognition: 'granted' }),
    requestPermissions: async () => ({ speechRecognition: 'granted' }),
    start: vi.fn(async () => { const r = results.shift(); if (r instanceof Error) throw r; if (r === undefined) return new Promise(() => {}); return { matches: [r] }; }),
    stop: vi.fn(async () => {})
  });

  it('听到一句就交给对话，没听清安静地接着听，朗读时暂停', async () => {
    vi.useFakeTimers();
    const finals = [];
    const errors = [];
    const p = plugin(['你好未央', new Error('No match'), '帮我写周报']);
    const v = new NativeVoice({ plugin: p, onFinal: (t) => finals.push(t), onError: (e) => errors.push(e), onMode: () => {} });
    await v.enable();
    await vi.advanceTimersByTimeAsync(2000);
    expect(finals).toEqual(['你好未央', '帮我写周报']);
    expect(errors).toEqual([]);
    v.setSuppressed(true);
    const n = p.start.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.start.mock.calls.length).toBe(n);
    v.disable();
    expect(v.mode).toBe('off');
    vi.useRealTimers();
  });

  it('网络等真正的错误要提示', async () => {
    vi.useFakeTimers();
    const errors = [];
    const v = new NativeVoice({ plugin: plugin([new Error('Network error')]), onError: (e) => errors.push(e), onMode: () => {} });
    await v.enable();
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(['语音识别：Network error']);
    v.disable();
    vi.useRealTimers();
  });
});

import { sttCandidates } from '../src/perception/stt.js';
describe('用中转站转写：先试模型列表里真有的转写模型', () => {
  it('whisper-large-v3、SenseVoice 等排在前面，跳过 tts / realtime', () => {
    const cfg = { modelLists: { k: { ids: ['gpt-6.1-sol', 'whisper-large-v3', 'FunAudioLLM/SenseVoiceSmall', 'gpt-4o-mini-tts', 'gpt-4o-realtime-preview'] } } };
    expect(sttCandidates(cfg).slice(0, 2)).toEqual(['whisper-large-v3', 'FunAudioLLM/SenseVoiceSmall']);
    expect(sttCandidates(cfg)).not.toContain('gpt-4o-mini-tts');
    expect(sttCandidates({})[0]).toBe('gpt-4o-mini-transcribe');
  });
});
