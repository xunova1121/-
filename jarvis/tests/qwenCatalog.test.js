import { it, expect, vi } from 'vitest';
import { QWEN_VOICES, QWEN_TTS, qwenSettings, registerQwenVoices } from '../shared/qwenRealtime.js';
import { QWEN_VOICE_SOURCE, parseQwenVoiceCatalog } from '../shared/qwenVoiceCatalog.js';
import { createQwenVoiceCatalog } from '../server/qwenVoices.mjs';
import { fetchQwenCatalog, savedQwenCatalog } from '../src/perception/qwenCatalog.js';
import { createServer } from '../server/server.mjs';

const rows = QWEN_VOICES.map(([id, label]) => `<tr><td>名称：${label.split(' · ')[0]} voice 参数：${id} 描述：测试（女性）</td></tr>`).join('');
const fixture = '以下音色支持 <code>qwen3-tts-flash-realtime</code> 模型。<table>' + rows + '</table><h2>非实时语音合成</h2><tr><td>名称：其他 voice 参数：NotRealtime 描述：女性</td></tr>';

it('全部48条官方实时音色可使用，含有空格的英文ID，不混入其他模型', () => {
  expect(QWEN_VOICES).toHaveLength(48);
  const catalog = parseQwenVoiceCatalog(JSON.stringify({ content: fixture }));
  expect(catalog.voices).toHaveLength(48);
  expect(catalog.voices.some(([id]) => id === 'NotRealtime')).toBe(false);
  for (const id of ['Ethan', 'Kiki', 'Eldric Sage', 'Ono Anna', 'Radio Gol']) expect(qwenSettings(QWEN_TTS, { voice: id }).voice).toBe(id);
  expect(() => qwenSettings(QWEN_TTS, { voice: 'made-up' })).toThrow();
});
it('新版目录可注册新ID，元数据有上限，缺少实时章节时不猜目录', () => {
  registerQwenVoices([['NewOfficial', '新音色']]);
  expect(qwenSettings(QWEN_TTS, { voice: 'NewOfficial' }).voice).toBe('NewOfficial');
  registerQwenVoices(QWEN_VOICES);
  expect(() => registerQwenVoices(Array.from({ length: 201 }, (_, index) => ['V' + index, '测试']))).toThrow();
  expect(() => parseQwenVoiceCatalog('只有非实时音色')).toThrow();
  expect(() => registerQwenVoices([['bad\nvoice', '测试']])).toThrow();
});
it('固定官方地址、无Key，并发合并与缓存防重复刷新，过期后重新读取', async () => {
  let now = 100000;
  const fetchImpl = vi.fn(async (url, options) => { expect(url).toBe(QWEN_VOICE_SOURCE); expect(options.headers).toEqual({ Accept: 'text/html' }); return new Response(JSON.stringify({ content: fixture })); });
  const get = createQwenVoiceCatalog({ fetchImpl, now: () => now });
  await Promise.all([get(), get()]);
  await get({ refresh: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  now += 60001;
  await get({ refresh: true });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('客户端令牌仅发给选定云服务器，不发给官方目录；取消和失败保留上层决定', async () => {
  const data = { model: QWEN_TTS, source: QWEN_VOICE_SOURCE, voices: QWEN_VOICES, fetchedAt: Date.now() };
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url: String(url), options }); return new Response(JSON.stringify(data)); };
  await fetchQwenCatalog({ remote: { enabled: true, url: 'https://my-server.example', token: 'private-token' }, fetchImpl });
  expect(requests[0].url).toContain('https://my-server.example/api/voice/qwen/voices');
  expect(requests[0].options.headers.Authorization).toBe('Bearer private-token');
  const direct = vi.fn(async (_, options) => { expect(options.headers.Authorization).toBeUndefined(); return new Response(JSON.stringify({ content: fixture })); });
  await fetchQwenCatalog({ remote: { enabled: false }, fetchImpl: direct });
  expect(direct.mock.calls[0][0]).toBe(QWEN_VOICE_SOURCE);
  const aborted = Object.assign(new Error('stop'), { name: 'AbortError' });
  await expect(fetchQwenCatalog({ remote: { enabled: false }, fetchImpl: async () => { throw aborted; } })).rejects.toBe(aborted);
  expect(savedQwenCatalog({ ...data, fetchedAt: 1 })).toBeNull();
  expect(savedQwenCatalog({ ...data, rawHtml: '不保存正文' })).not.toHaveProperty('rawHtml');
});
it('目录接口继承云端鉴权，本机限制调用来源，不支持ASR目录', async () => {
  const local = createServer({ ollama: null });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + local.address().port;
    expect((await fetch(base + '/api/voice/qwen/voices')).status).toBe(403);
    expect((await fetch(base + '/api/voice/qwen/voices?model=qwen3-asr-flash-realtime', { headers: { 'x-jarvis-client': '1' } })).status).toBe(400);
  } finally { local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); }
  const cloud = createServer({ ollama: null, serverMode: { authorized: () => false, handle: () => false } });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fetch('http://127.0.0.1:' + cloud.address().port + '/api/voice/qwen/voices', { headers: { Origin: 'https://localhost' } });
    expect(result.status).toBe(401);
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
  } finally { cloud.closeAllConnections(); await new Promise(resolve => cloud.close(resolve)); }
});

it('安卓原生网络包装收到完整字符串网址，网页跨域失败仍能拉目录', async () => {
  const { wrapFetch } = await import('../src/mobile/nativeFetch.js');
  const data = { model: QWEN_TTS, source: QWEN_VOICE_SOURCE, voices: QWEN_VOICES, fetchedAt: Date.now() };
  const native = vi.fn(async (url, options) => {
    expect(typeof url).toBe('string');
    expect(url).toContain('https://my-server.example/api/voice/qwen/voices');
    expect(options.headers.Authorization).toBe('Bearer private-token');
    return new Response(JSON.stringify(data));
  });
  const fetchImpl = wrapFetch(async () => { throw new TypeError('模拟WebView跨域失败'); }, native, 'https://localhost', {});
  const result = await fetchQwenCatalog({ remote: { enabled: true, url: 'https://my-server.example', token: 'private-token' }, fetchImpl });
  expect(result.voices).toHaveLength(48);
  expect(native).toHaveBeenCalledTimes(1);
});
