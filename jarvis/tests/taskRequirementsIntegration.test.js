import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { collectRequirements } from '../src/agent/taskRequirements.js';

describe('需求记录贯穿实际智能体入口', () => {
  beforeEach(() => { vi.resetModules(); globalThis.indexedDB = new IDBFactory(); });

  it('可见原话在每个工具步骤都只通过history发送，不重复塞系统提示', async () => {
    const { runAgent } = await import('../src/agent/agent.js');
    const history = [{ role: 'user', content: 'PPT预算67万元，15页', ts: 1 }];
    const requirements = collectRequirements(history);
    let n = 0;
    const adapter = { async stream({ system, messages }) {
      expect(system.join('\n')).not.toContain('预算67万元');
      expect(system.join('\n')).not.toContain('## 本会话需求原文索引');
      expect(messages.filter((m) => m.role === 'user' && m.content === history[0].content)).toHaveLength(1);
      if (++n === 1) return { text: '', toolCalls: [{ id: 'read', name: 'read_task_requirements', args: { entry_id: 'r1' } }], stop: 'tool_use' };
      expect(JSON.parse(messages.at(-1).content).text).toBe(history[0].content);
      return { text: '已核对', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'test', history, userText: '修改PPT预算', requirements, context: { dynamic: '测试', kbHits: [] }, tools: [], emit: () => {} });
    expect(n).toBe(2);
  });

  it('界面传入账本时，即使上下文和历史已压缩，也能回读完整原话', async () => {
    const { runAgent } = await import('../src/agent/agent.js');
    const raw = `做15页PPT，预算67万元\n${'材料'.repeat(1000)}\n不得删减原文`;
    const requirements = collectRequirements([{ role: 'user', content: raw, ts: 1 }]);
    const seen = [];
    const adapter = { async stream({ system, messages, tools, onText }) {
      seen.push({ system: system.join('\n'), tools: tools.map((t) => t.name) });
      if (!messages.some((m) => m.role === 'tool')) return { text: '', toolCalls: [{ id: 'r', name: 'read_task_requirements', args: { entry_id: 'r1' } }], stop: 'tool_use' };
      expect(JSON.parse(messages.at(-1).content).text).toBe(raw);
      onText('保留原要求继续修改'); return { text: '保留原要求继续修改', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await runAgent({ adapter, model: 'test', userText: '只换风格', history: [], requirements, context: { dynamic: '前情已压缩', kbHits: [] }, tools: [], emit: () => {} });
    expect(r.text).toBe('保留原要求继续修改');
    expect(seen[0].system).not.toContain('预算67万元'); // 无关原话不主动注入，仍可按编号回读全文
    expect(seen[0].tools).toContain('read_task_requirements');
  });

  it('非界面入口可从保存的会话恢复账本，不串到其他会话', async () => {
    const sessions = await import('../src/agent/sessions.js');
    const { runAgent } = await import('../src/agent/agent.js');
    const s = sessions.create({ messages: [{ role: 'user', content: '合同金额67万元', ts: 1 }] });
    const other = sessions.create({ messages: [{ role: 'user', content: '其他会话秘密口令', ts: 2 }] });
    await sessions.save(s); await sessions.save(other);
    let received = '', original = '';
    const adapter = { async stream({ system, messages }) {
      received = system.join('\n');
      if (!messages.some((m) => m.role === 'tool')) return { text: '', toolCalls: [{ id: 'read', name: 'read_task_requirements', args: { entry_id: 'r1' } }], stop: 'tool_use' };
      original = JSON.parse(messages.at(-1).content).text;
      return { text: '收到', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'test', userText: '继续', history: [], sessionId: s.id, context: { dynamic: '测试', kbHits: [] }, tools: [], emit: () => {} });
    expect(original).toBe('合同金额67万元');
    expect(received).not.toContain('其他会话秘密口令');
  });

  it('循环缩短工具结果后能回读尾部，调用者的历史工作副本保持不变', async () => {
    const { runAgent } = await import('../src/agent/agent.js');
    const text = `${'正文'.repeat(17000)}\n文件版本：方案-v3.docx`;
    const history = Array.from({ length: 8 }, (_, i) => ({ role: 'tool', name: 'read_file', toolCallId: `old${i}`, content: text }));
    let n = 0;
    const adapter = { async stream({ messages, onText }) {
      if (++n === 1) {
        expect(messages[0].content).toContain('原文编号 t1');
        return { text: '', toolCalls: [{ id: 'read', name: 'read_tool_result', args: { result_id: 't1', offset: 33000 } }], stop: 'tool_use' };
      }
      expect(JSON.parse(messages.at(-1).content).text).toContain('方案-v3.docx');
      onText('已找回'); return { text: '已找回', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'test', history, userText: '读取版本', context: { dynamic: '测试', kbHits: [] }, tools: [], emit: () => {} });
    expect(history[0].content).toBe(text); expect(history[0].compacted).toBeUndefined();
  });

  it('团队规划、执行、审核与汇总都带原始要求，模型生成的步骤不入账', async () => {
    const { runTeam } = await import('../src/agent/team.js');
    const requirements = collectRequirements([{ role: 'user', content: '15页，预算67万元，不得删减', ts: 1 }]);
    const prompts = [], records = [];
    const llm = async ({ system }) => { prompts.push(system); return system.includes('规划员') ? JSON.stringify({ steps: [{ role: 'writer', title: '制作文件', detail: '写报告' }] }) : JSON.stringify({ pass: true, issues: [] }); };
    const adapter = { async stream({ system, onText }) { prompts.push(system.join('\n')); onText('完成'); return { text: '完成' }; } };
    await runTeam({ adapter, model: 'test', userText: '只换PPT风格，预算不变', tools: [], emit: () => {}, llm, requirements, run: async (o) => { records.push(o.requirements); return { text: '生成文件', toolCalls: 0 }; } });
    expect(prompts).toHaveLength(3);
    for (const p of prompts) expect(p).toContain('预算67万元');
    expect(records[0]).toBe(requirements);
    expect(requirements.entries).toHaveLength(1);
  });
});
