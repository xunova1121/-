/**
 * 对话列表：电脑上的“对话”面板，手机上的左侧抽屉（新对话 · 功能 · 历史对话；面板全屏打开，左上角“返回对话”）。
 */
import { initSessionsPanel as createSessionsPanel } from '../ui/sessionsPanel.js';
import { initDrawer as createDrawer } from '../ui/drawer.js';
import * as sessionsApi from '../agent/sessions.js';
import { $, COMPACT, toast } from './env.js';

export function createSessionLists(app) {
  /** “对话”面板（启动时创建） */
  function initSessionsPanel() {
    app.sessionsPanel = createSessionsPanel({
      getCurrentId: () => app.session.id,
      onOpen: (id) => app.openSession(id),
      onNew: () => app.newSession(),
      onDeleted: (id) => {
        if (id === app.session.id) app.switchTo(sessionsApi.create());
      },
      settings: app.settings,
      onSaveChange: (on) => {
        app.setSetting('saveSessions', on);
        if (on) app.persistSession();
        toast(on ? '对话会保存在本机，可在“对话”里找回' : '新的对话不再保存（已保存的不受影响）');
      }
    });
  }

  /** 手机：左侧抽屉菜单（启动时创建；电脑上不建） */
  function initDrawer() {
    if (!COMPACT) return;
    const icons = Object.fromEntries([...document.querySelectorAll('.rail-btn')].map((b) => [b.dataset.panel, b.querySelector('svg').outerHTML]));
    app.drawer = createDrawer({
      icons,
      onNew: () => {
        app.newSession();
        app.closeSide();
      },
      onOpenSession: (id) => {
        app.openSession(id);
        app.closeSide();
      },
      onPanel: (name) => app.showPanel(name),
      listSessions: () => sessionsApi.list(),
      cachedSessions: () => sessionsApi.cachedList(),
      currentId: () => app.session.id,
      onRename: async (id, title) => {
        await sessionsApi.rename(id, title);
        if (id === app.session.id) {
          app.session.title = title;
          app.session.titleSet = true;
          app.showChatTitle();
        }
        app.sessionsPanel?.refresh();
      },
      onPin: async (id, pinned) => {
        await sessionsApi.setPinned(id, pinned);
        if (id === app.session.id) app.session.pinned = pinned;
        app.sessionsPanel?.refresh();
      },
      onExport: (id, kind) => app.exportSession(id, kind),
      searchContent: (q) => sessionsApi.searchContent(q),
      onDelete: async (id) => {
        await sessionsApi.remove(id);
        if (id === app.session.id) app.switchTo(sessionsApi.create());
        app.sessionsPanel?.refresh();
        toast('已删除');
      }
    });
    $('#btn-menu').hidden = false;
    $('#btn-menu').addEventListener('click', () => app.drawer.open());
    $('#btn-side-back').hidden = false;
    $('#btn-side-back').addEventListener('click', () => app.closeSide());
  }

  return { initSessionsPanel, initDrawer };
}
