import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const files = vi.hoisted(() => ({ mode: vi.fn(() => 'virtual'), folderName: vi.fn(() => ''), ext: p => p.split('.').pop(), readBlob: vi.fn(), write: vi.fn() }));
vi.mock('../src/agent/workspace.js', () => files);
import { createStudioActions } from '../src/app/studioActions.js';
let draft;
beforeEach(() => { draft = { value: '' }; vi.stubGlobal('document', { querySelector: () => draft }); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const client = { preferences: vi.fn(async () => ({ brand: { name: '我公司' } })), copy: vi.fn(async () => ({ path: '副本.pptx' })), preview: vi.fn(async () => new Blob(['%PDF-fixture'])) };
  const server = { studio: client, download: vi.fn(async () => new Blob(['picture'])) };
  const app = { server, session: { id: 'old' }, switchTo: vi.fn(async s => { app.session = s; }), closeSide: vi.fn() };
  const fill = vi.fn(text => { draft.value = text; });
  return { app, server, client, fill, actions: createStudioActions(app, { fill, start: vi.fn() }) };
}
it('云端预览使用内存，不写入或覆盖本机同名文件', async () => {
  const { actions, client } = setup();
  const result = await actions.capture().preview('a.pptx');
  expect(result.format).toBe('pdf'); expect(result.rendered).toBe(true);
  expect(client.preview).toHaveBeenCalledWith('a.pptx', undefined);
  expect(files.write).not.toHaveBeenCalled();
});
it('云端迟到结果遇到服务器切换直接拒绝，不能填新账号草稿', async () => {
  const { actions, app, client, fill } = setup();
  let resolve;
  client.copy.mockImplementation(() => new Promise(r => { resolve = r; }));
  const pending = actions.capture().useTemplate('a.pptx');
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  app.server = { studio: {} }; resolve({ path: '旧服务器.pptx' });
  await expect(pending).rejects.toThrow('已切换'); expect(fill).not.toHaveBeenCalled();
});
it('模板带入已有要求且保留品牌，不自动发送；中途新增草稿不覆盖', async () => {
  const { actions, fill, client } = setup();
  draft.value = '做季度报告';
  await actions.capture().useTemplate('a.pptx');
  expect(fill.mock.calls[0][0]).toContain('做季度报告'); expect(fill.mock.calls[0][0]).toContain('我公司');
  fill.mockClear();
  client.copy.mockImplementation(async () => { draft.value = '新的重要要求'; return { path: '副本.pptx' }; });
  await expect(actions.capture().useTemplate('a.pptx')).rejects.toThrow('草稿已变化'); expect(fill).not.toHaveBeenCalled();
});
it('局部编辑不能覆盖已有草稿，空草稿新建通用对话避免旧智能体限制', async () => {
  const { actions, fill, app } = setup(); draft.value = '未发送的聊天';
  await expect(actions.capture().editPrompt('a.docx', '标题', '换字体', false)).rejects.toThrow('已有草稿');
  expect(fill).not.toHaveBeenCalled(); draft.value = '';
  await actions.capture().editPrompt('a.docx', '标题', '换字体', false);
  expect(app.session.agentId).toBeUndefined(); expect(draft.value).toContain('修改范围：标题'); expect(draft.value).toContain('不覆盖原件');
});
it('浏览广场不读取云端完整配置、不发模型请求', async () => {
  const { app, actions } = setup(); app.modelWorkspace = { config: vi.fn() };
  expect(await actions.configuration()).toBeNull(); expect(app.modelWorkspace.config).not.toHaveBeenCalled();
});
