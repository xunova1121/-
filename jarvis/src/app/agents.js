/**
 * 智能体广场接入（第2步）：打开广场、选智能体开新对话、空对话显示起始页、顶栏显示智能体名字、抽屉入口和历史图标。
 * 配置只从注册表读（本机或服务器上本人的），选了智能体只是记在对话上；真正执行时主循环 / 服务器再按编号解析（见 agentTurn.js）。
 */
import * as registry from '../agent/agentProfiles.js';
import * as sessionsApi from '../agent/sessions.js';
import { createAgentSquare, agentStartView, iconBadge } from '../ui/agentSquare.js';
import { createTemplateLibrary } from '../ui/pptTemplateLibrary.js';
import { pptTemplate, templateArtPath } from '../agent/pptTemplates.js';
import { artSvg } from '../agent/pptTemplateArt.js';
import { themeById } from '../agent/themes.js';
import * as ws from '../agent/workspace.js';
import { $, toast } from './env.js';
import { importPptSource } from './pptSourceImport.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { createAgentProfileEditor } from '../ui/agentProfileEditor.js';
import { createAgentProfileActions } from './agentProfileActions.js';

/** 抽屉“发现智能体”卡片上的三个常用入口 */
export const DRAWER_PICKS = ['ppt-maker', 'gongwen-writer', 'health-advisor'];

