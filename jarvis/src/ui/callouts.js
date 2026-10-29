/**
 * 光核旁的建议标注：编号 1 / 2 / 3 的小卡片，用流动的虚线连到光核。
 *
 *   - 线的起点贴着光核边缘，跟着光核浮动；新建议出现时虚线从光核“长”出去
 *   - 鼠标移到某条建议上：那条线变亮、流速加快，光核的眼睛看向它
 *   - 点击：一颗光点顺着虚线飞进光核，光核闪一下，然后开始执行
 *   - 执行任务时标注收起；回答完给出新的 1 / 2 / 3
 */
import { calloutLayout } from '../core/suggest.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/**
 * @param {object} o
 * @param {HTMLElement} o.root 舞台容器（position: relative）
 * @param {() => ({ x: number, y: number, r: number } | null)} o.getAnchor 光核在舞台里的位置
 * @param {(s: object, i: number) => void} o.onPick
 * @param {(point: { x: number, y: number } | null, orb: object | null) => void} [o.onHover]
 * @param {() => boolean} [o.reducedMotion]
 */
export function initCallouts({ root, getAnchor, onPick, onHover, reducedMotion = () => false }) {
  const svg = svgEl('svg', { class: 'callout-lines', 'aria-hidden': 'true' });
  const defs = svgEl('defs');
  const glow = svgEl('filter', { id: 'cl-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  glow.append(svgEl('feGaussianBlur', { stdDeviation: '2.2', result: 'b' }));
  const merge = svgEl('feMerge');
  merge.append(svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
  glow.append(merge);
  defs.append(glow);
  svg.append(defs);

  const box = document.createElement('div');
  box.className = 'callouts';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '建议');
  root.append(svg, box);

  const slots = [0, 1, 2].map((i) => {
    const mask = svgEl('mask', { id: `cl-mask-${i}`, maskUnits: 'userSpaceOnUse' });
    const maskPath = svgEl('path', { class: 'cl-mask', pathLength: '1' });
    mask.append(maskPath);
    defs.append(mask);
    const g = svgEl('g', { class: 'cl-g' });
    const line = svgEl('path', { class: 'cl-line', mask: `url(#cl-mask-${i})`, filter: 'url(#cl-glow)' });
    const nodeOrb = svgEl('circle', { class: 'cl-node', r: '2.6' });
    const nodeBox = svgEl('circle', { class: 'cl-node end', r: '3.2' });
    const spark = svgEl('circle', { class: 'cl-spark', r: '4.5', filter: 'url(#cl-glow)' });
    g.append(line, nodeOrb, nodeBox, spark);
    svg.append(g);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'callout';
    btn.innerHTML = '<span class="cl-num"></span><span class="cl-body"><span class="cl-k"></span><span class="cl-title"></span></span>';
    btn.querySelector('.cl-num').textContent = String(i + 1);
    btn.querySelector('.cl-k').textContent = `建议 ${i + 1}`;
    box.append(btn);
    const slot = { i, g, line, maskPath, nodeOrb, nodeBox, spark, btn, item: null, end: null, start: null };
    btn.addEventListener('mouseenter', () => hover(slot, true));
    btn.addEventListener('mouseleave', () => hover(slot, false));
    btn.addEventListener('focus', () => hover(slot, true));
    btn.addEventListener('blur', () => hover(slot, false));
    btn.addEventListener('click', () => pick(slot));
    return slot;
  });

  let shown = false;
  let busy = false;
  let raf = 0;
  let lastOrb = null;
  let lastLayoutKey = '';

  function hover(slot, on) {
    slot.g.classList.toggle('hot', on);
    slot.btn.classList.toggle('hot', on);
    onHover?.(on && slot.end ? slot.end : null, lastOrb);
  }

  function pick(slot) {
    if (!slot.item || busy) return;
    busy = true;
    const item = slot.item;
    const done = () => { busy = false; onPick(item, slot.i); };
    slot.btn.classList.add('picked');
    if (reducedMotion()) { done(); return; }
    // 光点顺着虚线从标注飞向光核
    const len = slot.line.getTotalLength();
    const t0 = performance.now();
    slot.spark.classList.add('on');
    const fly = (t) => {
      const k = Math.min(1, (t - t0) / 420);
      const e = k * k * (3 - 2 * k);
      const p = slot.line.getPointAtLength(len * (1 - e));
      slot.spark.setAttribute('cx', p.x);
      slot.spark.setAttribute('cy', p.y);
      if (k < 1) requestAnimationFrame(fly);
      else { slot.spark.classList.remove('on'); done(); }
    };
    requestAnimationFrame(fly);
  }

  /** 换一组建议：旧的收回，新的从光核长出来 */
  function set(items) {
    for (const s of slots) {
      s.item = items[s.i] ?? null;
      s.btn.hidden = !s.item;
      s.g.style.display = s.item ? '' : 'none';
      if (!s.item) continue;
      s.btn.querySelector('.cl-title').textContent = s.item.title;
      s.btn.title = s.item.prompt ? `发送：${s.item.prompt}` : `打开：${s.item.title}`;
      s.btn.classList.remove('picked', 'hot');
      s.g.classList.remove('hot');
    }
    show();
  }

  function show() {
    shown = true;
    root.classList.remove('cl-retract');
    // 重新触发“长出来”的动画
    root.classList.remove('cl-in');
    void root.offsetWidth;
    root.classList.add('cl-in');
    loop();
  }

  function retract() {
    shown = false;
    root.classList.add('cl-retract');
    root.classList.remove('cl-in');
    for (const s of slots) hover(s, false);
  }

  function layout() {
    const width = root.clientWidth;
    const height = root.clientHeight;
    const orb = getAnchor() ?? { x: width / 2, y: height * 0.45, r: Math.min(width, height) * 0.16 };
    lastOrb = orb;
    // 先批量读高度，再写位置；冻结的锚点不应每帧重绘相同的SVG滤镜/标注。
    const heights = slots.map(slot => slot.btn.offsetHeight || 46);
    const key = JSON.stringify([width, height, orb.x, orb.y, orb.r, ...heights]);
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    const tooSmall = height < 170 || width < 320;
    root.classList.toggle('cl-hidden', tooSmall);
    if (tooSmall) return;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const { mode, boxes } = calloutLayout({ width, height, orb });
    root.dataset.clMode = mode;
    for (const s of slots) {
      const b = boxes[s.i];
      s.btn.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
      s.btn.style.width = `${Math.round(b.w)}px`;
      const h = heights[s.i];
      const end = b.side === 'left' ? { x: b.x, y: b.y + h / 2 } : b.side === 'right' ? { x: b.x + b.w, y: b.y + h / 2 } : { x: b.x + b.w / 2, y: b.y };
      // 折线：先从光核边缘斜着出去，再水平（或垂直）接到卡片，像仪表上的引线
      const elbow = b.side === 'top' ? { x: end.x, y: end.y - 16 } : { x: end.x + (b.side === 'left' ? -26 : 26), y: end.y };
      const dx = elbow.x - orb.x;
      const dy = elbow.y - orb.y;
      const d = Math.hypot(dx, dy) || 1;
      const start = { x: orb.x + (dx / d) * orb.r * 1.18, y: orb.y + (dy / d) * orb.r * 1.18 };
      const path = `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${elbow.x.toFixed(1)},${elbow.y.toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`;
      s.line.setAttribute('d', path);
      s.maskPath.setAttribute('d', path);
      s.nodeOrb.setAttribute('cx', start.x.toFixed(1));
      s.nodeOrb.setAttribute('cy', start.y.toFixed(1));
      s.nodeBox.setAttribute('cx', end.x.toFixed(1));
      s.nodeBox.setAttribute('cy', end.y.toFixed(1));
      s.end = end;
      s.start = start;
    }
  }

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (!document.hidden) layout();
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  new ResizeObserver(() => layout()).observe(root);

  return {
    set,
    retract,
    show,
    get items() { return slots.map((s) => s.item); },
    get visible() { return shown && !root.classList.contains('cl-hidden'); },
    /** 测试用：点第 i 条 */
    pick: (i) => pick(slots[i])
  };
}
