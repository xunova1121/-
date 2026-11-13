/** 第二套 40 题：编号接着 41–80、每个内置智能体再 5 题、每题 3 条要点；原来的 40 题和默认题量不变 */
import { it, expect, vi } from 'vitest';
import { agentCases } from '../evals/agent-cases.mjs';
import { agentCasesExtra, allAgentCases, allAgentSuiteVersion } from '../evals/agent-cases-extra.mjs';
import { pickCases, main } from '../evals/agents.mjs';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { agentFormNote } from '../src/agent/agentTurn.js';

it('80 题：编号唯一连续，每个智能体共 10 题，表单值合法', () => {
  expect(allAgentSuiteVersion).toBe('agents-80-v2');
  expect(agentCasesExtra).toHaveLength(40);
  expect(agentCasesExtra[0].id).toBe('agent-41');
  expect(agentCasesExtra.at(-1).id).toBe('agent-80');
  expect(new Set(allAgentCases.map((c) => c.id)).size).toBe(80);
  expect(allAgentCases.slice(0, 40)).toEqual(agentCases);
  for (const p of BUILTIN_AGENTS) expect(agentCasesExtra.filter((c) => c.agentId === p.id), p.id).toHaveLength(5);
  for (const c of agentCasesExtra) {
    expect(c.rubric, c.id).toHaveLength(3);
    if (c.agentForm) expect(agentFormNote(BUILTIN_AGENTS.find((p) => p.id === c.agentId), c.agentForm), c.id).not.toBe('');
  }
});

it('默认仍是 40 题；--suite=all 列 80 题；按题号可选第二套', async () => {
  expect(pickCases()).toHaveLength(40);
  expect(pickCases(undefined, { all: true })).toHaveLength(80);
  expect(pickCases(['agent-41', 'agent-01']).map((c) => c.agentId)).toEqual(['ppt-maker', 'ppt-maker']);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await main(['--suite=all'], {});
    const out = JSON.parse(log.mock.calls[0][0]);
    expect(out).toMatchObject({ suite: 'agents-80-v2', count: 80 });
  } finally { log.mockRestore(); }
});
