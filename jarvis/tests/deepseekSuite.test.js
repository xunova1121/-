import { describe, it, expect, vi, afterEach } from 'vitest';
import { deepseekFileQuestion, deepseekOcr, deepseekAsr, deepseekTts } from '../src/llm/deepseekSuite.js';
import { attachmentQuestion } from '../src/agent/deepseekFileRead.js';
import { applySuggestedTitle, datedMessages } from '../src/llm/deepseekChat.js';
import { deepseekWebEvidence } from '../src/llm/deepseekWeb.js';
import { reverseImageMode } from '../src/agent/deepseekQuestion.js';
import { createAdapter } from '../src/llm/config.js';
import { ocrLine } from '../src/llm/ocr.js';
import { transcribe, encodeWav } from '../src/perception/stt.js';
import { memberModelConfig } from '../server/userRoutes.mjs';
import { synthesize } from '../src/perception/tts.js';
import { createOpenAIAdapter } from '../src/llm/openai.js';
import { createTools } from '../src/agent/tools.js';
import * as ws from '../src/agent/workspace.js';

const cfg = { provider: 'deepseek', models: { deepseek: 'deepseek-flash' }, keys: { deepseek: 'official-test' }, deepseekSuite: true };
const pdf = { name: 'example.pdf', blob: new Blob(['example']), layout: true };
const json = value => Response.json(value);
const wav = encodeWav(new Float32Array(160));
const fetchOnce = (value) => vi.fn(async () => json(value));
afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek 官方附件协议', () => {
  it.each([['example.pdf', true, 'rich_layout_recognition'], ['example.docx', false, 'text_recognition'], ['table.xlsx', true, 'user_data']])('解析、据附件作答、仅清理本次文件 %s', async (name, layout, purpose) => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init.headers.authorization).toBe('Bearer official-test');
      if (url.endsWith('/files')) {
        expect([...init.body.keys()]).toEqual(['purpose', 'expires_after[anchor]', 'expires_after[seconds]', 'file']);
        expect(init.body.get('purpose')).toBe(purpose);
        expect(init.body.get('expires_after[seconds]')).toBe('3600');
        expect(init.body.get('file').name).toBe(name);
        return json({ id: 'file-api-unit' });
      }
      if (init.method === 'DELETE') { expect(url).toMatch(/\/files\/file-api-unit$/); return json({ deleted: true }); }
      expect(JSON.parse(init.body)).toMatchObject({ model: 'deepseek-flash', safety_check: { level: 'high' } });
      expect(JSON.parse(init.body).messages.at(-1).content).toEqual([{ type: 'file', file_id: 'file-api-unit' }, { type: 'text', text: '主要内容' }]);
      return json({ choices: [{ message: { content: '附件答案' }, finish_reason: 'stop' }] });
    });
    await expect(deepseekFileQuestion(cfg, { ...pdf, name, layout }, '主要内容', { fetchImpl })).resolves.toBe('附件答案');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('中止或内容审核时仍独立清理，且不再上传', async () => {
    for (const abort of [false, true]) {
      const ctrl = new AbortController();
      const fetchImpl = vi.fn().mockResolvedValueOnce(json({ id: 'file-api-owned' })).mockImplementationOnce(async () => {
        if (abort) { ctrl.abort(); throw new DOMException('中止', 'AbortError'); }
        return json({ choices: [{ finish_reason: 'content_filter', message: { content: '禁止展示' } }] });
      }).mockResolvedValueOnce(json({ deleted: true }));
      await expect(deepseekFileQuestion(cfg, pdf, '问题', { signal: ctrl.signal, fetchImpl })).rejects.toThrow();
      const [, cleanup] = fetchImpl.mock.calls[2];
      expect(cleanup.method).toBe('DELETE'); expect(cleanup.signal.aborted).toBe(false);
    }
  });
  it('拒绝异常文件编号与错误封装，保留 OCR 页序及截断标记', async () => {
    const fetchImpl = fetchOnce({ id: '../other' });
    await expect(deepseekFileQuestion(cfg, pdf, '问题', { fetchImpl })).rejects.toThrow('编号');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(deepseekOcr(cfg, pdf, { fetchImpl: fetchOnce({ error: { code: 'invalid_input' } }) })).rejects.toThrow('invalid_input');
    const ocr = fetchOnce({ page_count: 2, pages: [{ index: 1, text: '第二', finish_reason: 'length' }, { index: 0, text: '第一', finish_reason: 'stop' }] });
    expect((await deepseekOcr(cfg, pdf, { fetchImpl: ocr })).text).toMatch(/第一\s+第二.*\s+\[第 2 页/);
    expect([...ocr.mock.calls[0][1].body.keys()]).toEqual(['purpose', 'file']);
    expect(ocrLine(cfg)?.provider).toBe('deepseek');
    expect(ocrLine({ ...cfg, deepseekSuite: false })).toBeNull();
  });
  it('只有本轮明确附上的文件进入问答，常规读取保留原文', async () => {
    const path = 'suite-doc.md', question = '总结一下这份附件';
    const rawRequestText = question + '\n\n[已上传到工作区：' + path + ']';
    expect(attachmentQuestion(rawRequestText, 'other.md', true)).toBe('');
    expect(attachmentQuestion('不要上传\n\n[已上传到工作区：suite-doc.md]', path, true)).toBe('');
    await ws.write(path, new Blob(['原文']));
    const askFile = vi.fn(async () => '附件结果');
    const read = createTools({ askFile }).find(tool => tool.name === 'read_file');
    const executionScope = {};
    await expect(read.run({ path }, { rawRequestText, executionScope })).resolves.toContain('附件结果');
    await read.run({ path }, { rawRequestText, executionScope });
    await expect(read.run({ path })).resolves.toContain('原文');
    expect(askFile).toHaveBeenCalledTimes(1);
  });
});

