import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createOpenAIAdapter, STALL_MS, isTransient } from '../src/llm/openai.js';
import { createAnthropicAdapter } from '../src/llm/anthropic.js';
import { canFallback } from '../src/llm/router.js';
import { finishCheck } from '../src/agent/agent.js';

const req = { model: 'm', system: ['s', ''], messages: [{ role: 'user', content: 'hi' }], tools: [] };
const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
// 先发一段文字，然后一直不动（中转站挂住）
const hang = (text) => {
  let n = 0;
  return new Response(new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)); else return new Promise(() => {}); } }), { status: 200 });
};

describe('模型连接卡住：断开重试，不一直傻等', () => {
  const saved = { ...STALL_MS };
  beforeEach(() => { STALL_MS.first = 80; STALL_MS.between = 80; });
  afterEach(() => { Object.assign(STALL_MS, saved); });

  it('OpenAI每次请求可覆盖等待上限并禁用内部重试，卡住后交给上层换模型',async()=>{
    const orig=globalThis.fetch;let calls=0;
    globalThis.fetch=(url,init)=>{calls++;return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));};
    try{const a=createOpenAIAdapter({baseURL:'https://x/v1',apiKey:'k'});await expect(a.stream({...req,stallTimeouts:{first:10,between:10},maxTransientRetries:0})).rejects.toMatchObject({stalled:true});expect(calls).toBe(1);}finally{globalThis.fetch=orig;}
  });

  it('Claude每次请求禁用内部重试后只调用一次，不额外叠加120秒等待',async()=>{
    let calls=0;const client={beta:{messages:{stream(){calls++;return{[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{})}),finalMessage:()=>new Promise(()=>{})};}}}};
    const a=createAnthropicAdapter({client});await expect(a.stream({...req,stallTimeouts:{first:10,between:10},maxTransientRetries:0})).rejects.toMatchObject({stalled:true});expect(calls).toBe(1);
  });

  it('写了一半挂住：断开后带上已写部分续写', async () => {
    const replies = [hang('第一段，'), sse('第二段。')];
    const orig = globalThis.fetch;
    globalThis.fetch = async () => replies.shift();
    try {
      const retries = [];
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k', retryDelays: [1] });
      const r = await a.stream({ ...req, onRetry: (n, e) => retries.push(e.message) });
      expect(r.text).toBe('第一段，第二段。');
      expect(retries[0]).toMatch(/秒没有任何输出，连接卡住了/);
    } finally { globalThis.fetch = orig; }
  });

  it('一直连不上（请求发出去没回应）：重试几次后报“卡住了”，可以换备用模型', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
    try {
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k', retryDelays: [1, 1] });
      const err = await a.stream(req).catch((e) => e);
      expect(err.stalled).toBe(true);
      expect(err.name).not.toBe('AbortError');
      expect(canFallback(err)).toBe(true);
    } finally { globalThis.fetch = orig; }
  });

  it('用户自己点停止：照常是“已打断”，不当成卡住重试', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
    try {
      const ctrl = new AbortController();
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k', retryDelays: [1, 1] });
      const p = a.stream({ ...req, signal: ctrl.signal }).catch((e) => e);
      setTimeout(() => ctrl.abort(), 10);
      expect((await p).name).toBe('AbortError');
    } finally { globalThis.fetch = orig; }
  });

  it('Claude 接口：挂住或“Connection error.”时自动重试', async () => {
    let calls = 0;
    const client = { beta: { messages: { stream() {
      calls++;
      if (calls === 1) return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), finalMessage: () => new Promise(() => {}) };
      if (calls === 2) throw new Error('Connection error.');
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }; }, finalMessage: async () => ({ content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' }) };
    } } } };
    const a = createAnthropicAdapter({ client });
    const r = await a.stream({ ...req, tools: [] });
    expect(r.text).toBe('好');
    expect(calls).toBe(3);
    expect(isTransient(new Error('Connection error.'))).toBe(true);
  }, 10000);
});

describe('只说“马上开始做”就结束：提醒它真的去做', () => {
  it('结尾是预告就提醒，正常收尾不提醒', () => {
    expect(finishCheck({ lastText: '好的，我现在开始生成 Word 和 Excel。' })).toMatch(/没有调用任何工具/);
    expect(finishCheck({ lastText: '先重新读一遍原文档，接下来马上制作。' })).toMatch(/没有调用任何工具/);
    expect(finishCheck({ lastText: '请稍等。' })).toMatch(/没有调用任何工具/);
    expect(finishCheck({ lastText: '两个文件都已生成：汇报.docx、甘特表.xlsx。' })).toBe('');
    expect(finishCheck({ lastText: '文件都做好了。需要的话我可以接下来做 PPT。' })).toBe('');
  });
});

