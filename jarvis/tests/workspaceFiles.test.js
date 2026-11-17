import { it, expect, vi } from 'vitest';
import { createWorkspaceFiles } from '../src/app/workspaceFiles.js';

const primary = '.workflows/posters/11111111-1111-1111-1111-111111111111/attempt-3/海报.png';
function fixture() {
  let owner = 'first';
  const local = { mode: () => 'virtual', folderName: () => null, canUseFolders: () => true,
    list: vi.fn(async () => [{ path: primary, size: 8 }]), readBlob: vi.fn(async () => new Blob(['local-copy'])) };
  const server = { listFiles: vi.fn(async () => ['png', 'svg', 'pptx'].map(ext => ({ path: primary.replace(/png$/, ext), size: 12 }))),
    download: vi.fn(async () => new Blob(['server-original'], { type: 'application/octet-stream' })) };
  const app = { server };
  const capture = createWorkspaceFiles(app, { files: local, identity: () => owner });
  return { app, capture, local, server, changeOwner: () => { owner = 'second'; } };
}
it('云端目录不依赖本机只收到PNG；枚举目录不下载任何原文件', async () => {
  const { capture, local, server } = fixture();
  const source = capture();
  expect(await source.list()).toHaveLength(3);
  expect(local.list).not.toHaveBeenCalled();
  expect(server.download).not.toHaveBeenCalled();
  expect(source.mode()).toBe('server');
  expect(source.canUseFolders()).toBe(false);
});
it('同名本机副本不覆盖云端读取，SVG补MIME但原字节完全不变', async () => {
  const { capture, local } = fixture();
  const blob = await capture().readBlob(primary.replace(/png$/, 'svg'));
  expect(blob.type).toBe('image/svg+xml');
  expect(await blob.text()).toBe('server-original');
  expect(local.readBlob).not.toHaveBeenCalled();
});
it('PPTX下载保持原始二进制，文件格式不经过文本转换', async () => {
  const { capture, server } = fixture();
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 255, 193, 0]);
  server.download.mockResolvedValue(new Blob([bytes]));
  const blob = await capture().readBlob(primary.replace(/png$/, 'pptx'));
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  expect(blob.type).toContain('presentationml');
});
it('源文件缺失或鉴权失败时报告原错误，不拿同名本机文件冒充', async () => {
  const { capture, server, local } = fixture();
  server.download.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
  await expect(capture().readBlob(primary)).rejects.toMatchObject({ status: 404 });
  expect(local.readBlob).not.toHaveBeenCalled();
});
it('真正零字节的文件明确报空，不能显示白页作为成功预览', async () => {
  const { capture, server } = fixture();
  server.download.mockResolvedValue(new Blob([]));
  await expect(capture().readBlob(primary)).rejects.toMatchObject({ code: 'WORKSPACE_EMPTY_FILE' });
});
it('文件和目录在途时切服务器，旧结果不流入新视图', async () => {
  const { capture, app, server } = fixture();
  let finish;
  server.download.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = capture().readBlob(primary);
  app.server = {};
  finish(new Blob(['old-private-image']));
  await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
});
it('同服务器切用户或旧操作重试均被拒绝', async () => {
  const { capture, changeOwner, server } = fixture();
  const source = capture();
  changeOwner();
  await expect(source.list()).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
  expect(server.listFiles).not.toHaveBeenCalled();
});
it('本地模式保持本机工作区，不因保存过服务器配置而调用云端', async () => {
  const { capture, app, local, server } = fixture();
  app.server = null;
  const source = capture();
  expect(await source.list()).toHaveLength(1);
  expect(await (await source.readBlob(primary)).text()).toBe('local-copy');
  expect(local.list).toHaveBeenCalledTimes(1);
  expect(server.download).not.toHaveBeenCalled();
});
it('单次打开HTML的多次依赖检查合并目录请求，新打开仍取新目录', async () => {
  const { capture, server } = fixture();
  const source = capture();
  expect(await source.exists(primary)).toBe(true);
  expect(await source.exists('不存在.svg')).toBe(false);
  expect(server.listFiles).toHaveBeenCalledTimes(1);
  await capture().list();
  expect(server.listFiles).toHaveBeenCalledTimes(2);
});
it('恢复本机文件夹后读取正常，之后另一次换目录仍拦截', async () => {
  const { capture, app, local } = fixture();
  app.server = null;
  let mode = 'virtual', folder = null;
  local.mode = () => mode;
  local.folderName = () => folder;
  local.restoreFolder = async () => { mode = 'folder'; folder = '授权目录'; return folder; };
  const source = capture();
  await source.restoreFolder();
  expect(source.mode()).toBe('folder');
  expect(await source.list()).toHaveLength(1);
  folder = '另一个目录';
  await expect(source.readBlob(primary)).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
});
it('云端预览导出PDF回到相同服务器，不悄悄写本机导致文件再次消失', async () => {
  const { capture, local, server } = fixture();
  server.upload = vi.fn(async p => ({ path: p }));
  local.write = vi.fn();
  const blob = new Blob(['PDF']);
  expect(await capture().write('海报/说明.pdf', blob)).toEqual({ path: '海报/说明.pdf' });
  expect(server.upload).toHaveBeenCalledWith('海报/说明.pdf', blob);
  expect(local.write).not.toHaveBeenCalled();
});
