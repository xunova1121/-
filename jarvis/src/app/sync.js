/**
 * 服务器模式设置面板（登录、更新服务器、把本机对话传上去）。
 * 原来的阿里云 OSS 多设备同步已按用户要求去掉：用服务器模式时对话本来就存在服务器上。
 */
import { initServerPanel } from '../ui/serverPanel.js';
import { toast } from './env.js';

export function createSync(app) {
  /** 启动时调用 */
  function initSync() {
    initServerPanel({
      getLlmConfig: () => app.llmConfig,
      toast: (t) => toast(t),
      onConfigSaved: () => app.refreshServerModel(),
      onOpenModels: () => app.modelWorkspace.show('server'),
      onImported: () => {
        app.sessionsPanel?.refresh();
        app.drawer?.refresh?.();
      }
    });
  }

  return { initSync };
}
