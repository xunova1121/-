import { describe, it, expect } from 'vitest';
import { runHedged } from '../src/agent/hedgedRequest.js';
import { runAgent } from '../src/agent/agent.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const abortable = () => {
  const ctrl = new AbortController();
  return { ctrl, aborted: () => ctrl.signal.aborted };
};
/** 假请求：按给定脚本行事；abort 后 run 以 AbortError 结束 */
function fakeRequest(script) {
  const a = abortable();
  let hooks = {};
  return {
    hook(h) { hooks = h; },
    get aborted() { return a.aborted(); },
    abort: () => a.ctrl.abort(),
    dispose() {},
    run: () => new Promise((resolve, reject) => {
      a.ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      script({ resolve, reject, activity: () => hooks.onActivity?.(), text: (t) => hooks.onText?.(t) });
    })
  };
}

describe('主模型没反应时同时问备用模型', () => {
  it('主模型很快有反应：不问备用模型', async () => {
    let asked = false;
    const primary = fakeRequest(async ({ resolve, activity }) => { await wait(5); activity(); resolve({ text: '主' }); });
    const r = await runHedged({ primary, onPrimaryActivity: (fn) => primary.hook({ onActivity: fn }), makeBackup: () => { asked = true; return fakeRequest(() => {}); }, input: {}, hedgeMs: 50, onText() {} });
    expect(r.used).toBe('primary');
    expect(asked).toBe(false);
  });

  it('主模型一直没反应：到点同时问备用，备用先答就用备用，主模型被取消', async () => {
    const shown = [];
    let switched = false;
    const primary = fakeRequest(() => {});
    const r = await runHedged({
      primary,
      onPrimaryActivity: (fn) => primary.hook({ onActivity: fn }),
      makeBackup: (hooks) => { const b = fakeRequest(async ({ resolve, activity, text }) => { await wait(5); activity(); text('备用的回答'); resolve({ text: '备用的回答' }); }); b.hook(hooks); return b; },
      input: {}, hedgeMs: 20, onText: (t) => shown.push(t), onSwitch: () => { switched = true; }
    });
    expect(r.used).toBe('backup');
    expect(switched).toBe(true);
    expect(primary.aborted).toBe(true);
    expect(shown.join('')).toBe('备用的回答');
  });

  it('问了备用之后主模型先有反应：还用主模型，备用被取消', async () => {
    let backup;
    const primary = fakeRequest(async ({ resolve, activity }) => { await wait(40); activity(); resolve({ text: '主' }); });
    const r = await runHedged({
      primary,
      onPrimaryActivity: (fn) => primary.hook({ onActivity: fn }),
      makeBackup: (hooks) => { backup = fakeRequest(() => {}); backup.hook(hooks); return backup; },
      input: {}, hedgeMs: 10, onText() {}
    });
    expect(r.used).toBe('primary');
    expect(backup.aborted).toBe(true);
  });

  it('主模型出错而备用还在路上：等备用；两个都失败才报主模型的错', async () => {
    const primary = fakeRequest(async ({ reject }) => { await wait(30); reject(new Error('主模型 502')); });
    const ok = await runHedged({
      primary, onPrimaryActivity: (fn) => primary.hook({ onActivity: fn }),
      makeBackup: (hooks) => { const b = fakeRequest(async ({ resolve, activity }) => { await wait(60); activity(); resolve({ text: '备' }); }); b.hook(hooks); return b; },
      input: {}, hedgeMs: 10, onText() {}
    });
    expect(ok.used).toBe('backup');
    const p2 = fakeRequest(async ({ reject }) => { await wait(30); reject(new Error('主模型 502')); });
    await expect(runHedged({
      primary: p2, onPrimaryActivity: (fn) => p2.hook({ onActivity: fn }),
      makeBackup: (hooks) => { const b = fakeRequest(async ({ reject }) => { await wait(50); reject(new Error('备用也坏了')); }); b.hook(hooks); return b; },
      input: {}, hedgeMs: 10, onText() {}
    })).rejects.toThrow('主模型 502');
  });

  it('主模型在问备用之前就出错：直接报错（外面照旧换备用模型）', async () => {
    let asked = false;
    const primary = fakeRequest(async ({ reject }) => { await wait(5); reject(new Error('401')); });
    await expect(runHedged({ primary, onPrimaryActivity: (fn) => primary.hook({ onActivity: fn }), makeBackup: () => { asked = true; return fakeRequest(() => {}); }, input: {}, hedgeMs: 50, onText() {} })).rejects.toThrow('401');
    await wait(80);
    expect(asked).toBe(false);
  });
});

