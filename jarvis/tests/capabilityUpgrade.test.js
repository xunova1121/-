import { describe, it, expect } from 'vitest';
import { capabilityUpgradeRoutes } from '../src/llm/capabilityUpgrade.js';
import { createCapabilityUpgrade } from '../src/agent/capabilityUpgrade.js';
import { runAgent } from '../src/agent/agent.js';

const cfg = { provider: 'openai', keys: { openai: 'fixture-only' }, models: { openai: 'small' }, abilities: { code: { main: { provider: 'openai', model: 'coder' } }, reason: { main: { provider: 'openai', model: 'thinker' } } } };
const adapterFor = config => ({ model: config.models[config.provider], adapter: { kind: 'mock' } });
describe('能力切换的费用与权限边界', () => {
  it('只认明确能力配置；固定、关闭、缺配置不切换，不从普通模型库猜强模型', () => {
    expect(capabilityUpgradeRoutes(cfg, adapterFor, { provider: 'openai', model: 'small' }).map(r => r.model)).toEqual(['coder', 'thinker']);
    expect(capabilityUpgradeRoutes({ ...cfg, pinModel: true }, adapterFor)).toEqual([]);
    expect(capabilityUpgradeRoutes({ ...cfg, capabilityUpgrade: false }, adapterFor)).toEqual([]);
    expect(capabilityUpgradeRoutes({ ...cfg, abilities: {} }, adapterFor)).toEqual([]);
    expect(capabilityUpgradeRoutes(cfg, adapterFor, { provider: 'openai', model: 'coder' }).map(r => r.model)).toEqual(['thinker']);
  });
  it.each([{ status: 401 }, { kind: 'timeout' }, { kind: 'network' }, { code: 'NOT_APPROVED' }, { code: 'NO_MARKET_DATA' }])('真实接口/权限失败不触发能力升级：%j', async failure => {
    const controller = createCapabilityUpgrade({ routes: [{ task: 'code', model: 'coder' }], intent: { category: 'code' } });
    controller.observe([{ c: { name: 'code_run' }, failure, ok: false }]);
    expect(await controller.tool.run({ task: 'code', reason: 'verification_failed' })).toContain('不升级');
    expect(controller.take()).toBe(null);
  });
  it('最多切换一次；取消不发请求；普通聊天不切换', async () => {
    const controller = createCapabilityUpgrade({ routes: [{ task: 'code', model: 'coder' }], intent: { category: 'code' } });
    await controller.tool.run({ task: 'code', reason: 'task_complexity' });
    expect(controller.take().model).toBe('coder');
    expect(await controller.tool.run({ task: 'code', reason: 'task_complexity' })).toContain('已使用过');
    expect(controller.take()).toBe(null);
    const chat = createCapabilityUpgrade({ routes: [{ task: 'code', model: 'coder' }], intent: { category: 'chat' } });
    expect(await chat.tool.run({ task: 'code', reason: 'task_complexity' })).toContain('保持当前模型');
    const aborted = new AbortController(); aborted.abort();
    const stopped = createCapabilityUpgrade({ routes: [{ task: 'code', model: 'coder' }], intent: { category: 'code' }, signal: aborted.signal });
    await expect(stopped.tool.run({ task: 'code', reason: 'task_complexity' })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('无关工具成功不能掩盖接口失败；同一接口恢复后才允许升级', async () => {
    const controller = createCapabilityUpgrade({ routes: [{ task: 'code', model: 'coder' }], intent: { category: 'code' } });
    controller.observe([{ c: { name: 'read_url' }, failure: { kind: 'network' }, ok: false }, { c: { name: 'list_files' }, ok: true }]);
    expect(await controller.tool.run({ task: 'code', reason: 'verification_failed' })).toContain('不升级');
    controller.observe([{ c: { name: 'read_url' }, ok: true }]);
    await controller.tool.run({ task: 'code', reason: 'task_complexity' });
    expect(controller.take().model).toBe('coder');
  });
  it('主循环同一上下文切到已配置模型，既有成功回执保留，不再暗中重试', async () => {
    const seen = [], events = [];
    const initial = { stream: async () => ({ text: '', toolCalls: [{ id: 'upgrade', name: 'request_capable_model', args: { task: 'reason', reason: 'task_complexity' } }], stop: 'tool_use' }) };
    const stronger = { stream: async input => { seen.push(input); return { text: '结论：按现有材料比较，两种方案各有适用条件。', toolCalls: [], stop: 'end_turn' }; } };
    await runAgent({ adapter: initial, model: 'small', userText: '对比两个实施方案的利弊', history: [{ role: 'user', content: '已有资料：两个方案均不采购新设备。' }], tools: [], context: { dynamic: '' }, emit: e => events.push(e), capabilityRoutes: [{ task: 'reason', model: 'thinker', adapter: stronger }] });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ model: 'thinker', maxTransientRetries: 0, maxPartialRetries: 0 });
    expect(JSON.stringify(seen[0].messages)).toContain('不采购新设备');
    expect(events.filter(e => e.type === 'fallback')).toHaveLength(1);
  });
  it('图片或电脑操作不暴露未知看图能力的升级线路，工具读图后也停止升级', async () => {
    for (const visual of [{ images: [{ data: 'fixture', mimeType: 'image/png' }] }, { computerTask: true }]) {
      let offered;
      await runAgent({ adapter: { stream: async input => { offered = input.tools; return { text: '保留现有能力。', toolCalls: [], stop: 'end_turn' }; } }, model: 'gpt-4o', history: [], userText: '分析当前材料', tools: [], emit: () => {}, context: { dynamic: '' }, capabilityRoutes: [{ task: 'code', model: 'text-only-coder', adapter: {} }], ...visual });
      expect(offered.some(tool => tool.name === 'request_capable_model')).toBe(false);
    }
    const controller = createCapabilityUpgrade({ routes: [{ task: 'code', model: 'text-only-coder' }], intent: { category: 'work' } });
    controller.observe([{ c: { name: 'read_file' }, ok: true, outImages: [{ data: 'fixture' }] }]);
    expect(await controller.tool.run({ task: 'code', reason: 'task_complexity' })).toContain('现有看图线路');
    expect(controller.take()).toBe(null);
  });
  it('升级后超过4次调用会停止，不借备用或额外重试突破额度', async () => {
    let calls = 0;
    const initial = { stream: async () => ({ text: '', toolCalls: [{ id: 'upgrade', name: 'request_capable_model', args: { task: 'reason', reason: 'task_complexity' } }], stop: 'tool_use' }) };
    const stronger = { stream: async () => ({ text: '', toolCalls: [{ id: 'read' + ++calls, name: 'fixture_read', args: { n: calls } }], stop: 'tool_use' }) };
    await expect(runAgent({ adapter: initial, model: 'small', userText: '对比两个实施方案', history: [], tools: [{ name: 'fixture_read', input_schema: { type: 'object' }, run: async () => '已有证据' }], context: { dynamic: '' }, emit: () => {}, capabilityRoutes: [{ task: 'reason', model: 'thinker', adapter: stronger }] })).rejects.toMatchObject({ code: 'CAPABILITY_BUDGET' });
    expect(calls).toBe(4);
  });
});
