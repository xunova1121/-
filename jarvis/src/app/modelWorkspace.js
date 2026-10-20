/** 模型工作台：分位置读写配置，界面细节放在ui，不改任务执行中的运行位置。 */
import { createModelScopes } from '../llm/modelScopes.js';
import { copyModelSettings, chooseLine, currentLine } from '../llm/modelLibrary.js';
import { loadServerSettings, saveServerSettings, createServerClient } from '../core/serverClient.js';
import { fetchModelCatalog } from '../llm/modelCatalog.js';
import { initModelLibrary } from '../ui/modelLibrary.js';
import { $, toast } from './env.js';

export function createModelWorkspace(app) {
  let scope = app.server ? 'server' : 'local';
  const getClient = () => {
    const settings = loadServerSettings();
    return settings.url && settings.token ? createServerClient({ base: settings.url, token: settings.token }) : null;
  };
  const scopes = createModelScopes({
    getLocal: () => app.panels.config,
    saveLocal: (cfg) => app.panels.setModelConfig(cfg),
    getClient,
    onServerSaved: (cfg) => {
      globalThis.__jarvisServerModel = currentLine(cfg).model;
      globalThis.__jarvisServerProvider = cfg.providerNames?.[cfg.provider] || cfg.provider;
      app.updateModelLabels();
    }
  });
  const workspace = {
    get scope() {
      return scope;
    },
    get runtime() {
      return app.server ? 'server' : 'local';
    },
    get serverSettings() {
      return loadServerSettings();
    },
    config: (target = scope) => scopes.get(target),
    refresh: (target = scope) => scopes.refresh(target),
    patch: (update, target = scope) => scopes.patch(target, update),
    gateway: (target = scope) => (target === 'local' ? app.gateway : null),
    async selectScope(target) {
      scope = target;
      return scopes.refresh(target);
    },
    async choose(line, target = scope) {
      return scopes.patch(target, (cfg) => chooseLine(cfg, line));
    },
    async catalog(provider, signal, target = scope) {
      if (target === 'server') {
        const client = getClient();
        if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
        return client.listModels(provider, signal);
      }
      return fetchModelCatalog({ ...app.panels.config, provider }, { gateway: app.gateway, signal });
    },
    async copyLocal() {
      return scopes.patch('server', (cfg) => ({ ...cfg, ...copyModelSettings(app.panels.config) }));
    },
    async switchRuntime(target) {
      if (target === workspace.runtime) return;
      if (app.active || app.session?.taskId) throw Object.assign(new Error('请等本轮任务结束后再切换运行位置'), { kind: 'api', code: 'TASK_ACTIVE' });
      const settings = loadServerSettings();
      if (target === 'server') {
        const client = getClient();
        if (!client) throw Object.assign(new Error('请先到设置 → 服务器模式登录'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
        await client.status();
      }
      saveServerSettings({ ...settings, enabled: target === 'server' });
      // 会话存储位置随运行位置改变，沿用既有重新加载流程，不把一段会话搬到另一端。
      location.reload();
    },
    show(target = scope) {
      scope = target;
      app.showPanel('models');
    }
  };
  const library = initModelLibrary({ root: $('#model-workspace'), workspace, toast });
  addEventListener('jarvis:panel', (message) => {
    if (message.detail === 'models') library.refresh();
  });
  return { modelWorkspace: workspace };
}
