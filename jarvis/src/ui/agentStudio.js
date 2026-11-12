/** 第二版界面只组织已有表单与回调，作品示例不冒充用户生成结果。 */
import hero from '../assets/agent-studio/hero.svg';
import poster from '../assets/agent-studio/poster.svg';
import cover from '../assets/ppt-sources/source-cobalt-1.jpg';
import poster0 from '../assets/agent-studio/poster-0.svg';
import poster1 from '../assets/agent-studio/poster-1.svg';
import poster2 from '../assets/agent-studio/poster-2.svg';
import poster3 from '../assets/agent-studio/poster-3.svg';
import './agentStudio.css';
import { enhanceBusinessStart } from './businessStart.js';

export const studioEl = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter(k => k !== null && k !== undefined && k !== false));
  return node;
};
const el = studioEl;
const copy = {
  'business-intelligence': ['BUSINESS INTELLIGENCE', '找到项目，\n看清企业。'],
  'ppt-maker': ['PRESENT YOUR IDEAS', '好内容，\n值得好的呈现。'],
  'gongwen-writer': ['WRITE WITH CLARITY', '落笔有据，\n表达有章法。'],
  'poster-designer': ['MAKE SOMETHING BEAUTIFUL', '让每个想法，\n都有画面。'],
  'image-reader': ['FROM IMAGE TO WORDS', '把图片里的信息，用起来。'],
  'health-advisor': ['CARE FOR YOURSELF', '从今天起，照顾好自己。'],
  'deep-researcher': ['EXPLORE WITH EVIDENCE', '复杂的问题，一起理清。'],
  'travel-weather': ['READY FOR YOUR JOURNEY', '带着好天气，出发。'],
  'market-quotes': ['FOLLOW THE NUMBERS', '行情有数字，判断有依据。']
};

export function studioFeatures(onPick) {
  const root = el('div', { className: 'wy-studio-features' });
  const items = [
    ['ppt-maker', cover, 'PPT 制作', '观点清楚，也有好设计'],
    ['poster-designer', poster, '海报设计', '每个想法，都值得出彩']
  ];
  for (const [id, src, label, title] of items) {
    const button = el('button', { type: 'button', className: 'wy-studio-feature' },
      el('img', { src, alt: `${label}样板预览`, decoding: 'async' }),
      el('small', { textContent: label }), el('b', { textContent: title }));
    button.addEventListener('click', () => onPick(id));
    root.append(button);
  }
  return root;
}

export function studioHeroArt() {
  return el('img', { className: 'wy-studio-hero-art', src: hero, alt: '', ariaHidden: 'true' });
}

