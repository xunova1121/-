import './businessStart.css';
import { COMPANY_SECTIONS, companyResultView } from './businessQueryView.js';

let sequence = 0;
/** 公司查询明确点击才执行；旧对话动作继续只填草稿，不预先订阅或消费额度。 */
export function enhanceBusinessStart(root, { onFill, onCompanyQuery, state = {}, valid = () => true, onModeChange = () => {} }) {
  root.dataset.layout = 'business';
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children.filter(child => child != null)); return node; };
  const id = `wy-business-${++sequence}`;
  let controller = null, disposed = false, epoch = 0;
  const current = () => !disposed && valid();
  const hero = root.querySelector('.wy-studio-subhero');
  const heroTitle = hero?.querySelector('h2');
  if (heroTitle) heroTitle.textContent = '查企业，找机会';
  const intro = root.querySelector('.wy-agent-start-intro');
  if (intro) intro.textContent = '查公司资料，或浏览持续更新的招标项目。';
  const form = root.querySelector('.wy-agent-form');
  const sourceField = form?.querySelector('[data-field="company_source"]');
  const sourceSelect = sourceField?.querySelector('select');
  if (sourceSelect && !sourceSelect.value) sourceSelect.value = '公开来源';
  const tabs = el('div', { className: 'wy-business-tabs', role: 'tablist', ariaLabel: '企业与招投标查询方式' });
  const companyPanel = el('section', { id: id + '-company', role: 'tabpanel', className: 'wy-business-query-card' });
  const tenderPanel = el('section', { id: id + '-tenders', role: 'tabpanel', hidden: true });
  tenderPanel.dataset.businessTenders = '';
  const panels = { company: companyPanel, tenders: tenderPanel };
  function selectMode(mode) {
    if (disposed) return;
    state.mode = mode === 'tenders' ? 'tenders' : 'company';
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== state.mode;
    for (const tab of tabs.children) {
      const selected = tab.dataset.mode === state.mode;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    onModeChange(state.mode);
  }
  for (const [mode, title] of [['company', '查企业'], ['tenders', '找招标']]) {
    const tab = el('button', { type: 'button', role: 'tab', id: id + '-tab-' + mode, textContent: title });
    tab.dataset.mode = mode;
    tab.setAttribute('aria-controls', panels[mode].id);
    panels[mode].setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => selectMode(mode));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      selectMode(event.key === 'Home' ? 'company' : event.key === 'End' ? 'tenders' : state.mode === 'company' ? 'tenders' : 'company');
      [...tabs.children].find(button => button.dataset.mode === state.mode)?.focus();
    });
    tabs.append(tab);
  }
  const companyInput = el('input', { type: 'text', id: id + '-name', className: 'wy-business-company-input', autocomplete: 'organization', maxLength: 100,
    value: typeof state.company === 'string' ? state.company : '', placeholder: '输入企业名称或统一社会信用代码' });
  companyInput.addEventListener('input', () => { state.company = companyInput.value; });
  const sectionChoices = el('div', { className: 'wy-business-section-choices', role: 'group', ariaLabel: '企业查询内容' });
  state.section = Object.hasOwn(COMPANY_SECTIONS, state.section) ? state.section : 'basic';
  function setSection(section) {
    state.section = section;
    for (const button of sectionChoices.children) button.setAttribute('aria-pressed', String(button.dataset.section === section));
  }
  for (const [section, title] of Object.entries(COMPANY_SECTIONS)) {
    const button = el('button', { type: 'button', textContent: title }); button.dataset.section = section;
    button.addEventListener('click', () => setSection(section)); sectionChoices.append(button);
  }
  setSection(state.section);
  const notice = el('p', { className: 'wy-business-query-status', role: 'status' });
  const paidNote = el('small', { className: 'wy-business-source-note' });
  const updateSource = () => { paidNote.textContent = sourceSelect?.value?.startsWith('企百科') ? '已选择企百科；查询需要已配置的账号，可能产生服务费用。' : '使用已配置的公开搜索，结果提供来源与待核实说明。'; };
  sourceSelect?.addEventListener('change', updateSource); updateSource();
  const submit = el('button', { type: 'submit', className: 'wy-business-query-submit', textContent: '查询企业' });
  const stop = el('button', { type: 'button', className: 'wy-business-query-stop', textContent: '停止查询', hidden: true });
  stop.addEventListener('click', () => controller?.abort());
  const queryForm = el('form', { className: 'wy-business-company-form' },
    el('label', { htmlFor: companyInput.id, textContent: '你想查哪家公司？' }), companyInput,
    el('p', { className: 'wy-business-topic-label', textContent: '想了解什么？' }), sectionChoices,
    sourceField, paidNote,
    form && el('details', { className: 'wy-business-more' }, el('summary', { textContent: '更多条件' }), form,
      el('p', { className: 'wy-business-note', textContent: '地区、公告时间和类型用于高级对话查询；上方企业查询按名称、资料类型和来源执行。' })),
    el('div', { className: 'wy-business-query-actions' }, submit, stop), notice);
  const results = el('div', { className: 'wy-business-result-host', ariaLive: 'polite' });
  companyPanel.append(queryForm, results);
  queryForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (controller || !current()) return;
    const company = companyInput.value.trim();
    if (!company) { notice.textContent = '请先填写企业名称或统一社会信用代码。'; companyInput.focus(); return; }
    if (!onCompanyQuery) { notice.textContent = '当前连接暂不支持直接查询，可在“对话高级方式”中继续。'; return; }
    state.company = company;
    const query = { company, section: state.section, source: sourceSelect?.value?.startsWith('企百科') ? 'qibook' : 'public' };
    const ticket = ++epoch; controller = new AbortController();
    const active = controller;
    const controls = [companyInput, submit, ...sectionChoices.children, ...(sourceSelect ? [sourceSelect] : [])];
    controls.forEach(control => { control.disabled = true; }); stop.hidden = false;
    notice.textContent = '正在查询企业资料…';
    try {
      const response = await onCompanyQuery(query, active.signal);
      if (!current() || ticket !== epoch || active.signal.aborted) return;
      results.replaceChildren(companyResultView(response, query, { el, onFill: text => { if (current()) onFill(text); } }));
      notice.textContent = '查询已返回，资料和来源见下方。';
    } catch (error) {
      if (current() && ticket === epoch) notice.textContent = active.signal.aborted || error?.name === 'AbortError'
        ? '已停止查询，输入内容已保留。'
        : '查询未完成：' + String(error?.message || '连接失败，请重试').replace(/\b(?:sk-|tvly-)[A-Za-z0-9_-]{8,}/g, '[已隐藏]').slice(0, 300);
    } finally {
      if (ticket === epoch) {
        controller = null;
        controls.forEach(control => { control.disabled = false; }); stop.hidden = true;
        if (current() && active.signal.aborted) notice.textContent = '已停止查询，输入内容已保留。';
      }
    }
  });
  const shell = el('div', { className: 'wy-business-workspace' }, tabs, companyPanel, tenderPanel);
  hero ? hero.after(shell) : root.prepend(shell);
  const actions = [
    ['找招标', '按地区、行业和日期筛选', '按我选择的地区和时间查找招投标项目，列明公告类型、预算、截止时间和原文链接。'],
    ['查企业', '工商、股东与对外投资', '帮我查询这家公司的工商信息、股东和对外投资：'],
    ['读公告', '提炼要求，核对截止时间', '请解读这份招标公告，整理资格条件、预算、截止时间，并核对后续更正公告：'],
    ['跟踪项目', '按我的条件生成每日简报', '请每天上午9点按我选择的地区查询昨天和今天发布的招标及更正公告，列出发布日期与原文链接，说明覆盖范围，未取得最新资料时明确说明。']
  ];
  const grid = el('div', { className: 'wy-business-actions' });
  for (const [title, detail, draft] of actions) {
    const button = el('button', { type: 'button', className: 'wy-business-action' }, el('b', { textContent: title }), el('span', { textContent: detail }));
    button.addEventListener('click', () => onFill(draft));
    grid.append(button);
  }
  const advanced = el('details', { className: 'wy-business-advanced' }, el('summary', { textContent: '对话高级方式' }), grid);
  for (const selector of ['.wy-agent-start-label', '.wy-agent-starters', '.wy-agent-upload', '.wy-agent-start-note']) {
    const node = root.querySelector(selector); if (node) advanced.append(node);
  }
  shell.after(advanced);
  const upload = root.querySelector('.wy-agent-upload');
  if (upload) {
    upload.querySelector('b').textContent = '上传招标文件或企业资料';
    upload.querySelector('.wy-agent-upload-copy span').textContent = '整理资格条件、评分项和待补材料';
  }
  selectMode(state.mode);
  return { selectMode, destroy() { disposed = true; epoch++; controller?.abort(); controller = null; } };
}
