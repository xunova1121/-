import { NOTICE_LABELS } from '../agent/businessSources.js';
import './tenderCenter.css';

const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children.filter(Boolean)); return node; };
const date = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未成功';
const button = (label, fn, cls = '') => { const node = el('button', { type: 'button', textContent: label, className: cls }); node.addEventListener('click', fn); return node; };
const link = (url, label) => {
  // 目录来自服务端，仍不把非网页协议交给浏览器。
  if (!/^https?:\/\//i.test(url || '')) return null;
  return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: label });
};

/** 信息流与对话草稿分开；渲染使用textContent，公开公告不能注入HTML。 */
export function createTenderCenterView({ call, onFill, valid = () => true }) {
  let tab = 'catalog', page = 1, epoch = 0, disposed = false, timer, editId = null;
  const root = el('section', { className: 'wy-tender-center', ariaLabel: '招投标信息中心' });
  const heading = el('div', { className: 'wy-tender-heading' }, el('div', {}, el('h2', { textContent: '项目机会' }), el('p', { textContent: '服务器自动更新 · 无需反复提问' })));
  const message = el('p', { className: 'wy-tender-message', role: 'status' });
  const tabs = el('div', { className: 'wy-tender-tabs', role: 'tablist', ariaLabel: '公告视图' });
  const body = el('div', { className: 'wy-tender-body' });
  const info = el('details', { className: 'wy-tender-sources' }, el('summary', { textContent: '更新状态与覆盖范围' }));
  const statusBox = el('div'); info.append(statusBox);
  root.append(heading, tabs, message);
  if (!call) {
    root.append(el('p', { className: 'wy-tender-empty', textContent: '连接云服务器后，这里会显示自动更新的公告和你的订阅。下方仍可按需查询企业或解读文件。' }));
    return { root, destroy() {} };
  }
  const fields = {};
  function input(key, label, type = 'text') {
    const node = el('input', { type, placeholder: label, ariaLabel: label, maxLength: 120 });
    if (type === 'number') { node.min = '0'; node.step = 'any'; }
    fields[key] = node;
    return el('label', {}, el('span', { textContent: label }), node);
  }
  const form = el('form', { className: 'wy-tender-filters' });
  const category = el('select', { ariaLabel: '公告类型' }, el('option', { value: 'all', textContent: '全部公告类型' }),
    ...Object.entries(NOTICE_LABELS).map(([value, textContent]) => el('option', { value, textContent })));
  fields.notice_type = category;
  const more = el('details', { className: 'wy-tender-filter-more' }, el('summary', { textContent: '预算与发布日期' }),
    el('div', { className: 'wy-tender-filter-grid' }, input('minBudget', '最低预算（万元）', 'number'), input('maxBudget', '最高预算（万元）', 'number'), input('from', '开始日期', 'date'), input('to', '结束日期', 'date')));
  const subName = input('subscriptionName', '订阅名称（可选）');
  const save = button('保存为自动订阅', () => action(async () => {
    const selected = filters(); selected.from = ''; selected.to = '';
    await call('change', { action: 'subscribe', id: editId, name: fields.subscriptionName.value, filters: selected });
    editId = null; save.textContent = '保存为自动订阅';
    tab = 'subscriptions'; await load();
    message.textContent = '订阅已保存，后续匹配公告会进入提醒；刷新不调用模型。';
  }), 'wy-tender-primary');
  const subscribe = el('details', { className: 'wy-tender-subscribe' }, el('summary', { textContent: '订阅当前筛选条件' }), subName,
    el('small', { textContent: '关键词、地区、公告类型、预算会保存。日期只用于浏览，订阅持续接收新公告。' }), save);
  form.append(input('query', '关键词 / 行业 / 企业名称'), input('region', '项目地区（如江苏）'), category,
    el('button', { type: 'submit', textContent: '筛选公告', className: 'wy-tender-primary' }), more, subscribe);
  form.addEventListener('submit', event => { event.preventDefault(); page = 1; load(); });
  root.append(form, body, info);
  const current = () => !disposed && valid();
  function filters() {
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'subscriptionName').map(([key, field]) => [key, field.value]));
    for (const key of ['minBudget', 'maxBudget']) if (values[key] !== '') values[key] = Number(values[key]) * 10000;
    return { ...values, page, ...(tab === 'favorites' && { favorites: 'true' }) };
  }
  async function action(work) {
    if (!current()) return;
    const controls = [...root.querySelectorAll('button')]; controls.forEach(node => { node.disabled = true; });
    try { await work(); } catch (error) { if (current()) message.textContent = error.message; }
    finally { if (current()) controls.forEach(node => { node.disabled = false; }); }
  }
  function renderTabs(unread = 0) {
    tabs.replaceChildren(...[['catalog', '最新公告'], ['favorites', '我的收藏'], ['subscriptions', '自动订阅'], ['alerts', `提醒${unread ? ' · ' + unread : ''}`]].map(([key, text]) => {
      const node = button(text, () => { tab = key; page = 1; load(); });
      node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(tab === key)); return node;
    }));
    form.hidden = !['catalog', 'favorites'].includes(tab);
  }
  function notice(row) {
    const tags = el('div', { className: 'wy-tender-meta' }, el('span', { className: 'wy-tender-tag', textContent: NOTICE_LABELS[row.type] || '待核实' }),
      el('span', { textContent: `${row.region || '地区待核实'} · ${row.publishedAt}` }));
    const controls = el('div', { className: 'wy-tender-card-actions' }, link(row.url, '查看官方原文'),
      button(row.favorite ? '取消收藏' : '收藏', () => action(async () => { await call('change', { action: 'favorite', id: row.id, enabled: !row.favorite }); await load(); })),
      button('请未央解读', () => { if (current()) onFill(`请解读这份公告，核对最新更正、资格要求和截止时间：${row.title}\n${row.url}`); }));
    const detail = el('details', {}, el('summary', { textContent: '公告要点' }), el('p', { textContent: row.excerpt || '正文尚未核验，请打开官方原文。' }));
    return el('article', { className: 'wy-tender-card' }, tags, el('h3', { textContent: row.title }),
      el('p', { className: 'wy-tender-numbers', textContent: `预算：${row.budgetText || '待核实'} · 截止：${row.deadlineText || '待核实'}` }),
      el('small', { textContent: `${row.archived ? '已归档，仅保留收藏快照；请核对原文。' : ''}${row.source} · ${row.detailAt ? '正文核验 ' + date(row.detailAt) : '公开列表'}${row.detailError ? ' · 最近正文复查未成功' : ''}` }), detail, controls);
  }
  function renderSubscriptions(state) {
    if (!state.subscriptions.length) return [el('p', { className: 'wy-tender-empty', textContent: '还没有订阅。在“最新公告”设置筛选条件，保存一次即可自动跟踪。' })];
    return state.subscriptions.map(sub => el('article', { className: 'wy-tender-card' }, el('h3', { textContent: sub.name }),
      el('p', { textContent: `${sub.enabled ? '更新中' : '已暂停'} · ${sub.filters.region || '全国'} · ${sub.filters.query || '不限关键词'} · ${NOTICE_LABELS[sub.filters.notice_type] || '全部类型'}` }),
      el('div', { className: 'wy-tender-card-actions' },
        button('修改条件', () => {
          for (const [key, field] of Object.entries(fields)) if (key !== 'subscriptionName') field.value = sub.filters[key] == null ? '' : /Budget$/.test(key) ? sub.filters[key] / 10000 : sub.filters[key];
          fields.subscriptionName.value = sub.name; editId = sub.id; save.textContent = '保存订阅修改'; subscribe.open = true; tab = 'catalog'; load();
        }),
        button(sub.enabled ? '暂停' : '恢复', () => action(async () => { await call('change', { ...sub, action: 'subscribe', enabled: !sub.enabled }); await load(); })),
        button('删除', () => action(async () => { await call('change', { action: 'unsubscribe', id: sub.id }); await load(); }))
      )));
  }
  function renderAlerts(state) {
    if (!state.alerts.length) return [el('p', { className: 'wy-tender-empty', textContent: '暂时没有匹配提醒。订阅从保存后开始跟踪；没有提醒不代表所有网站都没有新项目。' })];
    return [button('全部标为已读', () => action(async () => { await call('change', { action: 'read' }); await load(); })), ...state.alerts.map(row =>
      el('article', { className: 'wy-tender-card' }, el('small', { textContent: `${row.read ? '已读' : '未读'} · ${date(row.at)}` }),
        el('h3', { textContent: row.title }), el('p', { textContent: row.body }),
        row.change && el('p', { textContent: `预算：${row.change.before.budgetText || '待核实'} → ${row.change.after.budgetText || '待核实'}；截止：${row.change.before.deadlineText || '待核实'} → ${row.change.after.deadlineText || '待核实'}` }),
        el('div', { className: 'wy-tender-card-actions' }, link(row.url, '核对官方原文'), !row.read && button('已读', () => action(async () => { await call('change', { action: 'read', id: row.id }); await load(); })))))];
  }
  async function load() {
    if (!current()) return;
    const ticket = ++epoch; message.textContent = '正在读取公告库…';
    try {
      const data = await call('list', filters());
      const state = ['subscriptions', 'alerts'].includes(tab) ? await call('mine') : null;
      if (!current() || ticket !== epoch) return;
      renderTabs(data.unread);
      message.textContent = `${data.enabled ? '每30分钟自动更新' : '自动更新已暂停'}${data.running ? ' · 正在采集' : ''} · 本次筛选 ${data.total} 条`;
      statusBox.replaceChildren(el('p', { textContent: data.coverage }), ...data.sources.map(source => el('p', {
        textContent: `${source.label}：${({ ok: '最近读取成功', partial: '部分页面未读取', failed: '本次读取失败，保留旧数据', pending: '等待首次采集' })[source.state]}；最近成功 ${date(source.lastSuccess)}。${source.coverage}${source.error ? '（' + source.error.code + (source.error.http ? ' HTTP ' + source.error.http : '') + '）' : ''}`
      })));
      heading.querySelector('.wy-tender-admin')?.remove();
      if (data.canManage) heading.append(el('div', { className: 'wy-tender-admin' },
        button('更新资源', () => action(async () => { await call('refresh'); await load(); })),
        button(data.enabled ? '暂停更新' : '恢复更新', () => action(async () => { await call('configure', !data.enabled); await load(); }))));
      if (tab === 'subscriptions') body.replaceChildren(...renderSubscriptions(state));
      else if (tab === 'alerts') body.replaceChildren(...renderAlerts(state));
      else {
        body.replaceChildren(...data.items.map(notice));
        if (!data.items.length) body.append(el('p', { className: 'wy-tender-empty', textContent: data.sources.every(source => source.state === 'failed' || source.state === 'pending') ? '来源暂时未返回可用公告。请查看更新状态；这不代表没有项目。' : '当前目录中没有符合条件的公告，可调整筛选条件。' }));
        const pager = el('div', { className: 'wy-tender-pager' }, el('span', { textContent: `第 ${data.page} 页` }));
        if (page > 1) pager.prepend(button('上一页', () => { page--; load(); }));
        if (page * 20 < data.total) pager.append(button('下一页', () => { page++; load(); }));
        body.append(pager);
      }
    } catch (error) { if (current() && ticket === epoch) message.textContent = `公告库暂不可用：${error.message}。请确认服务器已更新。`; }
  }
  function poll() {
    if (!current() || !root.isConnected) return;
    if (tab === 'catalog' && !root.contains(document.activeElement)) load();
    timer = setTimeout(poll, 60000);
  }
  renderTabs(); load(); timer = setTimeout(poll, 60000);
  return { root, destroy() { disposed = true; epoch++; clearTimeout(timer); root.remove(); } };
}