/** 覆盖原生select的可视按钮仍写回select，保持同一份表单与服务端校验。 */
function choiceGrid(root, key, className, decorations = []) {
  const select = root.querySelector(`[data-field="${key}"] select`);
  if (!select) return null;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const box = el('div', { className, role: 'group', ariaLabel: select.getAttribute('aria-label') });
  const update = () => {
    for (const b of box.children) {
      const on = b.dataset.value === select.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  for (const [i, option] of [...select.options].filter(x => x.value).entries()) {
    const button = el('button', { type: 'button' },
      decorations.length ? el('span', { className: 'wy-studio-swatch', textContent: decorations[i % decorations.length], ariaHidden: 'true' }) : null,
      el('span', { textContent: option.textContent }));
    button.dataset.value = option.value;
    button.addEventListener('click', () => {
      select.value = select.value === option.value ? '' : option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    box.append(button);
  }
  select.addEventListener('change', update);
  update();
  const field = select.closest('.wy-agent-field');
  field.classList.add('wy-studio-choice-field');
  field.append(box);
  return box;
}

function posterInspiration(root, onFill) {
  const entries = [
    [poster0, '自然有约', '生活方式', '设计一张自然主题的生活方式海报，清爽绿色，留出标题区域。'],
    [poster1, '城市艺文', '活动宣传', '设计一张城市艺文活动宣传海报，突出活动名称、日期和地点。'],
    [poster2, '春日好物', '品牌上新', '设计一张春日产品上新海报，明亮柔和，突出产品和核心卖点。'],
    [poster3, '蓝色未来', '科技发布', '设计一张科技产品发布海报，蓝色渐变，简洁清楚的文字层级。']
  ];
  const details = el('details', { className: 'wy-studio-inspiration', open: true }, el('summary', { textContent: '从一个灵感开始' }));
  const grid = el('div', { className: 'wy-studio-posters' });
  for (const [src, title, category, suggestion] of entries) {
    const button = el('button', { type: 'button' }, el('img', { src, alt: `${title} · 原创风格示例`, loading: 'lazy' }),
      el('b', { textContent: title }), el('small', { textContent: category }));
    button.addEventListener('click', () => onFill(suggestion));
    grid.append(button);
  }
  details.append(grid, el('p', { className: 'wy-agent-start-note', textContent: '原创风格示例。点选后可修改描述，再发送生成。' }));
  root.querySelector('.wy-agent-form')?.before(details);
  return details;
}

function posterWorkspace(root, onFill, heroNode) {
  const tabs = el('div', { className: 'wy-studio-tabs', role: 'tablist', ariaLabel: '海报工作区' });
  const form = root.querySelector('.wy-agent-form');
  const upload = root.querySelector('.wy-agent-upload');
  let inspiration;
  const choose = mode => {
    root.dataset.studioPanel = mode;
    inspiration.hidden = mode !== 'inspiration';
    form.hidden = mode === 'inspiration';
    upload.hidden = mode === 'inspiration';
    for (const field of form.children) field.hidden = mode === 'tools' ? !['size', 'ratio', 'operation'].includes(field.dataset.field) : field.dataset.field === 'operation';
    for (const button of tabs.children) {
      button.classList.toggle('on', button.dataset.studioTab === mode);
      button.setAttribute('aria-selected', String(button.dataset.studioTab === mode));
    }
  };
  inspiration = posterInspiration(root, text => { choose('create'); onFill(text); });
  for (const [id, label] of [['inspiration', '灵感作品'], ['create', '创作海报'], ['tools', '图片处理']]) {
    const button = el('button', { type: 'button', textContent: label, role: 'tab' });
    button.dataset.studioTab = id;
    button.addEventListener('click', () => choose(id));
    tabs.append(button);
  }
  heroNode.after(tabs);
  form.after(upload);
  choose('inspiration');
}

export function enhanceAgentStart(root, profile, { onFill, business }) {
  root.classList.add('wy-studio-start');
  const header = root.querySelector('.wy-agent-start-head');
  const intro = root.querySelector('.wy-agent-start-intro');
  const [eyebrow, title] = copy[profile.id] || ['YOUR OWN ASSISTANT', profile.name];
  const creative = ['ppt-maker', 'gongwen-writer', 'poster-designer'].includes(profile.id);
  root.dataset.layout = creative ? 'creative' : 'conversation';
  const heroNode = el('div', { className: 'wy-studio-subhero' },
    el('small', { className: 'wy-studio-eyebrow', textContent: eyebrow }), header,
    el('h2', { textContent: title }), intro, profile.id === 'ppt-maker' ? studioHeroArt() : null);
  root.querySelector('.wy-agent-back-link')?.after(heroNode);
  if (!heroNode.isConnected && !root.contains(heroNode)) root.prepend(heroNode);
  if (profile.id === 'gongwen-writer') {
    choiceGrid(root, 'kind', 'wy-studio-document-types', ['▤']);
    const group = el('div', { className: 'wy-studio-tools' });
    for (const title of ['校对润色', '提炼大纲', '改写扩写', '调整格式']) {
      const button = el('button', { type: 'button', textContent: title });
      button.addEventListener('click', () => onFill(`请对提供的文稿做${title}，保留原有事实和数字。`));
      group.append(button);
    }
    root.querySelector('.wy-agent-form')?.after(group);
  }
  if (profile.id === 'poster-designer') {
    posterWorkspace(root, onFill, heroNode);
    choiceGrid(root, 'style', 'wy-studio-styles', ['Aa', '◒', '◈', '山', '✳', '▧', '≈', '◎']);
    choiceGrid(root, 'ratio', 'wy-studio-ratios', ['▯', '▭', '▯', '□']);
    choiceGrid(root, 'operation', 'wy-studio-tools');
  }
  if (profile.id === 'image-reader') choiceGrid(root, 'format', 'wy-studio-tools');
  const upload = root.querySelector('.wy-agent-upload');
  if (profile.id === 'image-reader' && upload) {
    upload.classList.add('wy-studio-dropzone');
    upload.querySelector('b').textContent = '上传需要识别的图片';
    upload.querySelector('.wy-agent-upload-copy span').textContent = '提取文字、表格或票据内容';
    heroNode.after(upload);
  }
  if (profile.id === 'ppt-maker' && upload) heroNode.after(upload);
  if (profile.id === 'business-intelligence' && profile.source === 'builtin') root.businessStartController = enhanceBusinessStart(root, { onFill, ...business });
}
