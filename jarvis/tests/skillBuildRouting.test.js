import { it, expect, vi } from 'vitest';
import { runAgent } from '../src/agent/agent.js';
import { skillRunnerTool } from '../server/skillRunner.mjs';

it('装有可构建技能时，未点名的架构图仍开放内置工具，未自动调用或注入该技能', async () => {
  const called = vi.fn();
  const tools = [
    'create_diagram',
    'export_diagram',
    'read_file',
    'build_architecture',
    'plan_architecture',
    'prepare_architecture_evidence',
    'run_skill_command'
  ].map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run: called }));
  let received;
  const adapter = {
    async stream({ tools }) {
      received = tools.map((t) => t.name);
      return { text: '好的', toolCalls: [], stop: 'end_turn' };
    }
  };
  await runAgent({ adapter, model: 'fixture', history: [], userText: '根据招标材料画总体架构图', context: { dynamic: '' }, tools, emit: () => {} });
  expect(received).toContain('create_diagram');
  expect(received).toContain('export_diagram');
  for (const name of ['build_architecture', 'plan_architecture', 'prepare_architecture_evidence']) expect(received).not.toContain(name);
  expect(called).not.toHaveBeenCalled();
});

it('技能执行接缝拒绝替普通架构图擅自改用Archify，点名/技能卡的原话才允许', async () => {
  const runner = { run: vi.fn(async () => ({ exitCode: 0, files: [], stdout: 'ok', stderr: '' })) };
  const tool = skillRunnerTool({ runner, getPack: async () => ({ name: 'archify', enabled: true }), saveFile: vi.fn() });
  for (const rawRequestText of ['根据材料画总体架构图', '不要用Archify，画架构图'])
    await expect(tool.run({ skill: 'archify', command: 'node entry.mjs' }, { rawRequestText })).rejects.toHaveProperty('code', 'SKILL_EXPLICIT_REQUIRED');
  expect(runner.run).not.toHaveBeenCalled();
  for (const rawRequestText of ['用Archify画架构图', '请使用技能「archify」完成：架构图', '/archify 画架构图'])
    expect(await tool.run({ skill: 'archify', command: 'node entry.mjs' }, { rawRequestText })).toContain('退出码：0');
  expect(runner.run).toHaveBeenCalledTimes(3);
});
