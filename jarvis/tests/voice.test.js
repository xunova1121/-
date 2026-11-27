import { describe, it, expect } from 'vitest';
import { synthesize, rankBrowserVoices, TTS_ENGINES } from '../src/perception/tts.js';
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

describe('云端语音请求（只留百炼实时、免费在线、系统自带三种）', () => {
  it('只有三种引擎，免费在线声音有默认声音', () => {
    expect(TTS_ENGINES.map((e) => e.id)).toEqual(['qwen-realtime', 'edge', 'browser']);
    expect(TTS_ENGINES.find((e) => e.id === 'edge').voices.length).toBeGreaterThan(0);
  });
  it('免费在线声音：经本机网关 /api/tts/edge，带上文字和声音', async () => {
    const f = fakeFetch();
    await synthesize({ engine: 'edge', voices: { edge: 'zh-CN-XiaoyiNeural' } }, {}, '你好', { fetchImpl: f, gateway: { origin: 'http://127.0.0.1:8787', keys: [] } });
    const c = f.calls[0];
    expect(c.url).toBe('http://127.0.0.1:8787/api/tts/edge');
    expect(c.init.headers['x-jarvis-client']).toBe('1');
    expect(c.body).toMatchObject({ text: '你好', voice: 'zh-CN-XiaoyiNeural' });
  });
  it('没有网关也没有安卓插件、接口报错、去掉的引擎：给出可读的错误', async () => {
    await expect(synthesize({ engine: 'edge', voices: {} }, {}, 'x', { fetchImpl: fakeFetch() })).rejects.toThrow(/本机网关/);
    const bad = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await expect(synthesize({ engine: 'edge', voices: {} }, {}, 'x', { fetchImpl: bad, gateway: { origin: 'http://g' } })).rejects.toThrow(/语音合成失败：boom/);
    await expect(synthesize({ engine: 'azure', voices: {} }, {}, 'x', { fetchImpl: fakeFetch() })).rejects.toThrow(/不是云端语音引擎/);
  });
});

describe('语音引擎选择', () => {
  const cfg = (keys, engine = 'auto') => ({ keys, voice: { ...DEFAULT_VOICE, engine } });
  it('auto：有百炼密钥且能连上用百炼，否则有网关用免费在线声音，都没有用系统自带', () => {
    expect(resolveVoice(cfg({})).engine).toBe('browser');
    expect(resolveVoice(cfg({}), { keys: [] }).engine).toBe('edge');
    expect(resolveVoice(cfg({ qwen: 'k' }), { keys: [] }).engine).toBe('qwen-realtime');
    expect(resolveVoice(cfg({ openai: 'k', elevenlabs: 'e' }), { keys: [] }).engine).toBe('edge'); // 去掉的引擎不再自动选
  });
  it('以前手动选过、现在去掉的引擎：按自动处理', () => {
    expect(resolveVoice(cfg({}, 'azure'), { keys: [] }).engine).toBe('edge');
    expect(resolveVoice(cfg({}, 'elevenlabs')).engine).toBe('browser');
  });
  it('手动选择优先', () => {
    expect(resolveVoice(cfg({ openai: 'k' }, 'browser')).engine).toBe('browser');
  });
  it('浏览器声音：优先温柔中文声音，不选不支持的语言', () => {
    const vs = [
      { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' },
      { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
      { name: 'Microsoft Yunjian Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' },
      { name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' },
      { name: 'Thomas', lang: 'fr-FR' }
    ];
    const r = rankBrowserVoices(vs).map((v) => v.name);
    expect(r[0]).toMatch(/Xiaoxiao/);
    expect(r[1]).toMatch(/Yunjian/);
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
