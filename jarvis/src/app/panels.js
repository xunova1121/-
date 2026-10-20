/**
 * 右侧（手机上是整页）面板：切换面板，以及各面板的创建——工作区 / 知识库 / 记忆、声音、模型分工、模型选择、
 * 本地模型、MCP 连接、技能。
 */
import { modelOf } from '../llm/config.js';
import { initPanels } from '../ui/panels.js';
import { initVoicePanel } from '../ui/voicePanel.js';
import { initRoutingPanel } from '../ui/routingPanel.js';
import { initModelPicker, repairChatModel } from '../ui/modelPicker.js';
import { initLocalModelsPanel } from '../ui/localModelsPanel.js';
import { initMcpPanel } from '../ui/mcpPanel.js';
import { initSkillsPanel } from '../ui/skillsPanel.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { $, body, narrow, toast } from './env.js';

export const PANES = ['sessions', 'workspace', 'knowledge', 'mind', 'skills', 'models', 'system', 'settings'];

export function createPanels(app) {
  let currentPane = null;
  function showPanel(name, { toggle = false } = {}) {
    noteAction(`打开面板：${name}`);
    if (toggle && name === currentPane && (narrow.matches ? body.classList.contains('side-open') : !body.classList.contains('side-closed'))) {
      body.classList.add('side-closed');
      body.classList.remove('side-open');
      currentPane = null;
      return;
    }
    currentPane = name;
    body.classList.remove('wb-connections');
    body.classList.remove('side-closed');
    body.classList.add('side-open');
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
    for (const b of document.querySelectorAll('.rail-btn')) b.classList.toggle('active', b.dataset.panel === name);
    try {
      localStorage.setItem('jarvis.pane', name);
    } catch {
      /* ignore */
    }
    if (name === 'workspace') panels.refreshFiles();
    if (name === 'knowledge') panels.refreshKb();
    if (name === 'mind') panels.refreshMind();
    if (name === 'models') {
      panels.refreshModels();
      voicePanel.render();
      localModels.refresh();
      routingPanel.render();
    }
    if (name === 'skills') {
      skillsPanel.refresh();
      mcpPanel.refresh();
    }
    if (name === 'sessions') app.sessionsPanel?.refresh();
    if (name === 'system') app.schedulesPanel?.refresh();
    if (name === 'settings') app.renderHabits();
    dispatchEvent(new CustomEvent('jarvis:panel', { detail: name })); // 面板打开时各自刷新（如服务器模式的网络耗时）
  }
  for (const b of document.querySelectorAll('.rail-btn')) b.addEventListener('click', () => showPanel(b.dataset.panel, { toggle: true }));
  for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => showPanel(b.dataset.open));

  /** 模型分工面板（下面创建；配置变化时刷新） */
  let routingPanel = null;
  const panels = initPanels({
    toast: (t) => toast(t),
    settings: app.settings,
    getGateway: () => app.gateway,
    searchFetch: () => app.fetchViaGateway(),
    getHistory: () => app.history,
    onConfigChange: (cfg) => {
      app.llmConfig = cfg;
      app.updateModelLabels();
      app.syncMemoryEngine();
      app.updateOrbitStatus();
      routingPanel?.render();
    },
    onReflect: () => app.reflectNow({ manual: true }),
    onAutoMemory: (on) => {
      app.setSetting('autoMemory', on);
      if (!on) clearTimeout(app.reflectTimer);
    }
  });
  const voicePanel = initVoicePanel({ panels, speaker: app.speaker, getGateway: () => app.gateway });
  routingPanel = initRoutingPanel({
    getConfig: () => panels.config,
    patchConfig: (fn) => panels.patchConfig(fn),
    getGateway: () => app.gateway,
    toast: (t) => toast(t)
  });
  const modelPicker = initModelPicker({
    getWorkspace: () => app.modelWorkspace,
    getConfig: () => panels.config,
    patchConfig: (fn) => panels.patchConfig(fn),
    getGateway: () => app.gateway,
    toast: (t) => toast(t),
    openSettings: () => showPanel('models')
  });
  $('#model-chip').addEventListener('click', () => modelPicker.open());
  // 聊天模型误选成了画图模型（如 gpt-image-2）：自动挪到“画图用”，聊天换回能对话的模型
  {
    const was = modelOf(panels.config);
    const fixed = repairChatModel(panels.config);
    if (fixed) {
      panels.patchConfig(() => fixed);
      toast(
        `“${was}”不能用来聊天${fixed.imageModel === was ? '，已改为画图用' : fixed.videoModel === was ? '，已改为视频用' : ''}；聊天用 ${fixed.models[fixed.provider] || '默认模型'}`
      );
    }
  }
  const localModels = initLocalModelsPanel({
    getGateway: () => app.gateway,
    getConfig: () => panels.config,
    useModel: (p, m) => panels.useModel(p, m),
    patchConfig: (fn) => panels.patchConfig(fn),
    toast: (t) => toast(t)
  });
  const mcpPanel = initMcpPanel({
    getGateway: () => app.gateway,
    toast: (t) => toast(t),
    onChange: (servers) => {
      const ready = servers.filter((x) => x.status === 'ready');
      $('#hud-mcp').textContent = ready.length ? `${ready.length} 个 · ${ready.reduce((n, x) => n + x.tools.length, 0)} 工具` : '未连接';
    }
  });
  const skillsPanel = initSkillsPanel({
    toast: (t) => toast(t),
    onUse: (name) => {
      $('#prompt').value = `/${name} `;
      if (body.classList.contains('workbench')) body.classList.add('side-closed');
      if (narrow.matches) body.classList.remove('side-open');
      $('#prompt').focus();
    },
    onChange: (list) => {
      panels.refreshMind();
      $('#hud-skills').textContent = `${list.filter((p) => p.enabled).length} 个启用`;
    }
  });
  /** 手机：关掉整页面板，回到对话 */
  function closeSide() {
    body.classList.remove('side-open');
    currentPane = null;
  }

  return { showPanel, closeSide, panels, voicePanel, routingPanel, modelPicker, localModels, mcpPanel, skillsPanel };
}

