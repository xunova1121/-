import { normalizeMarketSnapshot } from '../../shared/marketSnapshot.js';
import './marketCard.css';

const node = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: String(text ?? '') });
const amount = value => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 }).format(value) : '未提供';
const signed = value => (value > 0 ? '+' : '') + amount(value);
const clock = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function from(value) {
  const line = node('p', 'market-card-source', '来源：');
  const link = node('a', '', value.name);
  link.href = value.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  line.append(link);
  return line;
}
const svgNode = (tag, attrs = {}) => {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
  return item;
};
function chart(bars, unit) {
  const frame = node('div', 'market-chart-frame');
  if (bars.length < 2) {
    frame.append(node('p', 'market-card-note', '仅返回 1 个交易日，暂无足够数据绘制走势。'));
    return frame;
  }
  const values = bars.map(row => row.close), min = Math.min(...values), max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max) * .01, .01);
  const points = bars.map((row, index) => [12 + index / (bars.length - 1) * 576, 124 - (row.close - min) / range * 112]);
  const svg = svgNode('svg', { viewBox: '0 0 600 144', role: 'img', 'aria-label': `${bars.length} 个真实交易日的收盘价走势`, class: 'market-chart' });
  const title = svgNode('title'); title.textContent = `${bars[0].date} 至 ${bars.at(-1).date}：${bars.length} 个来源返回的收盘价`;
  svg.append(title, svgNode('line', { x1: 12, x2: 588, y1: 124, y2: 124, class: 'market-chart-axis' }));
  svg.append(svgNode('polyline', { points: points.map(point => point.join(',')).join(' '), fill: 'none', class: 'market-chart-line', 'data-count': bars.length }));
  const readout = node('p', 'market-chart-readout', `${bars.at(-1).date} 收盘 ${amount(bars.at(-1).close)} ${unit}`);
  points.forEach(([x, y], index) => {
    const row = bars[index], label = `${row.date} 收盘 ${amount(row.close)} ${unit}`;
    const dot = svgNode('circle', { cx: x, cy: y, r: 5, class: 'market-chart-point', tabindex: '0', role: 'button', 'aria-label': label });
    const hint = svgNode('title'); hint.textContent = label; dot.append(hint);
    const show = () => { readout.textContent = label; };
    dot.addEventListener('focus', show); dot.addEventListener('pointerenter', show); dot.addEventListener('click', show);
    dot.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
    svg.append(dot);
  });
  const scale = node('div', 'market-chart-scale');
  scale.append(node('span', '', `区间最低 ${amount(min)}`), node('span', '', `区间最高 ${amount(max)} ${unit}`));
  const dates = node('div', 'market-chart-dates');
  dates.append(node('span', '', bars[0].date), node('span', '', bars.at(-1).date));
  frame.append(scale, svg, dates, readout);
  return frame;
}
/** 来自成功工具回执的冻结快照。文字按textContent渲染，图形只连已有交易日收盘价。 */
export function createMarketCard(input) {
  const value = normalizeMarketSnapshot(input);
  if (!value) return null;
  const box = node('section', 'market-card');
  box.setAttribute('aria-label', value.kind === 'kline' ? '历史行情卡' : '行情卡');
  const head = node('header', 'market-card-head');
  head.append(node('strong', '', value.title || '行情速览'), node('span', 'market-card-badge', value.kind === 'kline' ? '日K收盘价' : '行情快照'));
  box.append(head);
  if (value.kind === 'quote') {
    for (const row of value.quotes) {
      const item = node('article', 'market-quote');
      const name = node('div', 'market-quote-name');
      name.append(node('strong', '', row.name), node('span', '', row.symbol));
      const price = node('div', 'market-quote-price');
      price.append(node('b', '', amount(row.price)), node('span', '', row.unit || '单位未提供'));
      if (Number.isFinite(row.changePct)) price.append(node('span', `market-quote-change ${row.changePct > 0 ? 'is-up' : row.changePct < 0 ? 'is-down' : ''}`, `${signed(row.changePct)}%${Number.isFinite(row.change) ? `（${signed(row.change)}）` : ''}`));
      const details = node('div', 'market-quote-details');
      for (const [key, label] of [['prevClose', '昨收'], ['open', '今开'], ['high', '最高'], ['low', '最低']]) {
        if (Number.isFinite(row[key])) details.append(node('span', '', `${label} ${amount(row[key])}`));
      }
      item.append(name, price, details, node('p', 'market-card-time', `${row.reference ? '参考价更新于' : '行情时间'}：${row.time || '来源未提供'}`), from(row.source));
      box.append(item);
    }
  } else {
    const latest = value.bars.at(-1);
    const top = node('div', 'market-kline-summary');
    const price = node('div', 'market-quote-price');
    price.append(node('b', '', amount(latest.close)), node('span', '', value.unit || '单位未提供'));
    top.append(price, node('p', 'market-card-time', `${latest.date} 收盘 · ${{ none: '不复权', qfq: '前复权', hfq: '后复权' }[value.adjustment]}`));
    box.append(top, chart(value.bars, value.unit), from(value.source), node('p', 'market-card-note', `本次展示 ${value.bars.length} 个来源返回的交易日，最多保留最近 60 条。`));
  }
  if (value.note) box.append(node('p', 'market-card-note', value.note));
  box.append(node('p', 'market-card-fetched', `查询于 ${clock(value.fetchedAt)}（北京时间）`));
  return box;
}