describe('语音、搜图与对话扩展', () => {
  it('录音转写上传单个音频字段，朗读接收 WAV', async () => {
    const asr = fetchOnce({ text: '你好', duration_ms: 10 });
    expect(await transcribe('deepseek', cfg, wav, { fetchImpl: asr })).toBe('你好');
    expect([...asr.mock.calls[0][1].body.keys()]).toEqual(['file']);
    expect(asr.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/asr');
    const tts = vi.fn(async () => new Response(wav));
    const audio = await synthesize({ engine: 'deepseek', voices: { deepseek: 'tide' } }, cfg.keys, '你好', { fetchImpl: tts });
    expect(audio.byteLength).toBe(wav.size);
    expect(JSON.parse(tts.mock.calls[0][1].body)).toEqual({ text: '你好', voice_id: 'tide', format: 'wav', filter_markdown: true });
    await expect(deepseekAsr({ keys: { openai: 'other' } }, wav, { fetchImpl: asr })).rejects.toThrow('官方');
    await expect(deepseekTts(cfg, '你好', 'stella', { fetchImpl: fetchOnce({ error: 'bad' }) })).rejects.toThrow();
  });
  it('北京时间、无地理位置、手工标题优先', () => {
    const user = { role: 'user', content: '明天' };
    expect(datedMessages([user], new Date('2026-11-18T17:00:00Z'))).toEqual([{ role: 'latest_reminder', content: '2026-11-19,星期四,,Web,中文' }, user]);
    const session = { messages: [user] };
    expect(applySuggestedTitle(session, '明日计划')).toBe(true);
    expect(applySuggestedTitle(session, '其他')).toBe(false);
    expect(session.title).toBe('明日计划');
  });
  it('安全审核失败前不展示流出的片段，正常结束时才接收标题', async () => {
    for (const filtered of [true, false]) {
      const fetchImpl = vi.fn(async () => new Response([{ delta: { content: '文本' } }, { delta: { title: '标题' }, finish_reason: filtered ? 'content_filter' : 'stop' }].map(choice => 'data: ' + JSON.stringify({ choices: [choice] }) + '\n\n').join('') + 'data: [DONE]\n\n'));
      vi.stubGlobal('fetch', fetchImpl); const onText = vi.fn();
      const run = createAdapter(cfg).adapter.stream({ model: 'deepseek-flash', system: [], messages: [{ role: 'user', content: '你好' }], requestTitle: true, onText });
      if (filtered) { await expect(run).rejects.toMatchObject({ code: 'MODEL_CONTENT_FILTER' }); expect(onText).not.toHaveBeenCalled(); }
      else { await expect(run).resolves.toMatchObject({ title: '标题' }); expect(onText).toHaveBeenCalledWith('文本'); }
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.safety_check).toEqual({ level: 'high' }); expect(body.title.enabled).toBe(true);
      expect(body.messages.at(-2).role).toBe('latest_reminder');
    }
  });
  it('普通兼容服务商沿用原协议', async () => {
    const mock = vi.fn(async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
    vi.stubGlobal('fetch', mock);
    await createOpenAIAdapter({ baseURL: 'https://example.org/v1' }).stream({ model: 'other', system: [], messages: [{ role: 'user', content: 'hello' }], requestTitle: true });
    const data = JSON.parse(mock.mock.calls[0][1].body);
    expect(data.title).toBeUndefined(); expect(data.safety_check).toBeUndefined(); expect(data.messages.at(-1).role).toBe('user');
  });
  it('只展示成功搜图返回的公开原图和来源，普通看图不联网', () => {
    expect(reverseImageMode('找这张图的出处', [{}])).toBe('quick');
    expect(reverseImageMode('分析这张图', [{}])).toBe('');
    expect(reverseImageMode('以图搜图', [])).toBe('');
    const evidence = deepseekWebEvidence();
    const call = { type: 'deepseek_web_search', id: 'one', kind: 'image_search', action: { type: 'search' }, sources: [{ url: 'https://example.org/report', image_url: 'https://example.org/photo.jpg' }, { url: 'https://example.org/report', image_url: 'http://127.0.0.1/a' }] };
    evidence.push({ server_tool_event: { type: 'call_completed', call: { ...call, status: 'failed' } } });
    expect(evidence.imageResults()).toEqual([]);
    evidence.push({ server_tool_event: { type: 'call_completed', call: { ...call, status: 'completed' } } });
    expect(evidence.imageResults()).toEqual([{ url: 'https://example.org/report', imageUrl: 'https://example.org/photo.jpg' }]);
  });
});

describe('服务器凭证与流式朗读', () => {
  it('服务器模式使用登录凭证，服务商的私钥从未交给设备', async () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ enabled: true, token: 'device-session', url: 'https://my-weiyang.example' }) });
    const fetchImpl = fetchOnce({ text: '服务器识别' });
    expect(await transcribe('deepseek', { keys: { deepseek: '••••masked' } }, wav, { fetchImpl })).toBe('服务器识别');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://my-weiyang.example/api/server/deepseek/voice/asr');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ authorization: 'Bearer device-session' });
  });
  it('评测身份及未启用服务的成员不能调用付费语音', async () => {
    const { createDeepseekVoiceRoute } = await import('../server/deepseekVoice.mjs');
    const fetchImpl = vi.fn(), json = vi.fn();
    const route = createDeepseekVoiceRoute({ loadConfig: () => ({ ...cfg, deepseekSuite: false }), json, fetchImpl });
    for (const role of ['evaluation', 'member']) await route({ method: 'POST' }, {}, '/api/server/deepseek/voice/asr', { role });
    expect(json.mock.calls.map(c => c[1])).toEqual([403, 403]); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('WebSocket 使用固定官方地址、支持分片、终态及半途取消', async () => {
    const { streamDeepseekPcm } = await import('../shared/deepseekSpeech.js');
    for (const state of ['complete', 'abort', 'filter']) {
      const ctrl = new AbortController();
      const ws = { send: vi.fn(), close: vi.fn() };
      const onChunk = vi.fn();
      const open = vi.fn(() => ws);
      const run = streamDeepseekPcm('你好', { open, key: 'fixture', voice: 'tide', signal: ctrl.signal, onChunk });
      ws.onopen();
      expect(open.mock.calls[0][0]).toBe('wss://api.deepseek.com/v1/tools/tts?format=pcm&filter_markdown=true&voice_id=tide');
      expect(ws.send.mock.calls.map(([s]) => JSON.parse(s).event)).toEqual(['text', 'finish_text']);
      ws.onmessage({ data: new Int16Array([1500]).buffer });
      if (state === 'abort') ctrl.abort();
      else ws.onmessage({ data: JSON.stringify({ event: 'finish', code: state === 'complete' ? 'success' : 'content_filter' }) });
      if (state === 'complete') await run;
      else await expect(run).rejects.toThrow();
      expect(ws.close).toHaveBeenCalled(); expect(onChunk).toHaveBeenCalledOnce();
    }
  });
  it('经过未央服务器的 PCM 按 24 kHz 解码，断流不能算完整播放', async () => {
    const { streamDeepseekSpeech } = await import('../src/perception/deepseekVoice.js');
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ enabled: true, token: 'device-session', url: 'https://my-weiyang.example' }) });
    for (const complete of [false, true]) {
      const onAudio = vi.fn();
      const fetchImpl = vi.fn(async () => new Response('{"pcm":"AEA="}\n' + (complete ? '{"done":true}\n' : '')));
      const run = streamDeepseekSpeech('你好', { voice: 'tide', key: 'unused-local', onAudio, fetchImpl });
      if (complete) await run; else await expect(run).rejects.toThrow('完整');
      expect(onAudio.mock.calls[0][0][0]).toBe(0.5);
      expect(onAudio.mock.calls[0][1]).toBe(24000);
      expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer device-session');
    }
  });
});

