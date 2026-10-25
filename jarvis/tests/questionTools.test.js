import { describe, it, expect } from 'vitest';
import { questionToolProfile } from '../src/agent/questionTools.js';
import { runAgent } from '../src/agent/agent.js';

const context = { dynamic: '' };
const tools = ['web_search', 'verify_numbers', 'create_document', 'write_file', 'recall', 'computer_search'].map(name => ({
  name, description: '较长的工具说明'.repeat(500), input_schema: { type: 'object', properties: {} }, run: async () => 'ok'
}));

describe('基础问题按需注入工具', () => {
  it('固定换算和基础解释走轻量路径，计算保留校验', () => {
    for (const q of ['一公斤等于多少克？只回答结果。', '2吨换算成多少公斤', '为什么月亮会有圆缺？', '用两句话解释什么是智能体。']) expect(questionToolProfile(q), q).toBe('knowledge');
    expect(questionToolProfile('每箱毛重23.6公斤，筐重1.4公斤，共37箱，单价18.5元/公斤。算净重和货款')).toBe('calculation');
  });
  it('文件、当前行情、个人记忆、图片与延续任务保留完整能力', () => {
    for (const q of ['今天股价为什么上涨', '查一下我之前的计算结果', '解释附件里的三角形', '一公斤等于多少克，写入Word文件', '月球最新新闻', '继续计算这个净重', '安装数学技能']) expect(questionToolProfile(q), q).toBeNull();
    expect(questionToolProfile('为什么月亮有圆缺', { images: [{}] })).toBeNull();
    expect(questionToolProfile('为什么月亮有圆缺', { history: [{ role: 'tool', content: '继续' }] })).toBeNull();
  });
  it('实际请求常识不含工具schema、技能目录提示和原生搜索', async () => {
    const diagnostics = [];
    const adapter = { async stream(input) {
      expect(input.tools).toEqual([]);
      expect(input.allowWebSearch).toBe(false);
      expect(input.system.join('').length).toBeLessThan(300);
      return { text: '1000克', toolCalls: [], stop: 'end_turn' };
    } };
    const result = await runAgent({ adapter, model: 'fixture', userText: '一公斤等于多少克？', history: [], context, tools, quiet: true, emit: e => diagnostics.push(e) });
    expect(result.text).toBe('1000克');
    expect(diagnostics.find(e => e.phase === 'model_start').toolSchemaChars).toBe(2);
  });
  it('计算请求只带数字校验，插话要求保存文件时恢复完整工具', async () => {
    const inbox = [];
    let calls = 0;
    const adapter = { async stream(input) {
      if (++calls === 1) {
        expect(input.tools.map(t => t.name)).toEqual(['verify_numbers']);
        inbox.push('把结果写入文件');
      } else expect(input.tools.some(t => t.name === 'write_file')).toBe(true);
      return { text: '结果', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'fixture', userText: '毛重100公斤、筐重5公斤，计算净重', history: [], context, tools, inbox, quiet: true, emit() {} });
    expect(calls).toBeGreaterThan(1);
  });
});
