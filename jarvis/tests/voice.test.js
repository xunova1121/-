import { describe, it, expect } from 'vitest';
import { synthesize, rankBrowserVoices, TTS_ENGINES, DIRECTION } from '../src/perception/tts.js';
import { FX_PRESETS } from '../src/perception/voiceFx.js';
import { resolveVoice, DEFAULT_VOICE } from '../src/llm/config.js';

function fakeFetch() {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  f.calls = calls;
  return f;
}

describe('云端语音请求', () => {
  it('OpenAI：gpt-4o-mini-tts + 表演指导，避免播报腔', async () => {
    const f = fakeFetch();
    await synthesize({ engine: 'openai', voices: { openai: 'ash' } }, { openai: 'sk-x' }, '你好', { fetchImpl: f });
    const c = f.calls[0];
    expect(c.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(c.init.headers.authorization).toBe('Bearer sk-x');
    expect(c.body).toMatchObject({ model: 'gpt-4o-mini-tts', input: '你好', voice: 'ash', response_format: 'mp3' });
    expect(c.body.instructions).toBe(DIRECTION);
    expect(DIRECTION).toMatch(/never robotic/);
  });

  it('ElevenLabs：声音 ID 在路径里，密钥用 xi-api-key', async () => {
    const f = fakeFetch();
    await synthesize({ engine: 'elevenlabs', voices: {} }, { elevenlabs: 'el-key' }, '收到', { fetchImpl: f });
    const c = f.calls[0];
    expect(c.url).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/onwK4e9ZLuTAKqWW03F9\?output_format=mp3/);
    expect(c.init.headers['xi-api-key']).toBe('el-key');
    expect(c.body).toMatchObject({ text: '收到', model_id: 'eleven_multilingual_v2' });
  });

  it('硅基流动：声音名带模型前缀；有网关时走网关并使用网关密钥', async () => {
    const f = fakeFetch();
    await synthesize({ engine: 'siliconflow', voices: { siliconflow: 'charles' } }, {}, '好的', { fetchImpl: f, gateway: { origin: 'http://127.0.0.1:8787', keys: ['siliconflow'] } });
    const c = f.calls[0];
    expect(c.url).toBe('http://127.0.0.1:8787/api/llm/siliconflow/audio/speech');
    expect(c.body.voice).toBe('FunAudioLLM/CosyVoice2-0.5B:charles');
    expect(c.init.headers.authorization).toBe('Bearer use-gateway-key');
  });

  it('自定义接口：可以不带密钥', async () => {
    const f = fakeFetch();
    await synthesize({ engine: 'custom', voices: {}, customURL: 'http://127.0.0.1:9880/v1/', customModel: 'cosyvoice', customVoice: 'jarvis' }, {}, 'hi', { fetchImpl: f });
    const c = f.calls[0];
    expect(c.url).toBe('http://127.0.0.1:9880/v1/audio/speech');
    expect(c.init.headers.authorization).toBeUndefined();
    expect(c.body).toMatchObject({ model: 'cosyvoice', voice: 'jarvis' });
  });

  it('缺密钥、接口报错时给出可读的错误', async () => {
    await expect(synthesize({ engine: 'openai', voices: {} }, {}, 'x', { fetchImpl: fakeFetch() })).rejects.toThrow(/API Key/);
    const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid key' } }) });
    await expect(synthesize({ engine: 'openai', voices: {} }, { openai: 'k' }, 'x', { fetchImpl: bad })).rejects.toThrow(/401 Invalid key/);
  });

  it('每个云端引擎都有默认声音', () => {
    for (const e of TTS_ENGINES.filter((x) => x.id !== 'browser' && !x.custom)) expect(e.voices.length).toBeGreaterThan(0);
  });
});

describe('语音引擎选择', () => {
  const cfg = (keys, engine = 'auto') => ({ keys, voice: { ...DEFAULT_VOICE, engine } });
  it('auto：按已有密钥挑最自然的云端声音', () => {
    expect(resolveVoice(cfg({})).engine).toBe('browser');
    expect(resolveVoice(cfg({ openai: 'k' })).engine).toBe('openai');
    expect(resolveVoice(cfg({ openai: 'k', elevenlabs: 'e' })).engine).toBe('elevenlabs');
    expect(resolveVoice(cfg({ siliconflow: 'k' })).engine).toBe('browser'); // 单文件版不能直连
    expect(resolveVoice(cfg({ siliconflow: 'k' }), { keys: [] }).engine).toBe('siliconflow');
  });
  it('手动选择优先', () => {
    expect(resolveVoice(cfg({ openai: 'k' }, 'browser')).engine).toBe('browser');
  });
  it('浏览器声音：神经网络声音、中文男声排前面', () => {
    const vs = [
      { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' },
      { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
      { name: 'Microsoft Yunjian Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' },
      { name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' },
      { name: 'Thomas', lang: 'fr-FR' }
    ];
    const r = rankBrowserVoices(vs).map((v) => v.name);
    expect(r[0]).toMatch(/Yunjian/);
    expect(r[1]).toMatch(/Xiaoxiao/);
    expect(r).not.toContain('Thomas');
  });
});

describe('声线预设', () => {
  it('效果保持克制：变调不超过 1.5 个半音，混响不过量', () => {
    for (const p of Object.values(FX_PRESETS)) {
      expect(Math.abs(p.detune)).toBeLessThanOrEqual(150);
      expect(p.reverb).toBeLessThanOrEqual(0.3);
      expect(p.ring).toBeLessThanOrEqual(0.15);
    }
    expect(FX_PRESETS.none.detune).toBe(0);
  });
});
