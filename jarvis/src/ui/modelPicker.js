/**
 * 选模型：点输入框里的模型名弹出，列出服务商（如中转平台）上的全部模型，点一下就换。
 * 最上面是“自动”：每句话按任务类型（对话 / 编程 / 写作 / 深度思考 / 看图）自动挑最合适的模型。
 * 模型列表缓存一天（按服务商 + 地址），可以手动刷新。服务商地址和密钥只在第一次设置时需要。
 */
import { TASKS, suggestRoutes } from '../llm/router.js';
import { listModels, modelOf, providerById } from '../llm/config.js';

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
export const isAuto = (cfg) => Boolean(cfg.routing?.enabled && cfg.routing.provider === cfg.provider);

/** 输入框里显示的名字 */
export function chipLabel(cfg) {
  if (providerById(cfg.provider)?.kind === 'mock') return '内置演示';
  return isAuto(cfg) ? '自动 · 按任务选模型' : modelOf(cfg) || '选择模型';
}

/** 切到“自动”：按模型名推荐每类任务的模型；默认模型保持不变（没被分配到的任务用它） */
export function autoRouting(cfg, ids) {
  const routes = suggestRoutes(ids, modelOf(cfg));
  return { ...cfg, routing: { ...(cfg.routing || {}), enabled: true, provider: cfg.provider, routes } };
}

/** 选定某个模型：作为默认模型，并关闭自动分配 */
export function pickModel(cfg, id) {
  return { ...cfg, models: { ...cfg.models, [cfg.provider]: id }, routing: { ...(cfg.routing || {}), enabled: false } };
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
      el('small', { textContent: Object.keys(TASKS).map((t) => `${SHORT[t]} ${routes[t] || cur}`).join(' · ') }));
    autoRow.addEventListener('click', () => {
      if (!ids.length) { status.textContent = '还没读到模型列表：点“刷新列表”'; return; }
      const next = patchConfig((c) => autoRouting(c, ids));
      toast(`已开启自动选模型：${Object.entries(next.routing.routes).map(([t, m]) => `${SHORT[t]}用 ${m}`).join('，')}`);
      close();
    });
    const shown = ids.filter((id) => !q || id.toLowerCase().includes(q));
    list.replaceChildren(autoRow, ...shown.map((id) => {
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
    }));
    if (!shown.length && ids.length) list.append(el('p', { className: 'mp-status', textContent: '没有匹配的模型' }));
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
