import './workbenchAgents.css';

// 仅PC工作台调用，保留手机广场的DOM布局和所有已有动作。
export function initWorkbenchAgents({ rail, top, agents, closePanel }) {
  const square = document.querySelector('.wy-studio-square');
  if (!square) return;
  square.classList.add('wb-agent-square');
  square.setAttribute('role', 'region');
  square.setAttribute('aria-label', '智能体广场');
  const header = square.querySelector('.wy-agents-bar');
  const heading = document.createElement('div');
  heading.className = 'wb-agent-heading';
  const title = header.querySelector('h2');
  title.textContent = '智能体广场';
  const subtitle = document.createElement('p');
  subtitle.textContent = '为每一件事，找到合适的助手。';
  title.before(heading); heading.append(title, subtitle);
  const create = square.querySelector('.wy-studio-new');
  if (create) header.append(create);
  const crumb = document.createElement('span');
  crumb.className = 'wb-agents-crumb'; crumb.textContent = '工作台 / 智能体';
  top.append(crumb);

  // 原创线性图标使用固定路径，统一侧栏笔画；不处理用户提供的HTML。
  const icons = {
    '新建对话': '<path d="M12 5v14M5 12h14"/>',
    '智能体': '<rect x="4" y="6" width="16" height="14" rx="5"/><path d="M12 3v3M8 11v2m8-2v2m-7 3h6"/>',
    '文件空间': '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    '专家与技能': '<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z"/>',
    '定时任务': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    '代码项目': '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
    '连接应用': '<path d="m9 8 2-2a5 5 0 0 1 7 7l-2 2M8 9l-2 2a5 5 0 0 0 7 7l2-2m-6-1 6-6"/>',
    '记忆空间': '<path d="M8 4h8l4 8-4 8H8l-4-8Z"/><circle cx="12" cy="12" r="3"/>',
    '知识库': '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
    '实验室': '<path d="M9 3h6m-5 0v7L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M7 16h10"/>'
  };
  for (const button of rail.querySelectorAll('.wb-nav button')) {
    const icon = button.querySelector('.wb-nav-icon');
    if (icon && icons[button.title]) {
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[button.title]}</svg>`;
    }
  }
  const close = () => window.dispatchEvent(new Event('jarvis:close-agents'));
  rail.addEventListener('click', event => {
    if (event.target.closest('button') && !agents.contains(event.target)) close();
  }, true);
  let opened = false;
  function sync() {
    const visible = !square.hidden;
    agents.setAttribute('aria-expanded', String(visible));
    crumb.hidden = !visible;
    if (visible && !opened) closePanel();
    else if (visible && !document.body.classList.contains('side-closed')) close();
    if (opened && !visible && square.contains(document.activeElement)) agents.focus();
    opened = visible;
  }
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
}