it('按图搜索贯穿会话入口，将当前原图传给官方工具，只展示匹配来源', async () => {
  const { runAgent } = await import('../src/agent/agent.js');
  const tools = ['web_search', 'fetch_url'].map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run: vi.fn() }));
  const call = { id: 'search-1', kind: 'image_search', type: 'deepseek_web_search', action: { type: 'search', queries: [] }, status: 'completed', sources: [{ url: 'https://example.org/report', image_url: 'https://example.org/pic.jpg' }] };
  const choices = [{ delta: {}, server_tool_event: { type: 'call_completed', call } }, { delta: { content: '未经引用的模型描述', title: '图片出处' }, finish_reason: 'stop' }];
  const fetchImpl = vi.fn(async () => new Response(choices.map(choice => 'data: ' + JSON.stringify({ choices: [choice] }) + '\n\n').join('') + 'data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetchImpl);
  const img = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mQAAAAASUVORK5CYII=' };
  const events = [];
  const result = await runAgent({ ...createAdapter({ ...cfg, deepseekNativeWeb: true }), tools, history: [], userText: '找这张图的出处', images: [img], quiet: true, isolated: true, emit: e => events.push(e) });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages.at(-1).content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + img.data } });
  expect(result.text).toContain('[来源网页](https://example.org/report)');
  expect(result.text).not.toContain('未经引用的模型描述');
  expect(events).toContainEqual({ type: 'conversation_title', title: '图片出处' });
});

