import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as sessions from '../src/agent/sessions.js';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import { buildContext, runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import { unsummarized, summaryBlock } from '../src/agent/compress.js';
import { collectSessionWork, sessionWorkBlock, WORK_LIMIT } from '../src/agent/sessionWork.js';

beforeEach(async () => {
  sessions.useRemote(null);
  for (const key of ['sessions', 'memories', 'episodes', 'lessons', 'skills', 'events', 'files', 'kv']) {
    await collection(key).clear();
  }
  memory.configureMemory({});
  // 本组只读假会话，任何意外联网都让测试失败。
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('测试禁止联网');
    })
  );
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function savedConversation() {
  const messages = [
    { role: 'user', content: '做一份冷链任务考核 Excel', ts: 1 },
    { role: 'assistant', content: '已保存。', files: ['报表/冷链考核.xlsx'], ts: 2 },
    { role: 'user', content: '另做一份水产销售 Excel', ts: 3 },
    { role: 'assistant', content: '已保存。', files: ['报表/水产销售.xlsx'], ts: 4 },
    ...Array.from({ length: 36 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: '闲聊散步和晚饭' + i,
      ts: i + 5
    }))
  ];
  const session = sessions.create({ messages });
  await sessions.save(session);
  return session;
}

describe('本段对话的任务与文件召回', () => {
  it('search_conversations 找到当前会话较早的原话，并标注本段对话', async () => {
    const session = await savedConversation();
    const tool = createTools({ currentSessionId: () => session.id }).find((item) => item.name === 'search_conversations');
    const result = await tool.run({ query: '冷链任务考核' });
    expect(result).toContain('id: ' + session.id + '（就是本段对话）');
    expect(result).toContain('做一份冷链任务考核 Excel');
    expect(result).toContain('已保存');
  });

  it('任务绑定的会话优先于界面当前会话，其他会话仍可检索且不误标', async () => {
    const original = await savedConversation();
    const other = sessions.create({
      messages: [
        { role: 'user', content: '冷链任务考核进度如何', ts: 50 },
        { role: 'assistant', content: '这是另外一段。', ts: 51 }
      ]
    });
    await sessions.save(other);
    const tool = createTools({ currentSessionId: () => other.id }).find((item) => item.name === 'search_conversations');
    const result = await tool.run({ query: '冷链任务考核' }, { sessionId: original.id });
    expect(result).toContain('id: ' + original.id + '（就是本段对话）');
    expect(result).toContain('id: ' + other.id + '「');
    expect(result).not.toContain('id: ' + other.id + '（就是本段对话）');
  });

  it.each([false, true])('超过30条且旧消息已压缩时，仍注入两份文件与请求，light=%s', async (light) => {
    const session = await savedConversation();
    const summary = { text: '此前在闲聊散步和晚饭', upTo: 20 };
    const visible = unsummarized(session.messages, summary);
    expect(session.messages.length).toBeGreaterThan(30);
    expect(visible.every((message) => !message.files)).toBe(true);
    const result = await buildContext('今天还聊了什么', { sessionId: session.id, turns: 20, summary, light });
    expect(result.dynamic).toContain('本段对话的任务与文件记录');
    expect(result.dynamic).toContain('做一份冷链任务考核 Excel');
    expect(result.dynamic).toContain('报表/冷链考核.xlsx');
    expect(result.dynamic).toContain('另做一份水产销售 Excel');
    expect(result.dynamic).toContain('报表/水产销售.xlsx');
    expect(result.dynamic).toContain(session.id);
    expect(result.dynamic).toContain('read_conversation');
    const stream = vi.fn(async ({ system }) => {
      expect(system.join('\n')).toContain('报表/冷链考核.xlsx');
      expect(system.join('\n')).toContain('报表/水产销售.xlsx');
      expect(system.join('\n')).toContain(session.id);
      return { text: '之前做过两份表格。', toolCalls: [], stop: 'end_turn' };
    });
    await runAgent({
      adapter: { kind: 'mock', stream },
      model: 'fake',
      tools: [],
      emit: () => {},
      userText: '今天还聊了什么',
      sessionId: session.id,
      summary,
      light,
      quiet: true,
      history: visible.map(({ role, content }) => ({ role, content }))
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('只用助手文件回执，不将附件、口头承诺或无用户请求的文件当成已做任务', () => {
    expect(
      collectSessionWork([
        { role: 'assistant', files: ['孤立.xlsx'] },
        { role: 'user', content: '参考这份附件', files: ['上传.xlsx'] },
        { role: 'assistant', content: '准备生成想象.xlsx，之后再做' }
      ])
    ).toEqual([]);
    expect(sessionWorkBlock({ id: 'c_empty', messages: [] })).toBe('');
  });

  it('按用户原话分组，连续助手回执合并去重，忽略工具和其他消息的文件', () => {
    const messages = [
      { role: 'user', content: '做两份表格' },
      { role: 'assistant', files: ['a.xlsx', 'a.xlsx'] },
      { role: 'tool', files: ['读过的.xlsx'] },
      { role: 'assistant', files: ['a.xlsx', 'b.xlsx'] },
      { role: 'user', content: '再做演示稿' },
      { role: 'assistant', files: ['报告.pptx'] }
    ];
    const before = JSON.stringify(messages);
    expect(collectSessionWork(messages)).toEqual([
      { request: '做两份表格', files: ['a.xlsx', 'b.xlsx'] },
      { request: '再做演示稿', files: ['报告.pptx'] }
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('最多保留最近12项，字符和文件数有界，不带入助手或文件正文', () => {
    const messages = Array.from({ length: 30 }, (_, i) => [
      { role: 'user', content: '任务' + i + '短'.repeat(500) },
      {
        role: 'assistant',
        content: '不应进入索引的正文'.repeat(1000),
        files: Array.from({ length: 20 }, (_, n) => '文件' + i + '-' + n + '长'.repeat(200) + '.xlsx')
      }
    ]).flat();
    const records = collectSessionWork(messages);
    expect(records).toHaveLength(WORK_LIMIT);
    expect(records[0].request).toMatch(/^任务18/);
    expect(records.at(-1).request).toMatch(/^任务29/);
    expect(records.every((item) => item.request.length <= 180 && item.files.length <= 12)).toBe(true);
    const block = sessionWorkBlock({ id: 'c_bounded', messages });
    expect(block.length).toBeLessThan(11000);
    expect(block).toContain('任务29');
    expect(block).not.toContain('不应进入索引的正文');
  });

  it('上下文只读取任务指定的会话，不带入其他会话文件，读取异常保持原类型', async () => {
    const session = await savedConversation();
    const other = sessions.create({
      messages: [
        { role: 'user', content: '单独任务', ts: 100 },
        { role: 'assistant', content: '完成', files: ['不应混入.xlsx'], ts: 101 }
      ]
    });
    await sessions.save(other);
    const result = await buildContext('你好', { sessionId: session.id, light: true });
    expect(result.dynamic).not.toContain('不应混入.xlsx');
    const failure = Object.assign(new Error('读取失败'), { code: 'SESSION_READ_FAILED', kind: 'api' });
    vi.spyOn(sessions, 'get').mockRejectedValue(failure);
    await expect(buildContext('你好', { sessionId: session.id, light: true })).rejects.toBe(failure);
  });

  it('摘要需要核对时给出本段对话id和回读工具，不暴露被暂停使用的旧摘要', () => {
    const block = summaryBlock({ text: '已经作废的数值99999', review: true }, 'c_review');
    expect(block).toContain('较早摘要需要核对');
    expect(block).toContain('read_conversation');
    expect(block).toContain('id: c_review');
    expect(block).not.toContain('99999');
    expect(summaryBlock({ text: '旧摘要', review: true })).not.toContain('id: null');
  });
});
