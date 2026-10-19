import { describe, it, expect, vi } from 'vitest';
import { createEvidenceStore, evidenceId } from '../src/agent/evidenceStore.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { createTools } from '../src/agent/tools.js';
import { errorKind, interruptionMark } from '../src/core/suggest.js';
import { retryWait, retryAfterMs } from '../src/llm/openai.js';

/** 假存储：记下写了几次 */
function memStore() {
  const map = new Map();
  const s = { puts: 0, map,
    get: async (id) => map.get(id), put: async (o) => { s.puts++; map.set(o.id, structuredClone(o)); return o; },
    delete: async (id) => { map.delete(id); } };
  return s;
}
const src = (n, text = '正文') => ({ url: `https://s${n}.example/a`, title: `来源${n}`, text });

describe('证据单独存放', () => {
  it('按对话隔离：别的对话拿不到同一个编号的证据', async () => {
    const ev = createEvidenceStore({ store: memStore() });
    const [id] = await ev.put('A', { key: 'q', sources: [src(1, 'A 的原文')] });
    expect(id).toBe(evidenceId('https://s1.example/a'));
    expect((await ev.get('A', id)).text).toBe('A 的原文');
    expect(await ev.get('B', id)).toBeNull();
    expect(await ev.index('B')).toEqual([]);
    expect(await ev.get(null, id)).toBeNull();
  });
  it('有上限：每段对话 12 篇、每篇 6000 字；内存里只留最近的 30 段对话', async () => {
    const ev = createEvidenceStore({ store: memStore() });
    for (let i = 0; i < 20; i++) await ev.put('A', { sources: [src(i, '字'.repeat(9000))] });
    const list = await ev.index('A');
    expect(list).toHaveLength(12);
    expect(list.at(-1).url).toBe('https://s19.example/a');
    expect((await ev.get('A', list[0].id)).text).toHaveLength(6000);
    await ev.flush();
    for (let i = 0; i < 50; i++) await ev.index(`s${i}`);
    expect(ev.cached).toBeLessThanOrEqual(30);
  });
  it('1 秒内多次写入合并成一次落盘；过期和超出数量的对话从存储里删掉', async () => {
    vi.useFakeTimers();
    try {
      const store = memStore(); let t = 1_000_000;
      const ev = createEvidenceStore({ store, now: () => t });
      for (let i = 0; i < 8; i++) await ev.put('A', { key: 'q', sources: [src(i)] });
      expect(store.puts).toBe(0);
      await vi.advanceTimersByTimeAsync(1001); await ev.flush();
      expect(store.puts).toBe(2); // 一次对话记录 + 一次索引
      expect(store.map.get('evidence:A').items).toHaveLength(8);
      t += 25 * 3600_000; // 过了 24 小时
      await ev.put('B', { sources: [src(1)] }); await ev.flush();
      expect(store.map.has('evidence:A')).toBe(false);
      expect(store.map.get('evidence:index').list.map((x) => x.sid)).toEqual(['B']);
      await ev.drop('B');
      expect(store.map.has('evidence:B')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('按查证问题分组复用，保留最早保存的时间（不会因为反复“继续”一直算新的）', async () => {
    let t = 1000;
    const ev = createEvidenceStore({ store: memStore(), now: () => t });
    await ev.put('A', { key: 'q', sources: [src(1)] });
    t = 5000; await ev.put('A', { key: 'q', sources: [src(1), src(2)] });
    await ev.put('A', { sources: [src(3)] }); // fetch_url 存的，没有查证问题
    const [g] = await ev.records('A');
    expect(g.key).toBe('q'); expect(g.savedAt).toBe(1000); expect(g.sources).toHaveLength(2);
  });
  it('重启后从存储读回来', async () => {
    const store = memStore();
    const a = createEvidenceStore({ store });
    const [id] = await a.put('A', { sources: [src(1, '原文')] }); await a.flush();
    const b = createEvidenceStore({ store });
    expect((await b.get('A', id)).text).toBe('原文');
  });
});

describe('工具：读过的网页按编号取回，不重新联网', () => {
  it('fetch_url 存下原文，read_evidence 按这轮任务的对话取回；界面切到别的对话也不串', async () => {
    const page = '<html><head><title>官方公告</title></head><body><p>今天收盘价 13.4 元</p></body></html>';
    let reads = 0;
    const tools = createTools({ metrics: async () => ({}), currentSessionId: () => 'ui-current', fetchViaGateway: async () => { reads++; return new Response(page, { headers: { 'content-type': 'text/html' } }); } });
    const fetchUrl = tools.find((t) => t.name === 'fetch_url'), readEvidence = tools.find((t) => t.name === 'read_evidence');
    const out = await fetchUrl.run({ url: 'https://news.example/a' }, { sessionId: 'task-session' });
    const id = out.match(/已存为证据 (e\w+)/)?.[1];
    expect(id).toBeTruthy();
    expect(await readEvidence.run({ id }, { sessionId: 'task-session' })).toContain('13.4');
    expect(await readEvidence.run({ id }, {})).toContain('找不到'); // 界面上当前的对话拿不到
    expect(await readEvidence.run({}, { sessionId: 'task-session' })).toContain(id);
    expect(reads).toBe(1);
  });
  it('网址不对不扣读取次数', async () => {
    const tools = createTools({ metrics: async () => ({}) });
    const budget = createRetrievalBudget('查一下');
    await expect(tools.find((t) => t.name === 'fetch_url').run({ url: 'ftp://x' }, { retrieval: budget })).rejects.toThrow('http');
    expect(budget.resources.read).toBe(0);
  });
});

describe('预算', () => {
  it('某一类用完就整轮收尾；剩余次数在发请求前可查', () => {
    const b = createRetrievalBudget('查结局');
    expect(b.left).toBe(6);
    b.begin(); b.begin(); expect(b.left).toBe(4);
    for (let i = 0; i < 4; i++) b.consume('read');
    expect(() => b.consume('read')).toThrow(expect.objectContaining({ code: 'RETRIEVAL_BUDGET' }));
    expect(b.reason).toContain('read');
    expect(b.left).toBe(0);
    expect(() => b.consume('search')).toThrow(expect.objectContaining({ code: 'RETRIEVAL_BUDGET' }));
    expect(createRetrievalBudget('写一份报告').left).toBe(Infinity);
  });
});

describe('失败原因按出错处的标记分，不靠猜字', () => {
  it('分清超时、接口报错和连不上', () => {
    expect(errorKind(Object.assign(new TypeError('fetch failed: api.deepseek.com'), {}))).toBe('network');
    expect(errorKind('fetch failed https://api.deepseek.com/v1')).toBe('network'); // 以前会被 API 三个字母误判成接口出错
    expect(errorKind(Object.assign(new Error('x'), { status: 401 }))).toBe('api');
    expect(errorKind(Object.assign(new Error('模型 45 秒没有任何输出'), { stalled: true }))).toBe('timeout');
    expect(errorKind(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('network');
    expect(errorKind(Object.assign(new Error('网页请求超时'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(errorKind('连接超时')).toBe('timeout');
    expect(interruptionMark({ message: '随便', kind: 'api' })).toContain('模型接口出错');
    expect(interruptionMark('普通错误')).toContain('执行出错');
  });
});

describe('重试等待', () => {
  it('随机错开，服务商给了 Retry-After 就照它（最多 30 秒）', () => {
    expect(retryWait(4000, null, () => 0)).toBe(2000);
    expect(retryWait(4000, null, () => 0.999)).toBeLessThanOrEqual(4000);
    expect(retryWait(1500, { retryAfterMs: 7000 })).toBe(7000);
    expect(retryWait(1500, { retryAfterMs: 120_000 })).toBe(30_000);
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterMs('乱写')).toBe(0);
  });
});
