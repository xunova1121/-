import { it, expect, vi } from 'vitest';
import { openaiSearchPanel } from '../src/ui/openaiSearchPanel.js';

const node = (tag, props = {}, ...children) => ({
  tag, value: '', checked: false, disabled: false, ...props, children: children.flat(), events: {},
  addEventListener(event, handler) { this.events[event] = handler; }
});
const flatten = value => [value, ...(value.children || []).filter(child => child && typeof child === 'object').flatMap(flatten)];
const configuration = () => ({
  provider: 'custom-chat', keys: { 'custom-chat': 'chat-key-stays-private' }, openaiSearchEnabled: true,
  openaiSearchBaseURL: 'https://search.example.com/v1', openaiSearchModel: 'web-model',
  openaiSearchProtocol: 'responses', openaiSearchKey: 'search-key-stays-private'
});
function mount(cfg = configuration()) {
  const saved = { server: { ...cfg }, local: { provider: 'local-chat', openaiSearchKey: 'local-secret' } };
  const workspace = {
    scope: 'server',
    patch: vi.fn(async (change, scope) => { saved[scope] = change(saved[scope]); }),
    testOpenaiSearch: vi.fn(async () => ({ count: 3, ms: 120, requests: 1 }))
  };
  const tree = openaiSearchPanel({ cfg, workspace, node, toast: vi.fn() });
  const rows = flatten(tree);
  const field = label => rows.find(row => row.ariaLabel === label);
  const click = label => rows.find(row => row.textContent === label).events.click();
  return { saved, workspace, tree, rows, field, click, outcome: rows.find(row => row.role === 'status') };
}

it('只显示已配置状态，不将本机或服务器的完整密钥放进输入框和页面', () => {
  const panel = mount();
  expect(JSON.stringify(panel.tree)).not.toContain('search-key-stays-private');
  expect(JSON.stringify(panel.tree)).not.toContain('chat-key-stays-private');
  expect(panel.field('自定义搜索API Key').value).toBe('');
  expect(panel.field('自定义搜索API Key').placeholder).toBe('已配置；留空保留');
});

it('保存捕获原位置，留空保留旧Key；切到本机也不串写，不改变聊天线路', async () => {
  const panel = mount();
  panel.workspace.scope = 'local';
  panel.field('自定义搜索模型ID').value = 'new-web-model';
  await panel.click('保存自定义搜索');
  expect(panel.workspace.patch).toHaveBeenCalledWith(expect.any(Function), 'server');
  expect(panel.saved.server).toMatchObject({ provider: 'custom-chat', openaiSearchModel: 'new-web-model', openaiSearchKey: 'search-key-stays-private' });
  expect(panel.saved.local).toEqual({ provider: 'local-chat', openaiSearchKey: 'local-secret' });
});

it('新Key保存后清空表单；关闭搜索保留地址/Key并与启用状态分开', async () => {
  const panel = mount();
  panel.field('自定义搜索API Key').value = 'replaced-search-key';
  panel.field('启用自定义联网搜索').checked = false;
  await panel.click('保存自定义搜索');
  expect(panel.saved.server).toMatchObject({ openaiSearchKey: 'replaced-search-key', openaiSearchEnabled: false });
  expect(panel.field('自定义搜索API Key').value).toBe('');
  expect(JSON.stringify(panel.tree)).not.toContain('replaced-search-key');
});

it('地址、协议、模型、开关或Key未保存时都不测试旧配置', async () => {
  for (const [label, property, value] of [
    ['自定义搜索API地址', 'value', 'https://new-search.example.com/v1'],
    ['自定义搜索模型ID', 'value', 'another-model'],
    ['自定义搜索接口格式', 'value', 'chat-completions'],
    ['启用自定义联网搜索', 'checked', false],
    ['自定义搜索API Key', 'value', 'new-secret']
  ]) {
    const panel = mount();
    panel.field(label)[property] = value;
    await panel.click('测试自定义搜索');
    expect(panel.workspace.testOpenaiSearch).not.toHaveBeenCalled();
    expect(panel.outcome.textContent).toContain('未保存');
  }
});

it('启用缺少配置、非HTTPS和带凭据的地址不保存，不默认猜测模型', async () => {
  const missing = mount({});
  missing.field('启用自定义联网搜索').checked = true;
  await missing.click('保存自定义搜索');
  expect(missing.workspace.patch).not.toHaveBeenCalled();
  expect(missing.field('自定义搜索模型ID').value).toBe('');
  for (const address of ['http://search.example.com/v1', 'https://user:password@search.example.com/v1']) {
    const panel = mount();
    panel.field('自定义搜索API地址').value = address;
    await panel.click('保存自定义搜索');
    expect(panel.workspace.patch).not.toHaveBeenCalled();
    expect(panel.outcome.textContent).toBeTruthy();
  }
});

it('测试仅调用保存位置，显示真实来源数量；零来源不能显示可用', async () => {
  const panel = mount();
  panel.workspace.scope = 'local';
  await panel.click('测试自定义搜索');
  expect(panel.workspace.testOpenaiSearch).toHaveBeenCalledWith('server', expect.any(AbortSignal));
  expect(panel.outcome.textContent).toContain('返回3条网页来源');
  panel.workspace.testOpenaiSearch.mockResolvedValueOnce({ count: 0, ms: 100, requests: 1 });
  await panel.click('测试自定义搜索');
  expect(panel.outcome.textContent).toContain('没有返回网页来源');
  expect(panel.outcome.textContent).not.toContain('搜索可用');
});

it('测试可停止，停止后可再次测试；测试期间不能更换已保存Key', async () => {
  const panel = mount();
  panel.workspace.testOpenaiSearch.mockImplementationOnce((_scope, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const running = panel.click('测试自定义搜索');
  await panel.click('保存自定义搜索');
  expect(panel.workspace.patch).not.toHaveBeenCalled();
  await panel.click('停止搜索测试');
  await running;
  expect(panel.outcome.textContent).toBe('已停止测试');
  await panel.click('测试自定义搜索');
  expect(panel.outcome.textContent).toContain('搜索可用');
});

it('保存失败保留待保存的内容，不伪称保存成功或允许拿旧配置测试', async () => {
  const panel = mount();
  panel.workspace.patch.mockRejectedValueOnce(new Error('服务器保存失败'));
  panel.field('自定义搜索API Key').value = 'new-secret';
  await panel.click('保存自定义搜索');
  expect(panel.field('自定义搜索API Key').value).toBe('new-secret');
  expect(panel.outcome.textContent).toBe('服务器保存失败');
  await panel.click('测试自定义搜索');
  expect(panel.workspace.testOpenaiSearch).not.toHaveBeenCalled();
});