describe('实际智能体', () => {
  const context = { dynamic: '' };
  const silent = { kind: 'test', stream: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })) };
  const quick = (text) => ({ kind: 'test', stream: async ({ onText }) => { onText?.(text); return { text, toolCalls: [], stop: 'end_turn' }; } });

  it('主模型没反应：备用模型答上，回答底部能看出换过', async () => {
    const events = [];
    const r = await runAgent({ adapter: silent, model: '主模型', fallbacks: [{ adapter: quick('备用模型的回答'), model: '备用模型' }], hedgeMs: 30, history: [], userText: '介绍一下你自己', tools: [], context, emit: (e) => events.push(e), quiet: true });
    expect(r.text).toContain('备用模型的回答');
    expect(events.some((e) => e.type === 'fallback' && e.to === '备用模型')).toBe(true);
  });

  it('关掉开关（hedgeMs 为 0）或要做文件时不同时问', async () => {
    let backupCalls = 0;
    const backup = { kind: 'test', stream: async () => { backupCalls++; return { text: 'b', toolCalls: [], stop: 'end_turn' }; } };
    const slowThenOk = { kind: 'test', stream: async ({ onText }) => { await wait(60); onText?.('主'); return { text: '主', toolCalls: [], stop: 'end_turn' }; } };
    await runAgent({ adapter: slowThenOk, model: 'm', fallbacks: [{ adapter: backup, model: 'b' }], hedgeMs: 0, history: [], userText: '介绍一下你自己', tools: [], context, emit() {}, quiet: true });
    await runAgent({ adapter: slowThenOk, model: 'm', fallbacks: [{ adapter: backup, model: 'b' }], hedgeMs: 10, history: [], userText: '帮我写一份周报Word', tools: [], context, emit() {}, quiet: true });
    expect(backupCalls).toBe(0);
  });
});

describe('思考内容也算有反应', () => {
  it('OpenAI 兼容接口只回思考内容时就报“有反应”；只回响应头不算', async () => {
    const { createOpenAIAdapter } = await import('../src/llm/openai.js');
    const original = globalThis.fetch;
    const enc = new TextEncoder();
    let release;
    const gate = new Promise((r) => { release = r; });
    globalThis.fetch = async () => new Response(new ReadableStream({
      async start(c) {
        await gate;
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        c.close();
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    try {
      const marks = [];
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k' });
      const p = a.stream({ model: 'm', system: ['s'], messages: [{ role: 'user', content: 'hi' }], stallTimeouts: { first: 5000, between: 5000, onActivity: () => marks.push('alive') }, onText: () => {} });
      await wait(30);
      expect(marks).toHaveLength(0);
      release();
      await p;
      expect(marks.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('中转站的空包不算有反应', () => {
  it('只有 role 的空包只重置卡住计时，等到真内容才报“有反应”', async () => {
    const { createOpenAIAdapter } = await import('../src/llm/openai.js');
    const original = globalThis.fetch;
    const enc = new TextEncoder();
    let release;
    const gate = new Promise((r) => { release = r; });
    globalThis.fetch = async () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n'));
        await gate;
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        c.close();
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    try {
      const marks = [];
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k' });
      const p = a.stream({ model: 'm', system: ['s'], messages: [{ role: 'user', content: 'hi' }], stallTimeouts: { first: 5000, between: 5000, onActivity: () => marks.push('alive') }, onText: () => {} });
      await wait(40);
      expect(marks).toHaveLength(0);
      release();
      await p;
      expect(marks.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
