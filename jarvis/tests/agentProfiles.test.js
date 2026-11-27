import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENTS, createAgentRegistry, MAX_USER_AGENTS, PROFILE_STORE_KEY, validateProfile, useRemote, listAgents, createAgent } from '../src/agent/agentProfiles.js';
import { CORE } from '../src/agent/toolLoader.js';
import { createTools } from '../src/agent/tools.js';

const custom = (id = 'my-agent', extra = {}) => ({ ...structuredClone(BUILTIN_AGENTS[0]), id, source: 'user', ...extra });
const memory = () => {
  const rows = new Map();
  return { get: async id => structuredClone(rows.get(id)), put: async row => rows.set(row.id, structuredClone(row)) };
};
afterEach(() => { useRemote(null); vi.unstubAllGlobals(); });

describe('智能体配置注册表', () => {
  it('首批8个全部有效、ID唯一、工具在实际工具目录或CORE中', () => {
    expect(BUILTIN_AGENTS.map(p => p.name)).toEqual(['PPT 制作', '公文写作', '深度研究', '海报设计', '图片转文字', '健康顾问', '出行天气', '行情查询']);
    const names = new Set([...CORE, ...createTools({}).map(t => t.name)]), ids = [];
    for (const p of BUILTIN_AGENTS) {
      expect(validateProfile(p, { existingIds: ids, toolNames: names })).toEqual(p);
      ids.push(p.id);
    }
    expect(() => { BUILTIN_AGENTS[0].tools.push('not-a-tool'); }).toThrow();
  });

  it.each([
    ['id', { id: '../owner' }], ['id', { id: 'Bad_ID' }], ['name', { name: '' }],
    ['icon', { icon: 'https://host/icon.svg' }], ['category', { category: 'admin' }],
    ['intro', { intro: 12 }], ['starters', { starters: ['只有一个'] }],
    ['starters', { starters: ['重复', '重复', '第三个'] }],
    ['prompt', { prompt: '字'.repeat(601) }], ['prompt', { prompt: 'bad\u0000text' }],
    ['tools[0]', { tools: ['missing_tool'] }], ['tools', { tools: ['read_file', 'read_file'] }],
    ['form[0].options', { form: [{ key: 'pages', label: '页数', type: 'select', options: [] }] }],
    ['form[0].options', { form: [{ key: 'pages', label: '页数', type: 'select', options: ['3', '3'] }] }],
    ['form[0].default', { form: [{ key: 'pages', label: '页数', type: 'select', options: ['3'], default: '8' }] }],
    ['form[0].type', { form: [{ key: 'run', label: '操作', type: 'script' }] }],
    ['form.key', { form: [{ key: 'a', label: '甲', type: 'text' }, { key: 'a', label: '乙', type: 'text' }] }],
    ['output', { output: 'exe' }], ['source', { source: 'owner' }],
    ['profile', { apiKey: 'fixture-credential-never-echo' }], ['profile', { userId: 'owner' }]
  ])('非法配置指出字段 %s，不回显无关原值', (field, extra) => {
    try { validateProfile(custom('my-agent', extra)); throw new Error('未拒绝'); }
    catch (e) {
      expect(e).toMatchObject({ name: 'ValidationError', field, code: 'INVALID_AGENT_PROFILE', status: 400 });
      expect(e.message).toContain(field);
      expect(e.message).not.toContain('fixture-credential-never-echo');
    }
  });

  it('重复ID报明确冲突，空工具白名单保留，emoji按字符计数，返回独立对象', () => {
    const value = custom('my-agent', { tools: [], prompt: '🧭'.repeat(600) });
    const checked = validateProfile(value);
    expect(checked.tools).toEqual([]);
    expect(checked).toEqual(value);
    checked.starters[0] = '改动';
    expect(value.starters[0]).not.toBe('改动');
    expect(() => validateProfile(value, { existingIds: ['my-agent'] })).toThrow(/id.*已存在/);
    const sparse = new Array(3); sparse[2] = '尾部'; sparse.other = '伪造'; sparse.extra = '伪造';
    expect(() => validateProfile(custom('my-agent', { starters: sparse }))).toThrow(/starters/);
  });

  it('分类、我的和不区分大小写的搜索可组合；内置结果不可被调用方改写', async () => {
    const registry = createAgentRegistry(memory());
    await registry.createAgent(custom('my-ppt', { name: '自己的汇报', category: 'office' }));
    await registry.createAgent(custom('my-health', { name: '自己的健康', category: 'life' }));
    expect(await registry.listAgents({ category: 'mine' })).toHaveLength(2);
    expect((await registry.listAgents({ category: 'office', query: 'ppt' })).map(p => p.id)).toEqual(['ppt-maker', 'my-ppt']);
    expect(await registry.listAgents({ query: '绝对没有的词' })).toEqual([]);
    expect(await registry.getAgent('not-here')).toBeNull();
    const first = await registry.getAgent('ppt-maker'); first.name = '改写';
    expect((await registry.getAgent('ppt-maker')).name).toBe('PPT 制作');
  });

  it('创建、替换、重开和删除；拒绝覆盖内置、变更ID/来源及未知目标', async () => {
    const storage = memory(), registry = createAgentRegistry(storage);
    await registry.createAgent(custom());
    await expect(async () => registry.createAgent(custom())).rejects.toMatchObject({ status: 409, field: 'id' });
    await registry.updateAgent('my-agent', custom('my-agent', { name: '新名字' }));
    const reopened = createAgentRegistry(storage);
    expect((await reopened.getAgent('my-agent')).name).toBe('新名字');
    await expect(async () => reopened.updateAgent('my-agent', custom('other'))).rejects.toMatchObject({ field: 'id' });
    await expect(async () => reopened.updateAgent('my-agent', custom('my-agent', { source: 'github' }))).rejects.toMatchObject({ field: 'source' });
    await expect(async () => reopened.updateAgent('missing', custom('missing'))).rejects.toMatchObject({ status: 404 });
    await expect(async () => reopened.createAgent(custom('new', { source: 'builtin' }))).rejects.toMatchObject({ field: 'source' });
    await expect(async () => reopened.createAgent(custom('ppt-maker'))).rejects.toMatchObject({ field: 'id' });
    await expect(async () => reopened.removeAgent('ppt-maker')).rejects.toMatchObject({ field: 'id' });
    await expect(async () => reopened.updateAgent('ppt-maker', BUILTIN_AGENTS[0])).rejects.toMatchObject({ field: 'id' });
    await reopened.removeAgent('my-agent');
    expect(await reopened.getAgent('my-agent')).toBeNull();
  });

  it('并发创建不丢配置，同名只成功一次；数量上限不会绕过', async () => {
    const registry = createAgentRegistry(memory());
    const duplicate = await Promise.allSettled([registry.createAgent(custom()), registry.createAgent(custom())]);
    expect(duplicate.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    await Promise.all(Array.from({ length: MAX_USER_AGENTS - 1 }, (_, i) => registry.createAgent(custom('agent-' + i))));
    expect(await registry.listAgents({ category: 'mine' })).toHaveLength(MAX_USER_AGENTS);
    await expect(async () => registry.createAgent(custom('overflow'))).rejects.toMatchObject({ status: 409, field: 'profiles' });
    await registry.updateAgent('my-agent', custom('my-agent', { name: '达到上限也能修改' }));
    expect((await registry.getAgent('my-agent')).name).toBe('达到上限也能修改');
  });

  it('配置格式损坏不覆盖原始数据，写入失败传播并允许下次重试', async () => {
    const storage = memory(), registry = createAgentRegistry(storage);
    const damaged = { id: PROFILE_STORE_KEY, version: 99, items: [{ id: 'old' }] };
    await storage.put(damaged);
    await expect(async () => registry.createAgent(custom())).rejects.toMatchObject({ field: 'storage' });
    expect(await storage.get(PROFILE_STORE_KEY)).toEqual(damaged);
    const working = memory(), write = working.put;
    working.put = vi.fn().mockRejectedValueOnce(new Error('磁盘不可写')).mockImplementation(write);
    const another = createAgentRegistry(working);
    await expect(another.createAgent(custom())).rejects.toThrow('磁盘不可写');
    await another.createAgent(custom());
    expect((await another.getAgent('my-agent')).id).toBe('my-agent');
  });

  it('云模式失败不冒充已保存，不向本机回退，切回本机恢复独立列表', async () => {
    const before = await listAgents();
    const error = Object.assign(new Error('连接失败'), { code: 'NETWORK_ERROR' });
    const remote = { listAgents: vi.fn().mockResolvedValue([custom('remote')]), createAgent: vi.fn().mockRejectedValue(error) };
    useRemote(remote);
    expect((await listAgents())[0].id).toBe('remote');
    await expect(createAgent(custom())).rejects.toBe(error);
    useRemote(null);
    expect(await listAgents()).toEqual(before);
  });
});
