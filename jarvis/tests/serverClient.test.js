import { describe, it, expect } from 'vitest';
import { parseSse, followTask, runRemote, normalizeUrl, loadServerSettings, saveServerSettings, remoteSessions } from '../src/core/serverClient.js';

const frame = (ev) => `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
/** 假服务器：第一次连接发两条就断，之后从 after 接着发到结束 */
function fakeClient(all, { dropAfter = 2 } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    stopped: false,
    async startTask(o) { calls.push(['start', o]); return { id: 't1', sessionId: o.sessionId }; },
    async stopTask() { this.stopped = true; },
    async events(id, after) {
      calls.push(['events', after]);
      const rest = all.filter((e) => e.seq > after);
      const first = n++ === 0;
      const part = first ? rest.slice(0, dropAfter) : rest;
      const enc = new TextEncoder();
      let i = 0;
      const body = new ReadableStream({ pull(c) { if (i < part.length) c.enqueue(enc.encode(frame(part[i++]))); else if (first) c.error(new TypeError('network')); else c.close(); } });
      return new Response(body, { status: 200 });
    }
  };
}
const EVENTS = [
  { seq: 1, type: 'task_state', status: 'running' },
  { seq: 2, type: 'text', delta: '第一段，' },
  { seq: 3, type: 'tool_start', id: 'a', name: 'create_document', args: {} },
  { seq: 4, type: 'file', path: '汇报.docx' },
  { seq: 5, type: 'text', delta: '做好了。' },
  { seq: 6, type: 'task_state', status: 'done', text: '第一段，做好了。', toolCalls: 1 }
];

describe('服务器模式客户端', () => {
  it('SSE 切分：不完整的留到下次', () => {
    const { events, rest } = parseSse(`${frame({ seq: 1, type: 'x' })}data: {"seq":2`);
    expect(events).toEqual([{ seq: 1, type: 'x' }]);
    expect(rest).toBe('data: {"seq":2');
  });
  it('网络断了自动重连，从断开的序号接着收，不重复', async () => {
    const c = fakeClient(EVENTS);
    const got = [];
    const end = await followTask(c, 't1', { onEvent: (e) => got.push(e.seq), retryMs: [1] });
    expect(got).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.calls.filter((x) => x[0] === 'events').map((x) => x[1])).toEqual([0, 2]);
    expect(end.status).toBe('done');
  });
  it('runRemote 和 runAgent 一样用：进度交给 emit，文件交给 onFile，返回回答', async () => {
    const c = fakeClient(EVENTS);
    const emitted = [];
    const files = [];
    const r = await runRemote(c, { sessionId: 'c1', userText: '做个汇报', emit: (e) => emitted.push(e.type), onFile: (p) => files.push(p) });
    expect(r).toMatchObject({ text: '第一段，做好了。', toolCalls: 1 });
    expect(emitted).toEqual(['text', 'tool_start', 'text']);
    expect(files).toEqual(['汇报.docx']);
    expect(c.calls[0]).toEqual(['start', { sessionId: 'c1', text: '做个汇报' }]);
  });
  it('中间网络卡住了最后的“完成”：问一下服务器，做完了就重连拿到结果', async () => {
    let n = 0;
    const c = {
      async getTask() { return { status: 'done', seq: 6 }; },
      async events(id, after) {
        n++;
        const enc = new TextEncoder();
        if (n === 1) return new Response(new ReadableStream({ start(ctl) { for (const e of EVENTS.slice(0, 5)) ctl.enqueue(enc.encode(frame(e))); } }), { status: 200 }); // 发到一半就不动了
        return new Response(EVENTS.filter((e) => e.seq > after).map(frame).join(''), { status: 200 });
      }
    };
    const end = await followTask(c, 't1', { checkMs: 30, retryMs: [1] });
    expect(end).toMatchObject({ status: 'done', text: '第一段，做好了。' });
    expect(n).toBe(2);
  });
  it('手机原生网络：要求事件流的 GET 也边收边显示', async () => {
    const { wantsStream } = await import('../src/mobile/nativeFetch.js');
    expect(wantsStream({ headers: { Accept: 'text/event-stream' } })).toBe(true);
    expect(wantsStream({})).toBe(false);
  });
  it('用户叫停：服务器上的任务也停下', async () => {
    const c = fakeClient(EVENTS, { dropAfter: 1 });
    c.events = async () => new Response(new ReadableStream({ start() {} }), { status: 200 }); // 一直不来新数据
    const ctrl = new AbortController();
    const p = runRemote(c, { sessionId: 'c1', userText: 'x', emit: () => {}, signal: ctrl.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    expect((await p).name).toBe('AbortError');
    expect(c.stopped).toBe(true);
  });
  it('服务器上的任务出错：报出原因', async () => {
    const c = fakeClient([{ seq: 1, type: 'task_state', status: 'error', error: '模型还没配置好' }]);
    c.events = async () => new Response(frame({ seq: 1, type: 'task_state', status: 'error', error: '模型还没配置好' }), { status: 200 });
    await expect(runRemote(c, { sessionId: 'c1', userText: 'x', emit: () => {} })).rejects.toThrow('模型还没配置好');
  });
  it('设置：网址补全 https，令牌保存，不存密码', () => {
    expect(normalizeUrl('d.leing.top/')).toBe('https://d.leing.top');
    expect(normalizeUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    const m = new Map();
    const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
    saveServerSettings({ url: 'https://d.leing.top', token: 'abc', enabled: true, password: '不该存' }, st);
    expect(loadServerSettings(st)).toEqual({ url: 'https://d.leing.top', token: 'abc', enabled: true });
    expect([...m.values()].join('')).not.toContain('不该存');
  });
  it('对话列表、改标题、删除都走服务器', async () => {
    const calls = [];
    const r = remoteSessions({ listSessions: async () => [{ id: 'c1', title: '三季度汇报' }, { id: 'c2', title: '周报' }], patchSession: async (...a) => calls.push(['patch', ...a]), deleteSession: async (id) => calls.push(['del', id]), getSession: async () => null });
    expect((await r.search('汇报')).map((s) => s.id)).toEqual(['c1']);
    await r.rename('c1', '新标题');
    await r.remove('c2');
    expect(calls).toEqual([['patch', 'c1', { title: '新标题' }], ['del', 'c2']]);
  });
});
