import { createModelLocalOptions } from './modelLocalOptions.js';
import { localLookup } from './lookup.js';
import { testDeepseekSearch } from '../agent/deepseekSearch.js';
import { testQianfanSearch } from '../agent/qianfanSearch.js';
import { testOpenaiSearch } from '../agent/openaiSearch.js';
import { createOpenaiSearchFetch } from '../core/openaiSearchGateway.js';
/** 模型工作台：分位置读写配置，界面细节放在ui，不改任务执行中的运行位置。 */
import { createModelScopes } from '../llm/modelScopes.js';
import { copyModelSettings, chooseLine, currentLine, hasRouting } from '../llm/modelLibrary.js';
import { loadServerSettings, saveServerSettings, createServerClient } from '../core/serverClient.js';
import { fetchModelCatalog } from '../llm/modelCatalog.js';
import { initModelLibrary } from '../ui/modelLibrary.js';
import { listDocumentStyles, deleteDocumentStyle, vectorStatus } from '../agent/memory.js';
import { $, toast, storage } from './env.js';
import { readinessReport, normalizeReadiness, readinessItem } from '../../shared/capabilityReadiness.js';
import { abortableFetch } from '../core/abortableFetch.js';

export function createModelWorkspace(app) {
  let scope = app.server ? 'server' : 'local';
  const localOptions = createModelLocalOptions();
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
      globalThis.__jarvisServerAuto = hasRouting(cfg);
      globalThis.__jarvisServerPinned = Boolean(cfg.pinModel);
      globalThis.__jarvisServerProvider = cfg.providerNames?.[cfg.provider] || cfg.provider;
      app.updateModelLabels();
    }
  });
  const workspace = {
    openLocalOptions: localOptions.openLocalOptions,
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
    async documentStyles(target = scope) {
      if (target === 'local') return listDocumentStyles();
      const client = getClient();
      if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
      return client.listDocumentStyles();
    },
    async deleteDocumentStyle(id, target = scope) {
      if (target === 'local') return deleteDocumentStyle(id);
      const client = getClient();
      if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
      return client.deleteDocumentStyle(id);
    },
    gateway: (target = scope) => (target === 'local' ? app.gateway : null),
    async readiness(target = scope, signal) {
      if (target === 'server') {
        const client = getClient();
        if (!client) throw Object.assign(new Error('请先登录云服务器'), { code: 'SERVER_NOT_CONNECTED' });
        return normalizeReadiness(await client.readiness(signal), 'server');
      }
      const config = await scopes.get('local');
      signal?.throwIfAborted();
      let runtime = { checks: ['office', 'pdf', 'fonts', 'ffmpeg', 'git', 'sandbox', 'browser', 'skills'].map((id) => readinessItem(id, 'unknown')) };
      if (app.gateway?.origin) {
        const deadline = AbortSignal.timeout(15000);
        const response = await abortableFetch(fetch, `${app.gateway.origin}/api/readiness`, {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline
        });
        if (!response.ok) throw Object.assign(new Error('本机环境自检接口不可用'), { status: response.status });
        runtime = await response.json();
        signal?.throwIfAborted();
      }
      return readinessReport({ scope: 'local', cfg: config, gatewayKeys: app.gateway?.keys || [], runtime });
    },
    /** 记忆向量的情况：多少条算好了、上次出错（服务器上的问服务器） */
    async memoryStatus(target = scope) {
      if (target === 'local') return vectorStatus();
      const client = getClient();
      if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
      return client.memoryStatus();
    },
    async probeStockImages(provider, signal) {
      const client = scope === 'server' && getClient();
      if (!client) throw new Error('请在已登录的云服务器设置中检测图库');
      return client.probeStockImages(provider, signal);
    },
    async lookupHealth(probe = false, target = scope, signal) {
      if (target === 'local') {
        const service = localLookup(app);
        const region = app.panels.config.lookupRegion || 'auto';
        return probe ? service.probe(region, { signal }) : service.status(region);
      }
      const client = getClient();
      if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
      return client.lookupHealth(probe, signal);
    },
    async selectScope(target) {
      scope = target;
      return scopes.refresh(target);
    },
    async choose(line, target = scope) {
      return scopes.patch(target, (cfg) => chooseLine(cfg, line));
    },
    async testDeepseekSearch(kind, target = scope, signal) {
      if (target === 'server') {
        const client = getClient();
        if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
        return client.testDeepseekSearch(kind, signal);
      }
      return testDeepseekSearch(app.panels.config, kind, { signal, fetchViaGateway: app.fetchViaGateway() });
    },
    async testQianfanSearch(target = scope, signal) {
      if (target === 'server') {
        const client = getClient();
        if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
        return client.testDeepseekSearch('qianfan', signal);
      }
      return testQianfanSearch(app.panels.config, { signal, fetchViaGateway: app.fetchViaGateway() });
    },
    async testOpenaiSearch(target = scope, signal) {
      if (target === 'server') {
        const client = getClient();
        if (!client) throw Object.assign(new Error('请先登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
        return client.testOpenaiSearch(signal);
      }
      return testOpenaiSearch(app.panels.config, { signal, openaiSearchFetch: createOpenaiSearchFetch(app, { storage }) });
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