it('云模式服务端重新构造官方鉴权与文件上传，收到的数据可播放', async () => {
  const { createDeepseekVoiceRoute } = await import('../server/deepseekVoice.mjs');
  const { EventEmitter } = await import('node:events');
  const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() });
  const form = new FormData(); form.append('file', wav, 'speech.wav');
  const encoded = new Response(form), bytes = Buffer.from(await encoded.arrayBuffer());
  const fetchImpl = vi.fn(async (url, init) => {
    expect(init.headers.authorization).toBe('Bearer official-test');
    if (url.endsWith('/asr')) { expect(await init.body.get('file').arrayBuffer()).toEqual(await wav.arrayBuffer()); return json({ text: '成功' }); }
    return new Response(wav);
  });
  const sendJson = vi.fn();
  const handle = createDeepseekVoiceRoute({ loadConfig: () => cfg, readBody: async () => bytes, readJson: async () => ({ text: '你好', voice: 'tide' }), json: sendJson, fetchImpl });
  const req = { method: 'POST', headers: { authorization: 'Bearer device-session', 'content-type': encoded.headers.get('content-type') } };
  await handle(req, res, '/api/server/deepseek/voice/asr', { role: 'owner' });
  expect(sendJson).toHaveBeenCalledWith(res, 200, { text: '成功' });
  await handle(req, res, '/api/server/deepseek/voice/tts', { role: 'member' });
  expect(res.end.mock.calls[0][0]).toEqual(Buffer.from(await wav.arrayBuffer()));
});

it('手机付费请求选一次传输，流式失败不重复提交', async () => {
  const { wrapFetch } = await import('../src/mobile/nativeFetch.js');
  const web = vi.fn().mockRejectedValue(new TypeError('模拟断流')), native = vi.fn(async () => new Response('ok'));
  const request = wrapFetch(web, native, 'https://localhost');
  const url = 'https://example.org/asr';
  await request(url, { method: 'POST', noNetworkRetry: true });
  await expect(request(url, { method: 'POST', stream: true, noNetworkRetry: true })).rejects.toThrow('断流');
  expect(web).toHaveBeenCalledOnce(); expect(native).toHaveBeenCalledOnce();
});

it('文件输入被官方拒绝时保留审核原因，停止后续处理', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ error: { message: 'Content Exists Risk' } }, { status: 400 }));
  await expect(deepseekFileQuestion(cfg, pdf, '读文件', { fetchImpl })).rejects.toMatchObject({ code: 'MODEL_CONTENT_FILTER' });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('成员只得到已开放的语音能力，不下发服务器密钥', () => {
  for (const [suite, key, allowed] of [[true, 'test-official', true], [false, 'test-official', false], [true, '', false]]) {
    const cfg = memberModelConfig({ deepseekSuite: suite, keys: { deepseek: key }, deepseekSearchKey: 'search-only' });
    expect(cfg.deepseekVoiceAvailable).toBe(allowed);
    expect(cfg.keys).toEqual({});
    expect(JSON.stringify(cfg)).not.toMatch(/test-official|search-only/);
  }
});
