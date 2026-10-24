import { describe, it, expect } from 'vitest';
import { wantsPreSearch, preSearchQuery, preSearch, reusesPreSearch } from '../src/agent/preSearch.js';
import { staggeredSearch } from '../src/agent/webSearch.js';
import { runAgent } from '../src/agent/agent.js';

const context = { dynamic: '' };
const never = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));

describe('先搜再答', () => {
  it('只对明显要查实时信息的短问题先搜；天气、写东西、闲聊不搜', () => {
    for (const q of ['今晚英超有什么比赛，什么平台直播', '贵州茅台今天收盘价多少', '最近有什么重要新闻', '美元兑人民币汇率现在多少']) expect(wantsPreSearch(q), q).toBe(true);
    for (const q of ['你好', '南京今天天气怎么样', '帮我写一份今天的工作总结', '一公斤等于多少克', '我最近好累', '今天心情不错', '最'.repeat(130)]) expect(wantsPreSearch(q), q).toBe(false);
  });

  it('搜索词去掉客气话和问号', () => {
    expect(preSearchQuery('帮我查一下今晚英超比赛几点？')).toBe('今晚英超比赛几点');
    expect(preSearchQuery('请告诉我贵州茅台今天收盘价')).toBe('贵州茅台今天收盘价');
  });

  it('搜得太慢就放弃，不拖住回答', async () => {
    const t0 = Date.now();
    const r = await preSearch({ text: '今天新闻', timeoutMs: 50, run: (calls, signal) => never(signal) });
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('模型重复先搜过的词时认得出来', () => {
    const found = { query: '今晚英超比赛', output: 'x' };
    expect(reusesPreSearch({ name: 'web_search', args: { query: '今晚英超比赛？' } }, found)).toBe(true);
    expect(reusesPreSearch({ name: 'web_search', args: { query: '英超 第8轮 赛程' } }, found)).toBe(false);
    expect(reusesPreSearch({ name: 'web_search', args: { query: '今晚英超比赛', queries: ['意甲 今晚'] } }, found)).toBe(false);
  });

  it('实际智能体：搜索结果随问题一起给模型，一轮答完；模型再用同一个词搜时直接给上次结果，不重复搜', async () => {
    let searches = 0;
    const seen = [];
    const tools = [{ name: 'web_search', description: '联网搜索', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async ({ query }) => { searches++; return `- 英超第8轮 ${query}\n  https://example.com/epl`; } }];
    let calls = 0;
    const adapter = {
      stream: async ({ messages }) => {
        calls++;
        seen.push(messages.at(-1));
        if (calls === 1) return { text: '', toolCalls: [{ id: 'a', name: 'web_search', args: { query: '今晚英超比赛' } }], stop: 'tool_use' };
        return { text: '今晚有三场，见 https://example.com/epl', toolCalls: [], stop: 'end_turn' };
      }
    };
    const r = await runAgent({ adapter, model: 'fixture', history: [], userText: '今晚英超比赛？', tools, context, emit() {}, quiet: true });
    expect(String(seen[0].content)).toContain('系统已先按这句话联网搜索了一次');
    expect(String(seen[0].content)).toContain('https://example.com/epl');
    expect(searches).toBe(1);
    expect(r.text).toContain('example.com/epl');
  });

  it('不需要查的问题照旧，不先搜', async () => {
    let searches = 0;
    const tools = [{ name: 'web_search', description: '联网搜索', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => { searches++; return 'x'; } }];
    const adapter = { stream: async () => ({ text: '1000克', toolCalls: [], stop: 'end_turn' }) };
    await runAgent({ adapter, model: 'fixture', history: [], userText: '一公斤等于多少克？', tools, context, emit() {}, quiet: true });
    expect(searches).toBe(0);
  });
});

describe('搜索源错开同时问', () => {
  const engine = (name, fn) => ({ name, search: (q, n, o) => fn(o.signal) });

  it('第一个源卡住时，过一会儿同时问下一个，先回来的够用就用它，卡住的被取消', async () => {
    let aborted = false;
    const slow = engine('慢', (signal) => { signal.addEventListener('abort', () => { aborted = true; }); return never(signal); });
    const fast = engine('快', async () => [1, 2, 3].map((i) => ({ title: `t${i}`, url: `https://x/${i}` })));
    const t0 = Date.now();
    const hits = await staggeredSearch([slow, fast], 'q', 6, {}, null, 30);
    expect(hits).toHaveLength(3);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });

  it('第一个源很快出错：不等错开时间，马上换下一个', async () => {
    const bad = engine('坏', async () => { throw new Error('坏了'); });
    const good = engine('好', async () => [{ title: 'a', url: 'https://a' }]);
    const t0 = Date.now();
    const hits = await staggeredSearch([bad, good], 'q', 6, {}, null, 5000);
    expect(hits).toEqual([{ title: 'a', url: 'https://a' }]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('优先的源（DeepSeek）有结果就用，全都失败时把原因一起报出来', async () => {
    const ds = engine('DeepSeek', async () => [{ title: 'd', url: 'https://d' }]);
    expect(await staggeredSearch([ds, engine('后备', async () => [{ title: 'b', url: 'https://b' }])], 'q', 6, {}, ds, 30)).toEqual([{ title: 'd', url: 'https://d' }]);
    await expect(staggeredSearch([engine('a', async () => { throw new Error('甲失败'); }), engine('b', async () => { throw new Error('乙失败'); })], 'q', 6, {}, null, 10)).rejects.toThrow(/甲失败；乙失败/);
  });

  it('外面取消时立即停', async () => {
    const ctrl = new AbortController();
    const p = staggeredSearch([engine('慢', never)], 'q', 6, { signal: ctrl.signal }, null, 10);
    ctrl.abort();
    await expect(p).rejects.toBeTruthy();
  });
});
