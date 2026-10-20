/**
 * 多设备同步（阿里云 OSS，端到端加密）和服务器模式设置面板。
 */
import { loadConfig, saveConfig } from '../llm/config.js';
import { createSyncController } from '../sync/controller.js';
import { initSyncPanel, describeResult } from '../ui/syncPanel.js';
import { initServerPanel } from '../ui/serverPanel.js';
import * as habits from '../agent/habits.js';
import * as skillPacks from '../agent/skillPacks.js';
import * as sessionsApi from '../agent/sessions.js';
import { storage, toast } from './env.js';

export function createSync(app) {
  let syncPanel = null;
  /** 开始同步（启动时调用） */
  function initSync() {
    const syncController = createSyncController({
      storage,
      getGateway: () => app.gateway,
      loadConfig,
      saveConfig,
      beforeSync: () => habits.flush(),
      afterSync: async (r) => {
        if (r.memory?.changedLocal) {
          await habits.reload();
          app.panels.refreshMind();
          skillPacks.changed();
        }
        if (r.config?.changedLocal) app.panels.reloadConfig();
        if (r.sessions?.changedLocal) {
          app.sessionsPanel.refresh();
          // 当前对话在另一台设备上接着聊过：没在回答时换成合并后的版本
          const fresh = !app.active && app.history.length ? await sessionsApi.get(app.session.id) : null;
          if (fresh && fresh.messages.length !== app.history.length) {
            app.session = fresh;
            app.reflectFrom = app.history.length;
            app.replayTranscript();
          }
        }
      },
      onState: ({ state, result, error, manual }) => {
        syncPanel?.render();
        if (state === 'done' && !manual && Object.values(result).some((g) => g.pulled)) toast(`已从其他设备同步：${describeResult(result)}`);
        if (state === 'error' && !manual) console.warn('[同步]', error);
      }
    });
    syncPanel = initSyncPanel({ controller: syncController, toast: (t) => toast(t) });
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
    syncController.start();
  }

  return { initSync };
}
