import * as workspace from '../agent/workspace.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { createWorkspaceFiles } from './workspaceFiles.js';

// 文件夹跟随当前运行位置；手账保存在设备上，按同一个工作区和成员分开。
export function createNestDeskOptions(app) {
  return {
    getWorkspace: createWorkspaceFiles(app),
    getScope: () => (app.server ? 'server:' + app.server.base : 'local') + userStorageSuffix() + ':' + workspace.mode() + ':' + (workspace.folderName() || ''),
    openFile: (path) => app.openInWorkspace(path),
    openWorkspace: () => app.showPanel('workspace')
  };
}
