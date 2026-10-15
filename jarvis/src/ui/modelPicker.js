/**
 * 选模型：点输入框里的模型名弹出，列出服务商（如中转平台）上的全部模型，点一下就换。
 * 最上面是“自动”：每句话按任务类型（对话 / 编程 / 写作 / 深度思考 / 看图）自动挑最合适的模型。
 * 模型列表缓存一天（按服务商 + 地址），可以手动刷新。服务商地址和密钥只在第一次设置时需要。
 */
import { TASKS, suggestRoutes, keyedProviders, routeRef, parseRoute, routeLabel } from '../llm/router.js';
import { listModels, modelOf, providerById } from '../llm/config.js';
import { modelKind, imageModelOf } from '../llm/images.js';
import { videoModelOf } from '../llm/videos.js';

const DAY = 864e5;
const SHORT = { chat: '对话', code: '编程', write: '写作', reason: '思考', vision: '看图' };
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/** 缓存用的键：同一个服务商换了地址也要重新拉 */
export const listKey = (cfg) => `${cfg.provider}|${providerById(cfg.provider)?.custom ? cfg.baseURLs?.custom || '' : ''}`;

/** 当前是不是“自动”模式 */
export const isAuto = (cfg) => Boolean(cfg.routing?.enabled && (cfg.routing.provider === cfg.provider || cfg.routing.multi));

/**
 * 所有填了密钥的服务商的模型（当前服务商在前，只写模型名；其他写成“服务商::模型”）。
 * 列表缓存一天；读不到的服务商用它的默认型号，并记下原因。
 */
export async function gatherModelRefs(cfg, { gateway = null, patchConfig = null, force = false, list = listModels } = {}) {
  const refs = [];
  const notes = [];
  const lists = {};
  for (const id of keyedProviders(cfg)) {
    const pcfg = { ...cfg, provider: id };
    const key = listKey(pcfg);
    const cached = cfg.modelLists?.[key];
    let ids = !force && cached?.ids?.length && Date.now() - cached.at < DAY ? cached.ids : null;
    if (!ids) {
      try {
        ids = [...new Set(await list(pcfg, { gateway }))];
        lists[key] = { ids, at: Date.now() };
      } catch (e) {
        ids = providerById(id)?.models?.filter(Boolean) ?? [];
        notes.push(`${providerById(id)?.name ?? id}：${e.message}`);
      }
    }
    const chat = ids.filter((m) => modelKind(m) === 'chat');
    notes.unshift(`${providerById(id)?.name ?? id} ${chat.length} 个`);
    refs.push(...chat.map((m) => (id === cfg.provider ? m : routeRef(id, m))));
  }
  if (patchConfig && Object.keys(lists).length) patchConfig((c) => ({ ...c, modelLists: { ...(c.modelLists || {}), ...lists } }));
  return { refs, notes };
}

/** 输入框里显示的名字 */
export function chipLabel(cfg) {
  if (providerById(cfg.provider)?.kind === 'mock') return '内置演示';
  return isAuto(cfg) ? '自动 · 按任务选模型' : modelOf(cfg) || '选择模型';
}

/** 切到“自动”：按模型名推荐每类任务的模型；默认模型保持不变（没被分配到的任务用它） */
export function autoRouting(cfg, ids) {
  const routes = suggestRoutes(ids, modelOf(cfg));
  const multi = Object.values(routes).some((v) => parseRoute(v).provider);
  return { ...cfg, routing: { ...(cfg.routing || {}), enabled: true, provider: cfg.provider, multi, routes } };
}

/** 选定某个模型：聊天模型作为默认模型并关闭自动分配；画图 / 视频模型只设为“画图用 / 视频用” */
export function pickModel(cfg, id) {
  if (modelKind(id) === 'image') return { ...cfg, imageModel: id };
  if (modelKind(id) === 'video') return { ...cfg, videoModel: id };
  return { ...cfg, models: { ...cfg.models, [cfg.provider]: id }, routing: { ...(cfg.routing || {}), enabled: false } };
}

/** 修正：聊天模型被设成了画图 / 语音 / 向量模型（它们不能对话）——挪到对应用途，聊天换回一个能对话的模型 */
export function repairChatModel(cfg) {
  const cur = modelOf(cfg);
  if (!cur || modelKind(cur) === 'chat' || providerById(cfg.provider)?.kind === 'mock') return null;
  const ids = Object.values(cfg.modelLists || {}).flatMap((l) => l.ids || []).filter((id) => modelKind(id) === 'chat');
  const routes = cfg.routing?.routes || {};
  const next = [routes.reason, routes.chat, ...Object.values(routes)].find((m) => m && modelKind(m) === 'chat') || suggestRoutes(ids, '').reason || ids[0] || '';
  return {
    ...cfg,
    ...(modelKind(cur) === 'image' && { imageModel: cur }),
    ...(modelKind(cur) === 'video' && { videoModel: cur }),
    models: { ...cfg.models, [cfg.provider]: next }
  };
}

/**
 * @param {{ getConfig: () => object, patchConfig: (fn: Function) => object, getGateway: () => object|null, toast: Function, openSettings: () => void }} d
 */
