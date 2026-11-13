import { describe, it, expect } from 'vitest';
import { updateSummary, dueForCompression, unsummarized } from '../src/agent/compress.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import { createToolLoader, CORE } from '../src/agent/toolLoader.js';
import { boundedSummaryCall } from '../src/agent/contextBudget.js';
import { userEvidence, evidenceBlock } from '../src/agent/summaryEvidence.js';
import { compactToolResults, createTurnArchive } from '../src/agent/turnContext.js';
import { resolveTaskIntent } from '../src/core/taskIntent.js';

describe('压缩保真与调用成本', () => {
  it('写笔记这类普通工作仍让轻量模型直接获得写文件工具', () => {
    const intent = resolveTaskIntent('写个笔记');
    expect(intent).toMatchObject({ category: 'work', modelTask: 'chat' });
    const core = taskToolCore(intent, '写个笔记');
    for (const tool of ['write_file', 'edit_file', 'list_files', 'read_file']) expect(core.has(tool)).toBe(true);
  });
  it('明确调研或查证时提前展示调研工具，知识库入口不丢失', () => {
    const tools = [...CORE].map(name => ({ name, input_schema: { type: 'object' } }));
    for (const text of ['深度调研：本机大模型', '核实这些数据的来源']) {
      const loader = createToolLoader(tools, { core: taskToolCore(resolveTaskIntent(text), text) });
      for (const name of ['deep_research', 'fact_check', 'web_search', 'fetch_url', 'kb_search']) expect(loader.list().some(tool => tool.name === name)).toBe(true);
    }
  });
  it('未来起名计划不能变成已经存在的孩子，助手猜测不写入用户事实', () => {
    const evidence = userEvidence([], [{ role: 'user', ts: 1, content: '以后想给孩子起名叫小明' }, { role: 'assistant', ts: 2, content: '你的孩子叫小明' }]);
    expect(evidence).toEqual([{ kind: 'hypothetical', ts: 1, quote: '以后想给孩子起名叫小明' }]);
    expect(evidenceBlock(evidence)).toContain('不能变成已发生事实');
  });
  it('缩短回执仍保留失败、单位与来源，原文可按编号回读', async () => {
    const original = JSON.stringify({ body: '正文'.repeat(2000), status: 'failed', code: 'STALE_QUOTE', source: '腾讯行情', time: '2026-11-03 15:00', unit: '元', price: 1480, verified: false });
    const archive = createTurnArchive();
    const convo = [{ role: 'tool', name: 'get_market_quote', toolCallId: 'quote1', content: original, isError: true }];
    compactToolResults(convo, { budget: 500, keep: 0, archive, preserveEvidence: true });
    expect(convo[0].content).toContain('STALE_QUOTE');
    expect(convo[0].content).toContain('腾讯行情');
    expect(convo[0].content).toContain('2026-11-03 15:00');
    expect(convo[0].content).toContain('"unit":"元"');
    expect(convo[0].content).toContain('"verified":false');
    const restored = JSON.parse(await archive.tool.run({ result_id: 't1', max_chars: 12000 }));
    expect(restored).toMatchObject({ isError: true, text: original, next_offset: null });
  });
  it('长消息尾部约束进入摘要输入，不再按1500字截头', async () => {
    const source = '做一个网页。' + '内容'.repeat(1000) + '最后约束：保留所有表格，不要替换原文件。';
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', ts: i + 1, content: i ? '继续' : source }));
    let input;
    const result = await updateSummary(history, null, { llm: async o => { input = o; return '网页任务'; } });
    expect(input.prompt).toContain('最后约束：保留所有表格，不要替换原文件。');
    expect(input).toMatchObject({ allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0 });
    expect(result.taskContext.category).toBe('code');
    expect(history[0].content).toBe(source);
  });
  it('少于30条但输入过大也能压缩，保留至少最近6条和全部原件', async () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', ts: i + 1, content: '长内容'.repeat(2000) + i }));
    const before = JSON.stringify(history);
    expect(dueForCompression(history, null).length).toBeGreaterThan(0);
    let calls = 0;
    const result = await updateSummary(history, null, { llm: async () => { calls++; return '不能遗漏'; } });
    expect(calls).toBe(0); // 超出后台输入预算，采用本地索引，不偷偷多轮摘要。
    expect(unsummarized(history, result).length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(history)).toBe(before);
  });
  it('摘要取消立即结束，忽略取消的上游迟到结果不返回', async () => {
    const ctrl = new AbortController();
    const pending = boundedSummaryCall(() => new Promise(resolve => setTimeout(() => resolve('迟到'), 50)), { prompt: '摘要' }, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('按需schema变少，但可搜索和直接调用的工具不丢失', () => {
    const tools = [...CORE].map(name => ({ name, description: '完整的工具说明'.repeat(100), input_schema: { type: 'object' } }));
    const loader = createToolLoader(tools, { core: taskToolCore({ category: 'chat' }, '你好，我想聊聊') });
    expect(loader.list().length).toBeLessThan(tools.length / 2);
    expect(loader.hint()).toContain('create_document');
    expect(loader.get('create_document').name).toBe('create_document');
    expect(loader.list().some(t => t.name === 'create_document')).toBe(true);
  });
});
