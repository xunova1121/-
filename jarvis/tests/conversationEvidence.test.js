import { describe, it, expect } from 'vitest';
import { conversationEvidence } from '../src/agent/conversationEvidence.js';
import { evidence } from '../src/agent/evidenceStore.js';
import { buildContext } from '../src/agent/agent.js';
import { createToolLoader } from '../src/agent/toolLoader.js';

const records = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, title: `影片${i}`, url: `https://example.test/${i}`, text: '不能进入上下文的原文' }));
describe('已读资料续接', () => {
  it('只提供本会话的有界索引，不塞正文', async () => {
    const ids = [];
    const result = await conversationEvidence('own-round', { text: '刚才的影片列表展示一下', loadIndex: async (id) => { ids.push(id); return records; } });
    expect(ids).toEqual(['own-round']);
    expect(result).toContain('e9');
    expect(result).not.toContain('e3');
    expect(result).not.toContain('不能进入上下文的原文');
    expect(result).toContain('read_evidence');
  });
  it('常识轻量路径和无会话不读取证据库', async () => {
    let calls = 0;
    const loadIndex = async () => { calls++; return records; };
    expect(await conversationEvidence('a', { light: true, loadIndex })).toBe('');
    expect(await conversationEvidence(null, { loadIndex })).toBe('');
    expect(calls).toBe(0);
  });
  it('停止和预算不能被可选索引吞掉', async () => {
    const error = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
    await expect(conversationEvidence('a', { loadIndex: async () => { throw error; } })).rejects.toBe(error);
  });
  it('实际上下文保留证据编号，正文仍只在证据库', async () => {
    await evidence.put('replay-own', { sources: [{ url: 'https://example.test/list', title: '已读电影列表', text: '原始片名甲乙丙，不要直接进上下文。' }] });
    try {
      const result = await buildContext('展示刚才的电影列表', { sessionId: 'replay-own', turns: 5 });
      expect(result.dynamic).toContain('本段对话已读资料索引');
      expect(result.dynamic).toContain('https://example.test/list');
      expect(result.dynamic).not.toContain('原始片名甲乙丙');
      const other = await buildContext('展示刚才的电影列表', { sessionId: 'replay-other', turns: 5 });
      expect(other.dynamic).not.toContain('https://example.test/list');
    } finally { await evidence.drop('replay-own'); }
  });
  it('资料多时read_evidence仍可直接调用，避免找工具再等一轮', () => {
    const tools = Array.from({ length: 30 }, (_, i) => ({ name: `unusual_${i}`, description: '不相关' }));
    tools.push({ name: 'read_evidence', description: '回读原文' });
    const loader = createToolLoader(tools);
    expect(loader.list().some((tool) => tool.name === 'read_evidence')).toBe(true);
  });
});