export function createAgents(app) {
  const cache = new Map(registry.BUILTIN_AGENTS.map((p) => [p.id, p]));
  let cacheVersion = 0;
  const listAgents = async () => {
    const version = cacheVersion;
    const token = userStorageSuffix();
    const server = app.server;
    const list = await registry.listAgents();
    if (version !== cacheVersion || token !== userStorageSuffix() || server !== app.server) throw new Error('账号已切换，请重新打开广场。');
    for (const [id, p] of cache) if (p.source !== 'builtin') cache.delete(id);
    for (const p of list) cache.set(p.id, p);
    return list;
  };
  const profileOf = async (id) => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    const version = cacheVersion;
    const p = await registry.getAgent(id).catch(() => null);
    if (version !== cacheVersion) return null;
    if (p) cache.set(id, p);
    return p;
  };

  const actions = createAgentProfileActions(app);
  const square = createAgentSquare({
    listAgents,
    onPick: (p) => start(p),
    onEdit: (profile, after) => editor.open(profile, actions.capture(), after)
  });
  const editor = createAgentProfileEditor({
    onSave: async (profile, fields, token) => {
      const saved = await actions.save(profile, fields, token);
      cache.set(saved.id, saved);
    },
    onRemove: async (profile, token) => {
      await actions.remove(profile, token);
      cache.delete(profile.id);
    }
  });
  // 模板库：选了模板记在当前智能体对话上，重画起始页（保留其他选项）
  const library = createTemplateLibrary({
    onImport: async (template, url) => {
      await importPptSource({ app, workspace: ws, template, url, scope: userStorageSuffix, fill, readDraft: () => $('#prompt')?.value || '' });
      renderStart();
      library.close();
      toast('样板已导入。补充修改要求后发送。');
    },
    onPick: (id) => {
      if (!app.session?.agentId || app.history.length) return;
      app.session.agentForm = { ...(app.session.agentForm || {}), template: id };
      renderStart();
    }
  });

  /**
   * 发消息前：选了模板就把模板配图放进工作区（服务器模式同时传到服务器），模型才能在 PPT 里引用。
   * 失败不挡发送：配图缺了，生成时会在缺图清单里如实列出。
   */
  /** 模板配图：原创 SVG 插画在设备上画成 1200×675 的 PNG */
  async function drawArt(tpl, motif) {
    const theme = themeById(tpl.theme);
    const url = URL.createObjectURL(new Blob([artSvg(motif, theme.colors)], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: 1200, height: 675 });
      canvas.getContext('2d').drawImage(img, 0, 0, 1200, 675);
      return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画配图失败'))), 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function prepareTurn() {
    const tpl = pptTemplate(app.session?.agentForm?.template);
    if (!app.session?.agentId || !tpl) return [];
    const done = [];
    for (const [name, motif] of tpl.art) {
      const path = templateArtPath(tpl.id, name);
      try {
        const have = await ws.exists(path);
        const blob = have ? await ws.readBlob(path) : await drawArt(tpl, motif);
        if (!have) await ws.write(path, blob);
        if (app.server) await app.server.upload(path, blob);
        done.push({ path, ok: true, size: blob.size });
      } catch (e) {
        console.warn('[模板配图]', path, e?.message || e);
        done.push({ path, ok: false });
      }
    }
    return done;
  }

  /** 选了智能体：开一段新对话记住它（空对话不落盘，发第一句时才存） */
  async function start(profile) {
    const form = Object.fromEntries((profile.form || []).filter((f) => f.default).map((f) => [f.key, f.default]));
    await app.switchTo(sessionsApi.create({ agentId: profile.id, ...(Object.keys(form).length && { agentForm: form }) }));
    $('#prompt')?.focus();
  }

  function fill(text) {
    const prompt = $('#prompt');
    if (!prompt) return;
    prompt.value = text;
    app.autosize?.();
    prompt.focus();
    // 光标放到最后，方便接着改
    prompt.setSelectionRange?.(text.length, text.length);
  }

  /** 空的智能体对话：在对话区画起始页。返回 true 表示画了（调用方就不再画普通欢迎页） */
  function renderStart() {
    const id = app.session?.agentId;
    if (!id || app.history.length) return false;
    const root = $('#transcript');
    const session = app.session;
    const draw = (profile) => {
      if (app.session !== session || app.history.length) return;
      root.querySelector('.wy-agent-start')?.remove();
      if (!profile) {
        root.append(
          Object.assign(document.createElement('p'), { className: 'wy-agent-missing', textContent: '这个智能体不存在或已被删除，请回到广场重新选择。' })
        );
        return;
      }
      root.prepend(
        agentStartView(profile, {
          values: session.agentForm || {},
          onFill: fill,
          onForm: (values) => {
            session.agentForm = Object.keys(values).length ? values : undefined;
          },
          onUpload: () => $('#file-input')?.click(),
          onBack: () => square.open(),
          onTemplates: () => library.open()
        })
      );
      root.scrollTop = 0;
      decorateTitle();
    };
    const hit = cache.get(id);
    if (hit) draw(hit);
    else profileOf(id).then(draw);
    return true;
  }

  /** 顶栏：智能体对话在标题前显示图标和名字；空对话没有标题时只显示名字 */
  function decorateTitle() {
    const title = $('#chat-title');
    if (!title) return;
    const id = app.session?.agentId;
    title.querySelector('.wy-chat-agent')?.remove();
    if (!id) return;
    const profile = cache.get(id);
    if (!profile) {
      profileOf(id).then((p) => p && app.session?.agentId === id && decorateTitle());
      return;
    }
    // 还没开始聊：标题就是智能体名字；聊起来以后标题前加智能体图标
    if (!app.history.length) title.textContent = profile.name;
    const badge = Object.assign(document.createElement('span'), { className: 'wy-chat-agent', title: `当前智能体：${profile.name}` });
    badge.append(iconBadge(profile, 'xs'));
    title.prepend(badge);
    title.hidden = false;
  }

  /** 抽屉历史里每行的图标：智能体对话用智能体图标，没有就不加（沿用原样式） */
  function rowIcon(session) {
    const p = session?.agentId && cache.get(session.agentId);
    return p ? iconBadge(p, 'xs') : null;
  }

  function openSquare() {
    app.drawer?.close?.();
    square.open();
  }
  addEventListener('jarvis:open-agents', openSquare);
  document.getElementById('btn-agents')?.addEventListener('click', openSquare);

  // 服务器模式切换后，个人智能体从服务器读：清掉本机缓存里的非内置项
  function resetCache() {
    cacheVersion++;
    for (const [id, p] of cache) if (p.source !== 'builtin') cache.delete(id);
    editor.close();
    square.reset();
    library.close();
  }

  return {
    agents: {
      square,
      library,
      prepareTurn,
      openSquare,
      start,
      renderStart,
      decorateTitle,
      rowIcon,
      resetCache,
      profileOf,
      icon: (p) => iconBadge(p, 'sm'),
      drawerPicks: () => DRAWER_PICKS.map((id) => cache.get(id)).filter(Boolean),
      notFound: () => toast('这个智能体不存在或已被删除')
    }
  };
}
