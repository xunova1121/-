import { describe, expect, it, vi } from 'vitest';
import { createAgentProfileActions } from '../src/app/agentProfileActions.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { agentFormNote } from '../src/agent/agentTurn.js';
import { closeAgentOverlay } from '../src/ui/agentNavigation.js';

const fields = { name: '我的研究助手', intro: '整理资料并列出来源', prompt: '先阅读，再核对，最后给出结论。', starter0: '查证这篇文章', starter1: '对比两个方案', starter2: '整理资料来源' };
const setup = () => {
  let identity = 'a';
  const app = { server: null };
  const api = { createAgent: vi.fn(async v => v), updateAgent: vi.fn(async (_, v) => v), removeAgent: vi.fn(async () => {}) };
  const actions = createAgentProfileActions(app, { api, scope: () => identity });
  return { app, api, actions, change: () => { identity = 'b'; } };
};

describe('第二版智能体表单和个人配置', () => {
  it('安卓返回按编辑页→模板预览→广场关闭，没有浮层才交还原返回逻辑', () => {
    const clicked = [];
    const doc = { querySelector: vi.fn(selector => selector.includes('wy-tpl-library') ? { click: () => clicked.push('template') } : null) };
    expect(closeAgentOverlay(doc)).toBe(true);
    expect(clicked).toEqual(['template']);
    expect(doc.querySelector).toHaveBeenCalledTimes(2);
    expect(closeAgentOverlay({ querySelector: () => null })).toBe(false);
  });
  it('创建调用本人注册表；保存不会调用模型，三个推荐问题与工作要求保持原文', async () => {
    const { actions, api } = setup();
    const saved = await actions.save(null, fields, actions.capture());
    expect(saved).toMatchObject({ source: 'user', category: 'mine', name: fields.name, prompt: fields.prompt, starters: [fields.starter0, fields.starter1, fields.starter2] });
    expect(api.createAgent).toHaveBeenCalledTimes(1);
    expect(api.updateAgent).not.toHaveBeenCalled();
  });
  it('编辑只更新界面字段，原工具限制、表单、来源及编号保留', async () => {
    const { actions, api } = setup();
    const old = { ...structuredClone(BUILTIN_AGENTS[0]), id: 'my-ppt', source: 'user' };
    const saved = await actions.save(old, fields, actions.capture());
    expect(saved.tools).toEqual(old.tools);
    expect(saved.form).toEqual(old.form);
    expect(saved.output).toBe('pptx');
    expect(api.updateAgent).toHaveBeenCalledWith('my-ppt', saved);
  });
  it('保存前账号切换，不访问旧账号或新账号注册表', async () => {
    const { actions, api, change } = setup();
    const token = actions.capture(); change();
    await expect(actions.save(null, fields, token)).rejects.toThrow('账号或连接已切换');
    expect(api.createAgent).not.toHaveBeenCalled();
  });
  it('保存前连接切换拒绝；异步保存后换账号也不返回可写入新界面的结果', async () => {
    const { actions, api, app, change } = setup();
    const old = actions.capture(); app.server = {};
    await expect(actions.save(null, fields, old)).rejects.toThrow('账号或连接已切换');
    api.createAgent.mockImplementationOnce(async v => { change(); return v; });
    await expect(actions.save(null, fields, actions.capture())).rejects.toThrow('账号或连接已切换');
    expect(api.createAgent).toHaveBeenCalledTimes(1);
  });
  it('服务端拒绝写入不改本地，失败可重试；非法推荐问题在请求前拒绝', async () => {
    const { actions, api } = setup();
    api.createAgent.mockRejectedValueOnce(new Error('服务器不可用'));
    const token = actions.capture();
    await expect(actions.save(null, fields, token)).rejects.toThrow('服务器不可用');
    await expect(actions.save(null, fields, token)).resolves.toMatchObject({ name: fields.name });
    await expect(actions.save(null, { ...fields, starter2: fields.starter0 }, token)).rejects.toMatchObject({ code: 'INVALID_AGENT_PROFILE' });
    expect(api.createAgent).toHaveBeenCalledTimes(2);
  });
  it('删除同样检查账号，失败不冒充删除完成', async () => {
    const { actions, api, change } = setup();
    api.removeAgent.mockRejectedValueOnce(new Error('拒绝'));
    const token = actions.capture();
    await expect(actions.remove({ id: 'my-ppt' }, token)).rejects.toThrow('拒绝');
    change();
    await expect(actions.remove({ id: 'my-ppt' }, token)).rejects.toThrow('账号或连接已切换');
    expect(api.removeAgent).toHaveBeenCalledTimes(1);
  });
  it('公文结构字段进入模型要求，恶意字段和未声明选项仍丢弃', () => {
    const p = BUILTIN_AGENTS.find(x => x.id === 'gongwen-writer');
    const note = agentFormNote(p, { kind: '通知', subject: '会议安排', notes: '周五十点开会', audience: '项目组', tone: '正式', admin: 'yes' });
    for (const text of ['文种 通知', '主题 会议安排', '内容要点 周五十点开会', '写给谁看 项目组']) expect(note).toContain(text);
    expect(note).not.toContain('admin');
    expect(agentFormNote(p, { kind: '未定义的文种' })).toBe('');
  });
  it('海报旧尺寸保持，新增风格/比例/处理和OCR目标经同一校验进入要求', () => {
    const p = BUILTIN_AGENTS.find(x => x.id === 'poster-designer');
    expect(agentFormNote(p, { size: '竖版' })).toBe('用户选择：尺寸 竖版');
    const note = agentFormNote(p, { style: '国风美学', ratio: '9:16', operation: '抠图（透明背景）', caption: '迎新活动' });
    for (const text of ['国风美学', '9:16', '抠图（透明背景）', '迎新活动']) expect(note).toContain(text);
    expect(agentFormNote(BUILTIN_AGENTS.find(x => x.id === 'image-reader'), { format: '保留表格' })).toContain('整理方式 保留表格');
  });
});
