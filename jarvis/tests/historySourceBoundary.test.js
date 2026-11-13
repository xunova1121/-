import { describe, it, expect } from 'vitest';
import { updateSummary, HISTORY_SOURCE_RULE, ruleSummary } from '../src/agent/compress.js';
import { buildContext, runAgent } from '../src/agent/agent.js';

const history = [
  { role: 'user', content: '请解释这个软件功能', ts: 1 },
  { role: 'assistant', content: '我不能读取任何文件，以后也不能。', ts: 2 }
];

describe('旧助手说法的来源边界', () => {
  it('压缩请求明确来源，不删除旧记录或将其当成新规则', async () => {
    let request;
    await updateSummary(history, null, { keep: 0, batch: 1, llm: async input => { request = input; return '助手曾声称不能读取文件（未核实）。'; } });
    expect(request.prompt).toContain(HISTORY_SOURCE_RULE);
    expect(request.prompt).toContain(history[1].content);
    expect(ruleSummary('', history)).toContain('未央：我不能读取任何文件');
    expect(HISTORY_SOURCE_RULE).toContain('当前有效的安全与版权规则仍须遵守');
  });

  it('闲聊、未压缩历史及旧摘要共用边界，空的新会话不附加历史说明', async () => {
    for (const light of [true, false]) {
      const previous = await buildContext('你好', { light, history });
      expect(previous.dynamic).toContain(HISTORY_SOURCE_RULE);
      const compressed = await buildContext('你好', { light, summary: { text: '助手说不能读取文件。' } });
      expect(compressed.dynamic).toContain(HISTORY_SOURCE_RULE);
    }
    expect((await buildContext('你好', { light: true })).dynamic).not.toContain(HISTORY_SOURCE_RULE);
  });

  it('更换适配器仍保留原对话，并向两个实际请求传递来源边界', async () => {
    const seen = [];
    const makeAdapter = () => ({ async stream(input) {
      seen.push(input);
      input.onText('请提供要读取的文件。');
      return { text: '请提供要读取的文件。', toolCalls: [], stop: 'end_turn' };
    } });
    for (const model of ['provider-a', 'provider-b']) {
      await runAgent({ adapter: makeAdapter(), model, history, userText: '能读取这个文件吗', tools: [], emit: () => {} });
    }
    expect(seen).toHaveLength(2);
    for (const input of seen) {
      expect(input.system.join('\n')).toContain(HISTORY_SOURCE_RULE);
      expect(input.messages.some(message => message.content === history[1].content)).toBe(true);
    }
  });
});
