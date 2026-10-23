import { createMascot, setMascotState } from './mascot.js';
import { createHomeWeather } from './homeWeather.js';
import './home.css';

function element(tag, text, className = '') {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const choices = [
  ['document', '帮我梳理今天的工作', '帮我梳理今天的工作，先一起确认目标：'],
  ['book', '最近有什么好看的小说？', '最近有什么好看的小说？请按我的阅读偏好推荐。'],
  ['chat', '先陪我聊一会儿', '先陪我聊一会儿。'],
  ['spark', '寻找创作灵感', '帮我寻找创作灵感，先一起梳理目标：'],
  ['search', '研究一个话题', '帮我研究一个话题，并注明来源：'],
  ['calendar', '安排明天行程', '帮我安排明天的行程，我需要完成：']
];

function icon(kind) {
  const paths = {
    document: 'M7 3h7l4 4v14H6V3h1M14 3v5h5M9 12h6M9 16h6',
    book: 'M12 5C9 3 5 3 2 4v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1v16',
    chat: 'M21 11a8 8 0 0 1-8 8H8l-5 3v-6a8 8 0 1 1 18-5M8 10h8M8 14h5',
    spark: 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
    search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    calendar: 'M4 5h16v16H4zM8 2v6M16 2v6M4 10h16M8 14h3M13 17h3'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[kind]);
  svg.append(path);
  return svg;
}

/** 手机欢迎页复用原天气与输入入口，不新增模型调用或图片持久化。 */
export function createHome({ weather, fill, openPanel }) {
  const root = element('div', undefined, 'welcome wy-home home-reference');
  const hero = element('section', undefined, 'home-hero');
  const copy = element('div', undefined, 'home-hero-copy');
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Asia/Shanghai'
    }).format(new Date())
  );
  const greeting = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const title = element('h1', `${greeting}，我在呢。`);
  const care = element('p', '今天想做什么，都可以和我说。', 'home-care');
  copy.append(title, care);

  const pet = element('button', undefined, 'home-pet');
  pet.type = 'button';
  pet.setAttribute('aria-label', '摸摸未央的头');
  const mascot = createMascot('wave');
  const bubble = element('span', '摸摸我的头，和我打个招呼。', 'home-pet-hint');
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  pet.append(mascot, bubble);
  hero.append(pet, copy);
  let timer;
  let pose = 0;
  const poses = ['pet', 'love', 'wink', 'shy'];
  const replies = ['收到你的温柔啦，我在呢。', '送你一颗小小的心。', '见到你，真好。', '有你在，我也很开心。'];
  pet.onclick = () => {
    clearTimeout(timer);
    const index = pose++ % poses.length;
    setMascotState(mascot, poses[index]);
    bubble.textContent = replies[index];
    pet.classList.remove('petted');
    void pet.offsetWidth;
    pet.classList.add('petted');
    timer = setTimeout(() => {
      setMascotState(mascot, 'wave');
      pet.classList.remove('petted');
    }, 2400);
  };

  const weatherUI = createHomeWeather({ client: weather });
  root.append(weatherUI.root, hero);
  const head = element('div', undefined, 'home-suggestions-head');
  head.append(element('span', '未央为你准备了'));
  const refresh = element('button', '换一换 ↻');
  refresh.type = 'button';
  head.append(refresh);
  const suggestions = element('div', undefined, 'home-suggestions');
  let offset = 0;
  function renderSuggestions() {
    suggestions.replaceChildren(
      ...[0, 1, 2].map((index) => {
        const [kind, caption, draft] = choices[(offset + index) % choices.length];
        const button = element('button', undefined, 'home-suggestion');
        button.type = 'button';
        const mark = element('span', undefined, 'home-task-icon');
        mark.append(icon(kind));
        const arrow = element('span', '›', 'home-task-arrow');
        arrow.setAttribute('aria-hidden', 'true');
        button.append(mark, element('span', caption, 'home-task-label'), arrow);
        // 建议只填入输入框；用户明确发送前不自动产生模型费用。
        button.onclick = () => fill(draft);
        if (kind === 'spark') button.classList.add('home-start');
        return button;
      })
    );
  }
  refresh.onclick = () => {
    offset = (offset + 3) % choices.length;
    renderSuggestions();
  };
  renderSuggestions();
  root.append(head, suggestions);
  const files = element('button', '文件空间  ›', 'home-files');
  files.type = 'button';
  files.onclick = () => openPanel('workspace');
  root.append(files);

  const composer = document.querySelector('#inputbar');
  const messageInput = document.querySelector('#prompt');
  const oldPlaceholder = messageInput?.placeholder;
  if (messageInput) messageInput.placeholder = '说说你的想法…';
  const footer = element('p', '内容由 AI 生成，请核对重要信息', 'home-footer');
  composer?.after(footer);
  let destroyed = false;
  const observer = new MutationObserver(() => {
    if (!root.isConnected) destroy();
  });
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(timer);
    observer.disconnect();
    weatherUI.destroy();
    footer.remove();
    if (messageInput?.placeholder === '说说你的想法…') messageInput.placeholder = oldPlaceholder;
  }
  queueMicrotask(() => {
    if (root.isConnected) observer.observe(root.parentNode, { childList: true });
    else destroy();
  });
  return { root, destroy };
}
