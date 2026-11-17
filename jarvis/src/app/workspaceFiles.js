import * as workspace from '../agent/workspace.js';
import { userStorageSuffix } from '../core/userStorage.js';

/** 云端目录只取文件元数据，打开/下载才读原字节，不依赖收到过哪些任务事件。 */
export function createWorkspaceFiles(app, { files = workspace, identity = userStorageSuffix } = {}) {
  return () => {
    const server = app.server,
      owner = identity();
    let mode = files.mode(),
      folder = files.folderName();
    const check = () => {
      if (server !== app.server || owner !== identity() || mode !== files.mode() || folder !== files.folderName())
        throw Object.assign(new Error('账号、服务器或工作区已切换，请重新打开文件'), { code: 'WORKSPACE_CHANGED', kind: 'input' });
    };
    const call = async (run) => {
      check();
      const result = await run();
      check();
      return result;
    };
    let listing;
    const list = () => call(() => (listing ??= server ? server.listFiles() : files.list()));
    const readBlob = async (path) => {
      const normalized = workspace.normalize(path);
      const blob = await call(() => (server ? server.download(normalized) : files.readBlob(normalized)));
      if (!blob.size) throw Object.assign(new Error('文件内容为空，请重新生成或恢复上一稿'), { code: 'WORKSPACE_EMPTY_FILE', kind: 'input' });
      // 部分旧云端记录是application/octet-stream。按已有扩展名补MIME，字节不重编、不压缩。
      const type = workspace.MIME[workspace.ext(normalized)];
      return type && blob.type !== type ? new Blob([blob], { type }) : blob;
    };
    return {
      ...files,
      check,
      mode: () => (server ? 'server' : mode),
      canUseFolders: () => !server && files.canUseFolders(),
      restoreFolder: async (...args) => {
        check();
        if (server) return null;
        const result = await files.restoreFolder(...args);
        // 恢复本机授权文件夹本身会改变模式；后续读操作绑定恢复后的目录。
        mode = files.mode();
        folder = files.folderName();
        check();
        return result;
      },
      list,
      readBlob,
      readText: async (path) => (await readBlob(path)).text(),
      write: (path, blob) => call(() => (server ? server.upload(workspace.normalize(path), blob) : files.write(path, blob))),
      exists: (path) => call(async () => (server ? (await list()).some((file) => file.path === workspace.normalize(path)) : files.exists(path)))
    };
  };
}
