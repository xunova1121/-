/** 智能体专业能力考题：每个内置智能体 5 题、每题 3 条评分要点；表单值合法；评测脚本把智能体编号带进任务；不联网时只列题 */
import { it, expect, vi } from 'vitest';
import { agentCases, agentSuiteVersion } from '../evals/agent-cases.mjs';
import { pickCases, main } from '../evals/agents.mjs';
import { runCase } from '../evals/runner.mjs';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { agentFormNote } from '../src/agent/agentTurn.js';

it('40 题：8 个内置智能体各 5 题，题号唯一，每题 3 条评分要点', () => {
  expect(agentSuiteVersion).toBe('agents-40-v1');
  expect(agentCases).toHaveLength(40);
  expect(new Set(agentCases.map(c => c.id)).size).toBe(40);
  for (const p of BUILTIN_AGENTS) expect(agentCases.filter(c => c.agentId === p.id), p.id).toHaveLength(5);
  for (const c of agentCases) {
    expect(c.rubric, c.id).toHaveLength(3);
    expect(c.prompt.length, c.id).toBeGreaterThan(5);
    if (c.agentForm) expect(agentFormNote(BUILTIN_AGENTS.find(p => p.id === c.agentId), c.agentForm), c.id).not.toBe('');
  }
});

it('选题与只列题模式：不联网、不需要令牌', async () => {
  expect(pickCases(['agent-01', 'agent-06']).map(c => c.agentId)).toEqual(['ppt-maker', 'gongwen-writer']);
  expect(() => pickCases(['agent-99'])).toThrow('未知题号');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { await main([], {}); expect(JSON.parse(log.mock.calls[0][0]).count).toBe(40); } finally { log.mockRestore(); }
  await expect(main(['--live'], {})).rejects.toThrow('令牌');
});

it('评测脚本发任务时带上智能体编号和表单值', async () => {
  const sent = [];
  const api = vi.fn(async (url, body) => {
    if (url === '/api/tasks') { sent.push(body); return { id: 't1', sessionId: 's1' }; }
    if (url.startsWith('/api/tasks/')) return { id: 't1', status: 'done' };
    if (url.startsWith('/api/sessions/')) return { messages: [{ role: 'assistant', content: '好的' }] };
    return {};
  });
  await runCase(api, { id: 'x', prompt: '做PPT', agentId: 'ppt-maker', agentForm: { pages: '3-5' }, timeoutMs: 2000 }, { wait: async () => {} }).catch(() => {});
  expect(sent[0]).toMatchObject({ text: '做PPT', agentId: 'ppt-maker', agentForm: { pages: '3-5' } });
});
