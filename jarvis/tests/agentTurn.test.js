/** 智能体广场第1步：用智能体开的对话——角色说明进系统提示、工具只收窄不放宽、表单值进本轮要求、配置只从注册表取 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { agentFormNote, narrowAgentTools, resolveAgentTurn, sanitizeAgentForm, withAgentRequirement, AGENT_FLOW_TOOLS } from '../src/agent/agentTurn.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';

const ppt = BUILTIN_AGENTS.find(p => p.id === 'ppt-maker');
const tool = (name) => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run: async () => 'ok' });
const ctx = { dynamic: '测试', kbHits: [] };

let agent;
beforeEach(async () => { vi.resetModules(); globalThis.indexedDB = new IDBFactory(); agent = await import('../src/agent/agent.js'); });
afterEach(() => { delete globalThis.indexedDB; });

it('表单值：只认配置里的键和选项，写成一句“用户选择”', () => {
  expect(agentFormNote(ppt, { pages: '6-10', scene: '政企汇报', language: '简体中文' })).toBe('用户选择：页数 6-10；场景 政企汇报；语言 简体中文');
  expect(agentFormNote(ppt, { pages: '999', scene: '政企汇报', admin: 'true' })).toBe('用户选择：场景 政企汇报');
  expect(agentFormNote(ppt, {})).toBe('');
  expect(agentFormNote(null, { pages: '6-10' })).toBe('');
  expect(withAgentRequirement('做一份汇报', { note: '用户选择：页数 6-10' })).toBe('做一份汇报\n\n（用户选择：页数 6-10）');
  expect(withAgentRequirement('原话', null)).toBe('原话');
});

it('客户端传来的表单值清洗：非文字、怪键、超长都处理掉', () => {
  expect(sanitizeAgentForm({ pages: '6-10', 'Bad Key': 'x', n: 3, long: 'a'.repeat(3000) })).toEqual({ pages: '6-10', long: 'a'.repeat(2000) });
  expect(sanitizeAgentForm([1, 2])).toBeNull();
  expect(sanitizeAgentForm({})).toBeNull();
});

it('工具取交集：只会变少；流程工具保留；白名单为空时原样不动', () => {
  const tools = ['create_document', 'web_search', 'computer_click', 'run_python', 'update_plan', 'review_task'].map(tool);
  const narrowed = narrowAgentTools(tools, ppt).map(t => t.name);
  expect(narrowed).toEqual(['create_document', 'web_search', 'update_plan', 'review_task']);
  expect(narrowed).not.toContain('computer_click');
  // 配置里写了本轮没有的工具，也不会凭空多出来
  expect(narrowAgentTools([tool('read_file')], ppt).map(t => t.name)).toEqual(['read_file']);
  expect(narrowAgentTools(tools, { ...ppt, tools: [] })).toBe(tools);
  expect(narrowAgentTools(tools, null)).toBe(tools);
  for (const name of AGENT_FLOW_TOOLS) expect(/^(?:read_task_requirements|read_tool_result|need_more_time|update_plan|review_task|execution_capabilities|tool_search)$/.test(name)).toBe(true);
});

it('按编号从注册表解析：没编号=普通对话；找不到报错，不悄悄当普通对话；编号格式不对报参数错', async () => {
  expect(await resolveAgentTurn({})).toBeNull();
  expect(await resolveAgentTurn({ agentId: '' })).toBeNull();
  const got = await resolveAgentTurn({ agentId: 'ppt-maker', form: { pages: '3-5' } });
  expect(got.profile.id).toBe('ppt-maker');
  expect(got.note).toBe('用户选择：页数 3-5');
  await expect(resolveAgentTurn({ agentId: 'not-exist' }, { lookup: async () => null })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  await expect(resolveAgentTurn({ agentId: '../x' })).rejects.toMatchObject({ name: 'ValidationError' });
});

it('主循环：带智能体时系统提示有角色说明、工具被收窄、本轮要求带用户选择，原话不改', async () => {
  let seen;
  const adapter = { async stream(o) { seen = o; o.onText('好的'); return { text: '好的', toolCalls: [], stop: 'end_turn' }; } };
  const tools = ['create_document', 'web_search', 'computer_click', 'run_python'].map(tool);
  await agent.runAgent({ adapter, model: 'm', history: [], userText: '帮我做一份智慧园区项目汇报PPT', tools, context: ctx, emit: () => {}, quiet: true, agent: { profile: ppt, note: '用户选择：页数 6-10；场景 政企汇报' } });
  const system = JSON.stringify(seen.system);
  expect(system).toContain('当前智能体：PPT 制作');
  expect(system).toContain('页数 6-10');
  const names = seen.tools.map(t => t.name);
  expect(names).not.toContain('computer_click');
  expect(names).not.toContain('run_python');
  expect(JSON.stringify(seen.messages)).toContain('帮我做一份智慧园区项目汇报PPT');
});

it('主循环：不带智能体时和原来一样，没有角色说明，工具不被收窄', async () => {
  let seen;
  const adapter = { async stream(o) { seen = o; o.onText('好的'); return { text: '好的', toolCalls: [], stop: 'end_turn' }; } };
  const tools = ['create_document', 'computer_click', 'run_python'].map(tool);
  await agent.runAgent({ adapter, model: 'm', history: [], userText: '帮我做一份智慧园区项目汇报PPT', tools, context: ctx, emit: () => {}, quiet: true });
  expect(JSON.stringify(seen.system)).not.toContain('当前智能体');
  const offered = new Set(seen.tools.map(t => t.name));
  expect(offered.has('create_document')).toBe(true);
});

it('专业技能说明：8 个内置智能体都有，进系统提示；自建智能体不能借用', async () => {
  const { AGENT_SKILLS, agentSkill } = await import('../src/agent/agentSkills.js');
  const { agentPromptNote } = await import('../src/agent/agentTurn.js');
  for (const p of BUILTIN_AGENTS) {
    expect(AGENT_SKILLS[p.id], p.id).toBeTruthy();
    expect([...AGENT_SKILLS[p.id]].length, p.id).toBeLessThanOrEqual(1200);
    expect(agentPromptNote(p)).toContain(AGENT_SKILLS[p.id].slice(0, 20));
  }
  expect(agentSkill({ ...ppt, source: 'user' })).toBe('');
  expect(agentPromptNote({ ...ppt, source: 'user' })).not.toContain('PPT 制作专业方法');
  expect(AGENT_SKILLS['gongwen-writer']).toMatch(/一文一事/);
  expect(AGENT_SKILLS['health-advisor']).toMatch(/120/);
});
