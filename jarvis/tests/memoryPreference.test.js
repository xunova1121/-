import { beforeEach, describe, expect, it } from 'vitest';
import { preferenceSupported } from '../src/agent/memoryPreference.js';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';

beforeEach(async () => {
  await collection('memories').clear();
  memory.configureMemory({});
});

describe('偏好必须被用户原话支持', () => {
  it('有对象不等于有偏好，第三人称和否定方向不能混淆', () => {
    expect(preferenceSupported('用户喜欢种花生', '花生怎么种，我帮同事问')).toBe(false);
    expect(preferenceSupported('用户喜欢咖啡', '我同事喜欢咖啡')).toBe(false);
    expect(preferenceSupported('用户喜欢咖啡', '我不喜欢咖啡')).toBe(false);
    expect(preferenceSupported('用户喜欢游泳', '我喜欢游泳吗？')).toBe(false);
    expect(preferenceSupported('用户喜欢游泳和咖啡', '我喜欢游泳')).toBe(false);
    expect(preferenceSupported('用户不喜欢咖啡', '我不喜欢咖啡')).toBe(true);
    expect(preferenceSupported('用户喜欢游泳', '我喜欢游泳')).toBe(true);
    expect(preferenceSupported('用户喜欢咖啡', '我喜欢咖啡。补充：我不喜欢咖啡')).toBe(false);
  });
  it('真实引文也不能把咨询确认作爱好，两段重复咨询不转正', async () => {
    memory.configureMemory({ llm: async () => JSON.stringify({ memories: [{ content: '用户喜欢种花生', quote: '花生怎么种', category: 'preference' }], summary: '咨询种植' }) });
    await memory.reflect([{ role: 'user', content: '花生怎么种' }], { session: { id: 'first' } });
    await memory.reflect([{ role: 'user', content: '花生怎么种' }], { session: { id: 'second' } });
    const stored = (await memory.listAll()).memories.find((record) => record.content === '用户喜欢种花生');
    expect(stored).toMatchObject({ pending: true, needsPreferenceConfirmation: true });
  });
  it('明确偏好仍能自动确认，不多问一次用户', async () => {
    memory.configureMemory({ llm: async () => JSON.stringify({ memories: [{ content: '用户喜欢游泳', quote: '我喜欢游泳', category: 'preference' }], summary: '用户自述' }) });
    await memory.reflect([{ role: 'user', content: '我喜欢游泳' }]);
    expect((await memory.listAll()).memories[0].pending).toBe(false);
  });
  it('撤回后旧对话不得自动复活，用户明确重新记住仍可恢复', async () => {
    const record = await memory.remember('用户喜欢喝咖啡', 'preference');
    await memory.forget(record.id);
    await expect(memory.remember('用户喜欢咖啡', 'preference', { source: '会话 old 自动提炼，原话已核对', evidence: '我喜欢咖啡' })).rejects.toMatchObject({ code: 'MEMORY_RETRACTED' });
    expect((await memory.listAll()).memories).toEqual([]);
    await memory.remember('用户喜欢咖啡', 'preference', { source: '用户明确指令经工具记录', evidence: '我又喜欢咖啡了，请记住' });
    expect((await memory.listAll()).memories).toHaveLength(1);
  });
  it('记忆工具取本轮原话，不把一次问法升级为确认的偏好', async () => {
    const tool = createTools({}).find((item) => item.name === 'remember');
    await tool.run({ content: '用户喜欢种花生', category: 'preference' }, { requestText: '记住：我只是咨询花生怎么种，不是个人爱好。' });
    expect((await memory.listAll()).memories[0].pending).toBe(true);
  });
});