export function initModelPicker({ getConfig, patchConfig, getGateway, toast, openSettings }) {
  const scrim = el('div', { className: 'mp-scrim', hidden: true });
  const list = el('div', { className: 'mp-list' });
  const search = el('input', { type: 'search', className: 'mp-search', placeholder: '搜索模型…', spellcheck: false });
  const status = el('p', { className: 'mp-status' });
  const refreshBtn = el('button', { type: 'button', className: 'btn ghost sm', textContent: '刷新列表' });
  const closeBtn = el('button', { type: 'button', className: 'x-btn', textContent: '✕', title: '关闭' });
  const setBtn = el('button', { type: 'button', className: 'mp-settings', textContent: '服务商地址与密钥 ›' });
  const sheet = el('div', { className: 'mp-sheet', role: 'dialog', ariaLabel: '选择模型', hidden: true },
    el('div', { className: 'mp-head' }, el('strong', { textContent: '选择模型' }), refreshBtn, closeBtn),
    search, status, list, setBtn);
  document.body.append(scrim, sheet);
  let ids = [];

  async function load(force = false) {
    const cfg = getConfig();
    if (providerById(cfg.provider)?.kind === 'mock') { ids = []; render(); return; }
    const key = listKey(cfg);
    const cached = cfg.modelLists?.[key];
    if (!force && cached?.ids?.length && Date.now() - cached.at < DAY) { ids = cached.ids; render(); return; }
    status.textContent = '正在读取服务商的模型列表…';
    ids = cached?.ids || [];
    render();
    try {
      const got = await listModels(cfg, { gateway: getGateway() });
      ids = [...new Set(got)].sort((a, b) => a.localeCompare(b));
      patchConfig((c) => ({ ...c, modelLists: { ...(c.modelLists || {}), [key]: { ids, at: Date.now() } } }));
      status.textContent = '';
    } catch (e) {
      status.textContent = `读取失败：${e.message}`;
    }
    render();
  }

  function render() {
    const cfg = getConfig();
    const p = providerById(cfg.provider);
    if (p?.kind === 'mock') {
      status.textContent = '现在用的是内置演示。先填一次服务商的接口地址和密钥，之后就能在这里直接选模型。';
      list.replaceChildren();
      return;
    }
    const q = search.value.trim().toLowerCase();
    const auto = isAuto(cfg);
    const cur = modelOf(cfg);
    const routes = auto ? cfg.routing.routes || {} : suggestRoutes(ids, cur);
    const tagsOf = (id) => Object.entries(routes).filter(([, m]) => m === id).map(([t]) => SHORT[t]);
    const autoRow = el('button', { type: 'button', className: `mp-item mp-auto${auto ? ' on' : ''}` },
      el('span', { className: 'mp-name' }, '自动 · 按任务选最合适的模型'),
      el('small', { textContent: Object.keys(TASKS).map((t) => `${SHORT[t]} ${routeLabel(routes[t] || cur, cfg.provider)}`).join(' · ') }));
    autoRow.addEventListener('click', async () => {
      if (!ids.length) { status.textContent = '还没读到模型列表：点“刷新列表”'; return; }
      // 填过密钥的服务商都参与：每类任务从所有服务商的模型里挑
      let pool = ids;
      if (keyedProviders(cfg).length > 1) {
        status.textContent = '正在读取各服务商的模型列表…';
        pool = (await gatherModelRefs(getConfig(), { gateway: getGateway(), patchConfig })).refs;
      }
      const next = patchConfig((c) => autoRouting(c, pool));
      toast(`已开启自动选模型：${Object.entries(next.routing.routes).map(([t, m]) => `${SHORT[t]}用 ${routeLabel(m, next.provider)}`).join('，')}`);
      close();
    });
    const match = (id) => !q || id.toLowerCase().includes(q);
    const shown = ids.filter((id) => modelKind(id) === 'chat' && match(id));
    // 画图 / 视频模型：各选一个，说“画一张… / 生成一段视频…”时自动用，不影响聊天模型
    const section = (kind, title, tag, cur) => {
      const found = ids.filter((id) => modelKind(id) === kind && match(id));
      return found.length ? [
        el('div', { className: 'mp-section', textContent: title }),
        ...found.map((id) => {
          const b = el('button', { type: 'button', className: `mp-item${id === cur ? ' on' : ''}` }, el('span', { className: 'mp-name', textContent: id }), el('span', { className: 'mp-tags', textContent: tag }));
          b.addEventListener('click', () => { patchConfig((c) => pickModel(c, id)); toast(`${tag}将使用 ${id}（聊天模型不变）`); close(); });
          return b;
        })
      ] : [];
    };
    const imageRows = section('image', '画图模型（说“画一张…”时用，不用来聊天）', '画图', imageModelOf(cfg));
    const videoRows = section('video', '视频模型（说“生成一段视频…”时用，不用来聊天）', '视频', videoModelOf(cfg));
    list.replaceChildren(autoRow, el('div', { className: 'mp-section', textContent: '聊天模型' }), ...shown.map((id) => {
      const tags = tagsOf(id);
      const b = el('button', { type: 'button', className: `mp-item${!auto && id === cur ? ' on' : ''}` },
        el('span', { className: 'mp-name', textContent: id }),
        tags.length ? el('span', { className: 'mp-tags', textContent: `擅长${tags.join('、')}` }) : null);
      b.addEventListener('click', () => {
        patchConfig((c) => pickModel(c, id));
        toast(`已切换到 ${id}（关闭了自动选模型）`);
        close();
      });
      return b;
    }), ...imageRows, ...videoRows);
    if (!shown.length && !imageRows.length && !videoRows.length && ids.length) list.append(el('p', { className: 'mp-status', textContent: '没有匹配的模型' }));
    search.hidden = ids.length < 10;
  }

  function open() {
    sheet.hidden = false;
    scrim.hidden = false;
    document.body.classList.add('mp-open');
    search.value = '';
    load();
  }
  function close() {
    sheet.hidden = true;
    scrim.hidden = true;
    document.body.classList.remove('mp-open');
  }
  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  refreshBtn.addEventListener('click', () => load(true));
  search.addEventListener('input', render);
  setBtn.addEventListener('click', () => { close(); openSettings(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });

  return { open, close, get isOpen() { return !sheet.hidden; } };
}
