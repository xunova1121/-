/**
 * 智能体广场接入（第2步）：打开广场、选智能体开新对话、空对话显示起始页、顶栏显示智能体名字、抽屉入口和历史图标。
 * 配置只从注册表读（本机或服务器上本人的），选了智能体只是记在对话上；真正执行时主循环 / 服务器再按编号解析（见 agentTurn.js）。
 */
import * as registry from '../agent/agentProfiles.js';
import * as sessionsApi from '../agent/sessions.js';
import { createAgentSquare, agentStartView, iconBadge } from '../ui/agentSquare.js';
import { $, toast } from './env.js';

/** 抽屉“发现智能体”卡片上的三个常用入口 */
export const DRAWER_PICKS = ['ppt-maker', 'gongwen-writer', 'health-advisor'];

export function createAgents(app) {
  const cache = new Map(registry.BUILTIN_AGENTS.map((p) => [p.id, p]));
  const listAgents = async () => {
    const list = await registry.listAgents();
    for (const p of list) cache.set(p.id, p);
    return list;
  };
  const profileOf = async (id) => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    const p = await registry.getAgent(id).catch(() => null);
    if (p) cache.set(id, p);
    return p;
  };

  const square = createAgentSquare({ listAgents, onPick: (p) => start(p) });

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
          onUpload: () => $('#btn-attach')?.click(),
          onBack: () => square.open()
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
    for (const [id, p] of cache) if (p.source !== 'builtin') cache.delete(id);
  }

  return {
    agents: {
      square,
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
