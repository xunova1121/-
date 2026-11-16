import { beforeEach, it, expect, vi } from 'vitest';
import { createRemoteTask } from '../src/app/remoteTask.js';
import { useBackend } from '../src/agent/store.js';
const mocks = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn() }));
vi.mock('../src/agent/workspace.js', () => ({ write: mocks.write }));
vi.mock('../src/ui/transcript.js', () => ({ toolLabel: name => name }));
vi.mock('../src/app/env.js', () => ({ now: () => 0, toast: mocks.toast }));
const path = '.workflows/posters/11111111-1111-1111-1111-111111111111/attempt-1/今日新闻.png';
function fixture() {
  const bubble = { image: vi.fn(), fileLink: vi.fn() }, turn = { files: new Set(), bubble, ctrl: new AbortController() };
  const app = { server: { download: vi.fn().mockResolvedValue(new Blob(['bytes'])) }, panels: { markFresh: vi.fn(), refreshFiles: vi.fn() }, openInWorkspace: vi.fn() };
  return { app, turn, remote: createRemoteTask(app), bubble };
}
beforeEach(() => { useBackend(null); vi.clearAllMocks(); mocks.write.mockImplementation(async p => ({ path: p })); });
it('下载失败不留下已完成标志；同路径再次通知可以真正取回', async () => {
  const { app, turn, remote, bubble } = fixture();
  app.server.download.mockRejectedValueOnce(new Error('network'));
  await remote.pullServerFile(path, turn);
  expect(turn.files.has(path)).toBe(false);
  await remote.pullServerFile(path, turn);
  expect(app.server.download).toHaveBeenCalledTimes(2);
  expect(turn.files.has(path)).toBe(true);
  expect(bubble.fileLink).toHaveBeenCalledWith(path, app.openInWorkspace);
  expect(bubble.image).toHaveBeenCalledTimes(1);
});
it('同一路径在途请求合并，下载成功后才登记并展示', async () => {
  const { app, turn, remote } = fixture();
  let resolve;
  app.server.download.mockReturnValue(new Promise(r => { resolve = r; }));
  const a = remote.pullServerFile(path, turn), b = remote.pullServerFile(path, turn);
  expect(turn.files.size).toBe(0);
  resolve(new Blob(['bytes']));
  await Promise.all([a, b]);
  expect(app.server.download).toHaveBeenCalledTimes(1);
  expect(turn.files.has(path)).toBe(true);
});
it('下载过程中切账号/服务器后，不写入新工作区或污染当前气泡', async () => {
  const { app, turn, remote, bubble } = fixture();
  let resolve;
  app.server.download.mockReturnValue(new Promise(r => { resolve = r; }));
  const pending = remote.pullServerFile(path, turn);
  useBackend({ get: async () => null });
  resolve(new Blob(['old-account']));
  await pending;
  expect(mocks.write).not.toHaveBeenCalled();
  expect(bubble.fileLink).not.toHaveBeenCalled();
});
it('文件夹同名另存后，按钮使用实际保存路径', async () => {
  const { app, turn, remote, bubble } = fixture();
  mocks.write.mockResolvedValue({ path: '海报/今日新闻 (2).png' });
  await remote.pullServerFile(path, turn);
  expect(bubble.fileLink).toHaveBeenCalledWith('海报/今日新闻 (2).png', app.openInWorkspace);
});
it('在途文件有界，超过上限不登记完成也不触发额外下载', async () => {
  const { app, turn, remote } = fixture();
  turn.pendingFiles = new Map(Array.from({ length: 32 }, (_, i) => [String(i), Promise.resolve()]));
  await remote.pullServerFile(path, turn);
  expect(app.server.download).not.toHaveBeenCalled();
  expect(turn.files.has(path)).toBe(false);
});
