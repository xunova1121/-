/**
 * “模型”面板里的模型分工：给日常对话 / 编程 / 写作 / 深度思考 / 看图分别指定模型，
 * 一键读取服务商的模型列表并按名字推荐，测速看每个模型的首字快慢。
 */
import { TASKS, suggestRoutes, routeFor } from '../llm/router.js';
import { listModels, createAdapter, modelOf, providerById } from '../llm/config.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/** 测一个模型的首字时间（毫秒） */
export async function measureFirstToken(adapter, model, { timeoutMs = 45000, now = () => performance.now() } = {}) {
  const t0 = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let first = 0;
  try {
    await adapter.stream({
      model, effort: 'low', tools: [], signal: ctrl.signal,
      system: ['只回复一个字：好', ''], messages: [{ role: 'user', content: '测速' }],
      onText: () => { if (!first) { first = now(); ctrl.abort(); } }
    });
  } catch (e) {
    if (!first) throw e.name === 'AbortError' ? new Error('超时') : e;
  } finally { clearTimeout(timer); }
  return Math.round((first || now()) - t0);
}

export function initRoutingPanel({ getConfig, patchConfig, getGateway, toast }) {
  const grid = $('#route-grid');
  const inputs = {};
  const speeds = {};
  for (const [id, t] of Object.entries(TASKS)) {
    inputs[id] = el('input', { id: `route-${id}`, spellcheck: false, placeholder: '沿用默认型号' });
    inputs[id].setAttribute('list', 'route-models');
    speeds[id] = el('span', { className: 'route-speed' });
    grid.append(el('label', { className: 'route-row', htmlFor: `route-${id}` },
      el('span', { className: 'route-name' }, el('b', { textContent: t.name }), el('small', { textContent: t.hint })),
      inputs[id], speeds[id]));
  }
  const status = $('#route-status');

  function render() {
    const cfg = getConfig();
    const r = cfg.routing ?? {};
    const same = r.provider === cfg.provider;
    $('#route-on').checked = Boolean(r.enabled && same);
    for (const id of Object.keys(TASKS)) inputs[id].value = same ? r.routes?.[id] ?? '' : '';
    $('#fast-chat').checked = cfg.fastChat !== false;
    const p = providerById(cfg.provider);
    $('#route-section').hidden = p.kind === 'mock';
    status.textContent = r.enabled && !same ? '服务商换了：模型分工需要重新设置' : '';
  }

  function collect(enabled = $('#route-on').checked) {
    const cfg = getConfig();
    const routes = Object.fromEntries(Object.keys(TASKS).map((id) => [id, inputs[id].value.trim()]));
    return { enabled, provider: cfg.provider, routes };
  }
  const save = (quiet) => {
    patchConfig((c) => ({ ...c, routing: collect(), fastChat: $('#fast-chat').checked }));
    if (!quiet) toast($('#route-on').checked ? '模型分工已开启：每句话会按内容自动选模型' : '已保存（模型分工未开启）');
  };

  $('#route-on').addEventListener('change', () => save());
  $('#fast-chat').addEventListener('change', () => save(true));
  for (const i of Object.values(inputs)) i.addEventListener('change', () => save(true));

  $('#btn-route-suggest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    status.textContent = '正在读取服务商的模型列表…';
    try {
      const cfg = getConfig();
      const ids = await listModels(cfg, { gateway: getGateway() });
      $('#route-models').replaceChildren(...ids.map((m) => el('option', { value: m })));
      const s = suggestRoutes(ids, modelOf(cfg));
      for (const id of Object.keys(TASKS)) inputs[id].value = s[id] === modelOf(cfg) ? '' : s[id];
      $('#route-on').checked = true;
      save(true);
      status.textContent = `读到 ${ids.length} 个模型，已按名字推荐（推荐只是参考：可以点“测速”看快慢，再按需要改）`;
    } catch (err) { status.textContent = `读取失败：${err.message}`; }
    btn.disabled = false;
  });

  $('#btn-route-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const cfg = { ...getConfig(), routing: collect(true) };
    const done = new Map(); // 同一个模型只测一次
    for (const id of Object.keys(TASKS)) {
      const r = routeFor(cfg, id);
      speeds[id].textContent = '测速中…';
      speeds[id].className = 'route-speed';
      try {
        if (!done.has(r.model)) {
          const a = createAdapter(r.cfg, { gateway: getGateway() });
          if (a.problem) throw new Error(a.problem);
          done.set(r.model, await measureFirstToken(a.adapter, a.model));
        }
        const ms = done.get(r.model);
        speeds[id].textContent = `${r.model} · 首字 ${(ms / 1000).toFixed(1)}s`;
        speeds[id].classList.add(ms < 2000 ? 'fast' : ms < 6000 ? 'mid' : 'slow');
      } catch (err) {
        done.set(r.model, null);
        speeds[id].textContent = `${r.model}：${String(err.message).slice(0, 60)}`;
        speeds[id].classList.add('slow');
      }
    }
    btn.disabled = false;
  });

  render();
  return { render };
}
