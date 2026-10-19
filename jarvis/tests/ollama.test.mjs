import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createOllama, ollamaHost, findOllamaBinary } from '../server/ollama.mjs';
import { createServer } from '../server/server.mjs';
import { MockAgent } from '../server/agents.mjs';
import { startFakeOllama } from '../e2e/fixtures/fake-ollama.mjs';
import * as om from '../src/llm/localModels.js';
import { createOpenAIAdapter } from '../src/llm/openai.js';
import { createEmbedder } from '../src/llm/embeddings.js';

describe('Ollama 地址与程序查找', () => {
  it('OLLAMA_HOST 各种写法都规范成 IPv4 地址', () => {
    expect(ollamaHost({})).toBe('http://127.0.0.1:11434');
    expect(ollamaHost({ OLLAMA_HOST: '0.0.0.0' })).toBe('http://127.0.0.1:11434');
    expect(ollamaHost({ OLLAMA_HOST: 'localhost:12000' })).toBe('http://127.0.0.1:12000');
    expect(ollamaHost({ OLLAMA_HOST: 'http://192.168.1.5:11434/' })).toBe('http://192.168.1.5:11434');
  });
  it('Windows 默认安装位置能找到', () => {
    const want = 'C:\\Users\\a\\AppData\\Local\\Programs\\Ollama\\ollama.exe';
    const found = findOllamaBinary({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PATH: '' }, 'win32', (p) => p.replace(/\//g, '\\') === want);
    expect(found?.replace(/\//g, '\\')).toBe(want);
    expect(findOllamaBinary({ PATH: '' }, 'linux', () => false)).toBeNull();
  });
  it('按内存推荐模型', () => {
    const GB = 1024 ** 3;
    expect(om.recommend(7.7 * GB)).toBe('qwen3:4b');
    expect(om.recommend(15.6 * GB)).toBe('qwen3:8b');
    expect(om.recommend(32 * GB)).toBe('qwen3:14b');
  });
});

describe('网关的本机模型接口', () => {
  let fake, server, base;
  const H = { 'x-jarvis-client': '1', 'content-type': 'application/json' };
  beforeAll(async () => {
    fake = await startFakeOllama(0, { steps: 4, delay: 5 });
    const host = `http://127.0.0.1:${fake.server.address().port}`;
    server = createServer({ agent: new MockAgent({ charDelayMs: 0 }), staticDir: '/nonexistent', ollama: createOllama({ host, findBinary: () => null }) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { server.close(); await fake.close(); });

  it('检测：版本与已装模型', async () => {
    const s = await om.status(base);
    expect(s).toMatchObject({ running: true, version: '0.12.3-fake' });
    expect(s.models.map((m) => m.name)).toEqual(['llama3.2:3b']);
    expect(s.ram).toBeGreaterThan(0);
  });

  it('下载：逐行回传进度，完成后出现在列表里', async () => {
    const seen = [];
    await om.pull(base, 'qwen3:4b', { onProgress: (p) => seen.push(p) });
    const pct = seen.map((p) => p.percent).filter((p) => p != null);
    expect(pct.at(-1)).toBe(100);
    expect(pct).toEqual([...pct].sort((a, b) => a - b));
    expect(seen.at(-1).status).toBe('success');
    expect((await om.status(base)).models.map((m) => m.name)).toContain('qwen3:4b');
  });

  it('下载不存在的模型给出中文提示；非法名字被拒绝', async () => {
    await expect(om.pull(base, 'nope:1b')).rejects.toThrow(/找不到模型/);
    await expect(om.pull(base, '../etc')).rejects.toThrow(/不合法/);
  });

  it('删除', async () => {
    await om.remove(base, 'qwen3:4b');
    expect((await om.status(base)).models.map((m) => m.name)).not.toContain('qwen3:4b');
  });

  it('其他网站、单文件版（Origin: null）不能调用', async () => {
    expect((await fetch(`${base}/api/ollama/status`, { headers: { ...H, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/ollama/pull`, { method: 'POST', headers: { ...H, Origin: 'null' }, body: '{"model":"x"}' })).status).toBe(403);
    expect((await fetch(`${base}/api/ollama/status`)).status).toBe(403);
  });

  it('没装 Ollama 时“启动”给出安装提示', async () => {
    const o = createOllama({ host: 'http://127.0.0.1:1', findBinary: () => null });
    expect(await o.start()).toMatchObject({ ok: false, error: expect.stringMatching(/ollama\.com/) });
    expect((await o.status()).running).toBe(false);
  });

  it('装了没运行时启动 ollama serve', async () => {
    let spawned = null;
    let up = false;
    const fetchImpl = async (url) => {
      if (!up) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(/version/.test(url) ? { version: '1' } : { models: [] }));
    };
    const o = createOllama({ host: 'http://x', fetchImpl, findBinary: () => '/usr/bin/ollama', spawnImpl: (cmd, args) => { spawned = [cmd, ...args]; up = true; return { unref() {}, on() {} }; } });
    expect(await o.start()).toEqual({ ok: true });
    expect(spawned).toEqual(['/usr/bin/ollama', 'serve']);
  });

  it('对话经网关转发到 Ollama；不支持工具的模型自动退回只聊天', async () => {
    const adapter = createOpenAIAdapter({ baseURL: `${base}/api/llm/ollama`, apiKey: 'use-gateway-key' });
    const tools = [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }];
    for (const model of ['llama3.2:3b', 'gemma3:4b', 'gemma3:4b']) {
      let out = '';
      await adapter.stream({ model, system: ['s', ''], messages: [{ role: 'user', content: '你好' }], tools, onText: (d) => { out += d; } });
      expect(out).toContain(`本机模型 ${model} 收到：你好`);
    }
  });

  it('本机向量：选了 ollama 引擎就经网关算向量', async () => {
    const e = createEmbedder({ embedding: { engine: 'ollama' }, keys: {} }, { gateway: { origin: base, keys: [] } });
    expect(e.model).toBe('ollama:bge-m3');
    const v = await e.embed(['出差报销', '年假']);
    expect(v).toEqual([[1, 0, 0.01], [0, 1, 0.01]]);
    expect(createEmbedder({ embedding: { engine: 'ollama' }, keys: {} }, { gateway: null })).toBeNull();
    expect(createEmbedder({ keys: {} }, { gateway: { origin: base, keys: [] } })).toBeNull(); // auto 不会自动选本机
  });
});
