import './businessStart.css';

/** 专业入口只填草稿，不预先查询、订阅或消费第三方额度。 */
export function enhanceBusinessStart(root, { onFill }) {
  root.dataset.layout = 'business';
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
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
  root.querySelector('.wy-studio-subhero').after(grid);
  root.querySelector('.wy-agent-form')?.before(el('p', { className: 'wy-business-caption', textContent: '公开公告优先 · 原文可追溯 · 日期与状态分开核对' }));
  const upload = root.querySelector('.wy-agent-upload');
  if (upload) {
    upload.querySelector('b').textContent = '上传招标文件或企业资料';
    upload.querySelector('.wy-agent-upload-copy span').textContent = '整理资格条件、评分项和待补材料';
  }
}
