/**
 * 看图：点开放大，滚轮缩放，拖着平移，左右翻上一张下一张。
 *
 * 分镜网格里的缩略图只有两百来像素宽 —— 判断"这张脸对不对""手指有没有崩"
 * 光看缩略图根本看不出来。以前只能靠去数据目录里翻文件，那不叫能用。
 *
 * 全局只有一个实例：同时开两个灯箱没有意义，还会互相抢键盘。
 */
import { h, clear } from './lib.js';

let box = null;
let state = null;

function build() {
  const img = h('img', { class: 'lb-img', alt: '' });
  const stage = h('div', { class: 'lb-stage' }, img);
  const caption = h('div', { class: 'lb-caption' });
  const counter = h('span', { class: 'lb-counter' });
  const zoomLabel = h('span', { class: 'lb-zoom' });

  const prevBtn = h('button', { class: 'lb-nav prev', title: '上一张（←）' }, '‹');
  const nextBtn = h('button', { class: 'lb-nav next', title: '下一张（→）' }, '›');

  const root = h('div', { class: 'lightbox', style: 'display:none' },
    h('div', { class: 'lb-bar' },
      counter,
      h('div', { class: 'lb-actions' },
        zoomLabel,
        h('button', { class: 'lb-btn', title: '放大（+ 或滚轮）', onclick: () => zoomBy(1.25) }, '＋'),
        h('button', { class: 'lb-btn', title: '缩小（- 或滚轮）', onclick: () => zoomBy(0.8) }, '－'),
        h('button', { class: 'lb-btn', title: '还原（0）', onclick: () => setZoom(1, true) }, '1:1'),
        h('a', { class: 'lb-btn', target: '_blank', rel: 'noreferrer', title: '在新标签页打开原图' }, '原图'),
        h('button', { class: 'lb-btn close', title: '关闭（Esc）', onclick: close }, '✕'))),
    prevBtn,
    stage,
    nextBtn,
    caption
  );

  // 点背景关掉，点图本身不关 —— 拖动图片时很容易滑到背景上
  root.addEventListener('mousedown', (e) => {
    if (e.target === root || e.target === stage) close();
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 0.89, e);
  }, { passive: false });

  // 拖着平移：放大之后不能平移的话，等于只能看中间那块
  let dragging = null;
  img.addEventListener('mousedown', (e) => {
    if (state.zoom <= 1) return;
    e.preventDefault();
    dragging = { x: e.clientX - state.tx, y: e.clientY - state.ty };
    img.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging || !state) return;
    state.tx = e.clientX - dragging.x;
    state.ty = e.clientY - dragging.y;
    apply();
  });
  window.addEventListener('mouseup', () => {
    dragging = null;
    if (img) img.style.cursor = state && state.zoom > 1 ? 'grab' : 'zoom-in';
  });

  // 没放大时点一下图直接放到 2 倍，比去按加号快
  img.addEventListener('click', (e) => {
    if (dragging) return;
    if (state.zoom === 1) zoomBy(2, e);
    else setZoom(1, true);
  });

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));

  document.body.append(root);
  box = { root, img, caption, counter, zoomLabel, prevBtn, nextBtn, stage };
  return box;
}

function apply() {
  const { img, zoomLabel } = box;
  img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.zoom})`;
  img.style.cursor = state.zoom > 1 ? 'grab' : 'zoom-in';
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function setZoom(next, recenter = false) {
  state.zoom = Math.min(8, Math.max(0.2, next));
  if (recenter || state.zoom === 1) {
    state.tx = 0;
    state.ty = 0;
  }
  apply();
}

/** 以鼠标位置为锚点缩放，不然放大之后想看的地方跑到屏幕外去了 */
function zoomBy(factor, ev = null) {
  const before = state.zoom;
  const next = Math.min(8, Math.max(0.2, before * factor));
  if (ev) {
    const rect = box.img.getBoundingClientRect();
    const cx = ev.clientX - (rect.left + rect.width / 2);
    const cy = ev.clientY - (rect.top + rect.height / 2);
    state.tx -= cx * (next / before - 1);
    state.ty -= cy * (next / before - 1);
  }
  state.zoom = next;
  if (next === 1) {
    state.tx = 0;
    state.ty = 0;
  }
  apply();
}

function show(index) {
  const item = state.items[index];
  if (!item) return;
  state.index = index;
  box.img.src = item.src;
  box.img.alt = item.title || '';
  clear(box.caption);
  if (item.title) box.caption.append(h('b', {}, item.title));
  if (item.note) box.caption.append(h('span', {}, item.note));
  box.counter.textContent = state.items.length > 1 ? `${index + 1} / ${state.items.length}` : '';
  box.prevBtn.style.display = state.items.length > 1 ? '' : 'none';
  box.nextBtn.style.display = state.items.length > 1 ? '' : 'none';
  box.root.querySelector('a.lb-btn').href = item.src;
  setZoom(1, true);
}

function step(delta) {
  if (!state || state.items.length < 2) return;
  show((state.index + delta + state.items.length) % state.items.length);
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === '+' || e.key === '=') zoomBy(1.25);
  else if (e.key === '-') zoomBy(0.8);
  else if (e.key === '0') setZoom(1, true);
}

export function close() {
  if (!box || !state) return;
  box.root.style.display = 'none';
  box.img.removeAttribute('src'); // 别让大图一直占着内存
  state = null;
  document.removeEventListener('keydown', onKey);
}

/**
 * 打开看图。
 * @param {Array<{src:string,title?:string,note?:string}>} items 这一组图，可以左右翻
 * @param {number} index 从第几张开始
 */
export function openLightbox(items, index = 0) {
  const list = (items || []).filter((x) => x && x.src);
  if (!list.length) return;
  if (!box) build();
  state = { items: list, index: 0, zoom: 1, tx: 0, ty: 0 };
  box.root.style.display = '';
  document.addEventListener('keydown', onKey);
  show(Math.max(0, Math.min(index, list.length - 1)));
}
