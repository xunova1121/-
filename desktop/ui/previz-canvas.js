/**
 * 俯视排位画布 —— 电脑版和手机版**共用这一份**。
 *
 * ── 为什么共用 ──
 *
 * 两端各写一份的话，它们会以肉眼看不出的方式漂开：一边的角度是顺时针、
 * 另一边是逆时针，一边把机位画在人下面、另一边画在上面。
 * 而这类差异不会报错，只会让同一份排位在两端算出不同的机位关系 ——
 * 那比少一个功能糟糕得多。
 *
 * 手机版（ui/m/m.js）本来一个 import 都没有，是个自包含模块。破这个例是值得的：
 * 这块画布是**几何**，几何在两端必须逐像素一致。
 *
 * ── 为什么是 SVG 不是 canvas ──
 *
 * 拖动要做命中判定。SVG 的每个元素都是 DOM 节点，指针事件直接落在它身上；
 * canvas 得自己算点到哪个圆里，而那正是容易和显示层算出两套坐标的地方。
 *
 * ── 触摸 ──
 *
 * 全用 pointer 事件，鼠标和手指走同一条代码。手机上真正要注意的只有一件事：
 * 拖动时必须阻止页面跟着滚，否则拖两下整页就飞走了（touch-action: none）。
 */

import * as previz from '/previz.js';
import { addKeyframe, applyFrame, createHistory, findObject, normalizeStage, stageObjects } from './previz-stage.js';

const NS = 'http://www.w3.org/2000/svg';

/** 俯视图的范围（米）。一间屋子、一段走廊都装得下，再大就该拆场次了 */
export const EXTENT = 6;

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

/**
 * 米 ↔ 画布像素。
 *
 * y 要翻过来：数学里 y 往上增大，SVG 里 y 往下增大。
 * 不翻的话拖动方向和显示方向相反，而那种别扭很难当场说清是哪儿错了。
 */
function makeScale(size) {
  const k = size / (EXTENT * 2);
  return {
    x: (m) => size / 2 + m * k,
    y: (m) => size / 2 - m * k,
    mx: (px) => (px - size / 2) / k,
    my: (px) => (size / 2 - px) / k
  };
}

function clampM(v) {
  return Math.max(-EXTENT, Math.min(EXTENT, v));
}

/**
 * 建一块排位画布。
 *
 * stage 形如 { cam: {x,y,height,lens,move}, subjects: [{name,x,y,facing}] }，
 * **就地改**并在每次改动后回调 onChange —— 调用方拿它去存盘和重算读数。
 */
export function blockingCanvas(stage, { size = 320, onChange = () => {} } = {}) {
  const s = makeScale(size);
  const svg = el('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'previz-canvas',
    style: `width:100%;max-width:${size}px;aspect-ratio:1;touch-action:none;user-select:none`
  });

  // ── 底：网格 + 一米刻度 ──
  svg.append(el('rect', { x: 0, y: 0, width: size, height: size, class: 'previz-bg' }));
  for (let m = -EXTENT; m <= EXTENT; m += 1) {
    const strong = m === 0;
    svg.append(el('line', {
      x1: s.x(m), y1: 0, x2: s.x(m), y2: size, class: strong ? 'previz-axis' : 'previz-grid'
    }));
    svg.append(el('line', {
      x1: 0, y1: s.y(m), x2: size, y2: s.y(m), class: strong ? 'previz-axis' : 'previz-grid'
    }));
  }

  const layer = el('g');
  svg.append(layer);

  /** 一次拖动。pointer 事件让鼠标和手指走同一条路 */
  function draggable(node, onMove) {
    node.style.cursor = 'grab';
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      node.setPointerCapture(ev.pointerId);
      const rect = svg.getBoundingClientRect();
      const move = (e) => {
        // getBoundingClientRect 拿到的是**显示尺寸**，而 viewBox 是 size ——
        // 手机上画布被压窄时两者不等，不换算的话拖动会偏
        const px = ((e.clientX - rect.left) / rect.width) * size;
        const py = ((e.clientY - rect.top) / rect.height) * size;
        onMove(clampM(s.mx(px)), clampM(s.my(py)));
        redraw();
        onChange();
      };
      const up = () => {
        node.releasePointerCapture(ev.pointerId);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
    });
  }

  /**
   * 只有**方位**、没有坐标的东西（远景地标、太阳）摆在画布边上，绕着圈拖。
   *
   * 为什么不给它们一个坐标：一座山、一个太阳的"离主体几米"是编不出来的，
   * 编出来的后果是机位挪三米、画面里那座山跟着横移半个屏，而真山不会动。
   * 摆在边框上，视觉上也说清了"它在场地外面很远"。
   */
  const RIM = size / 2 - 13;
  const rimAt = (deg) => {
    const rad = ((Number(deg) || 0) * Math.PI) / 180;
    return [size / 2 + Math.sin(rad) * RIM, size / 2 - Math.cos(rad) * RIM];
  };
  function draggableAngle(node, onDeg) {
    node.style.cursor = 'grab';
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      node.setPointerCapture(ev.pointerId);
      const rect = svg.getBoundingClientRect();
      const move = (e) => {
        const px = ((e.clientX - rect.left) / rect.width) * size - size / 2;
        const py = ((e.clientY - rect.top) / rect.height) * size - size / 2;
        if (Math.hypot(px, py) < 6) return; // 拖到正中时角度没有定义，别乱跳
        onDeg(Math.round((Math.atan2(px, -py) * 180) / Math.PI));
        redraw();
        onChange();
      };
      const up = () => {
        node.releasePointerCapture(ev.pointerId);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
    });
  }

  function redraw() {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const subjects = stage.subjects || [];
    const cam = stage.cam;

    /**
     * ── 东南西北 ──
     *
     * 图上不标方位的话，"机位在场景西南侧"这句话在人眼里是没有着落的。
     * 标出来之后，同一场戏的每一镜都能对着同一个基准摆 ——
     * 而这正是"下一镜衔接幅度很大"的根治办法：不是不让调，
     * 是调的时候看得见自己相对**房间**动了多少。
     *
     * ⚠ 不是真的地理方向，是给这一场戏定的基准（+y 记作北）。
     */
    for (const [word, dx, dy] of [['北', 0, -1], ['南', 0, 1], ['东', 1, 0], ['西', -1, 0]]) {
      const t = el('text', {
        x: size / 2 + dx * (size / 2 - 9),
        y: size / 2 + dy * (size / 2 - 9) + 4,
        class: 'previz-compass',
        'pointer-events': 'none'
      });
      t.append(document.createTextNode(word));
      layer.append(t);
    }

    /**
     * ── 地标：门、窗、桌 ──
     *
     * 观众判断"人在房间里的哪儿"靠的就是这些不动的东西。
     * 摆上之后，机位一挪就能当场算出"窗跑到画面另一边去了"——
     * 而那正是"这两镜好像不在同一个屋里"的真正来源。
     */
    for (const mk of stage.marks || []) {
      if (mk.far) {
        // 远景地标：只有方位，摆在边框上
        const [fx, fy] = rimAt(mk.deg);
        const fg = el('g');
        fg.append(el('circle', { cx: fx, cy: fy, r: 10, class: 'previz-far' }));
        const ft = el('text', { x: fx, y: fy + 4, class: 'previz-mark-label', 'pointer-events': 'none' });
        ft.append(document.createTextNode((mk.name || '?').slice(0, 2)));
        fg.append(ft);
        draggableAngle(fg.firstChild, (deg) => { mk.deg = deg; });
        layer.append(fg);
        continue;
      }
      const g = el('g');
      g.append(el('rect', {
        x: s.x(mk.x) - 9, y: s.y(mk.y) - 9, width: 18, height: 18, rx: 4, class: 'previz-mark'
      }));
      const t = el('text', { x: s.x(mk.x), y: s.y(mk.y) + 4, class: 'previz-mark-label', 'pointer-events': 'none' });
      t.append(document.createTextNode((mk.name || '?').slice(0, 2)));
      g.append(t);
      draggable(g.firstChild, (mx, my) => {
        mk.x = Number(mx.toFixed(2));
        mk.y = Number(my.toFixed(2));
      });
      layer.append(g);
    }

    /**
     * 轴线：两个人之间那条连线。画出来才有意义 ——
     * "别越轴"这句话对着一张空白俯视图是没法执行的，
     * 而线一画出来，"机位别跨过这条线"就是看得见的一件事。
     */
    if (subjects.length >= 2) {
      layer.append(el('line', {
        x1: s.x(subjects[0].x), y1: s.y(subjects[0].y),
        x2: s.x(subjects[1].x), y2: s.y(subjects[1].y),
        class: 'previz-line'
      }));
    }

    /**
     * ── 太阳 ──
     *
     * 外景真正把几镜钉在一起的是**光**，不是地标 —— 一片海滩上没有门窗桌椅。
     * 上一镜逆光、这一镜顺光，观众读出来是"这两镜不是同一时间拍的"。
     */
    if (stage.sun && Number.isFinite(Number(stage.sun.deg))) {
      const [sx, sy] = rimAt(stage.sun.deg);
      const sg = el('g');
      sg.append(el('circle', { cx: sx, cy: sy, r: 11, class: 'previz-sun' }));
      const stx = el('text', { x: sx, y: sy + 4, class: 'previz-sun-label', 'pointer-events': 'none' });
      stx.append(document.createTextNode('☀'));
      sg.append(stx);
      draggableAngle(sg.firstChild, (deg) => { stage.sun = { ...stage.sun, deg }; });
      layer.append(sg);
    }

    // ── 机位 ──
    if (cam) {
      const g = el('g');
      // 视野扇形：朝向主体。机位本身不单独存朝向 —— 摄影机总是对着主体，
      // 多存一个角度只会多一个能和事实对不上的字段
      const main = subjects[0];
      if (main) {
        const ang = Math.atan2(main.x - cam.x, main.y - cam.y);
        const half = 0.42; // 视野张角的一半（弧度），只是示意，不参与计算
        const r = size * 0.34;
        const p1 = [s.x(cam.x) + Math.sin(ang - half) * r, s.y(cam.y) - Math.cos(ang - half) * r];
        const p2 = [s.x(cam.x) + Math.sin(ang + half) * r, s.y(cam.y) - Math.cos(ang + half) * r];
        g.append(el('path', {
          d: `M ${s.x(cam.x)} ${s.y(cam.y)} L ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} Z`,
          class: 'previz-fov',
          'pointer-events': 'none'
        }));
      }
      const dot = el('circle', { cx: s.x(cam.x), cy: s.y(cam.y), r: 11, class: 'previz-cam' });
      draggable(dot, (mx, my) => {
        cam.x = Number(mx.toFixed(2));
        cam.y = Number(my.toFixed(2));
      });
      g.append(dot);
      /**
       * pointer-events 写成**属性**，不靠样式表。
       *
       * 这个标签盖在机位圆点正上方。样式表里那条 `pointer-events:none` 一旦
       * 没加载上（或者被别处覆盖），它就会把按下的那一下吞掉 ——
       * 表现是"拖不动"，而画面看起来完全正常，谁也想不到是一个字挡住的。
       * 行为不该依赖样式表：属性跟着元素走，样式表可以缺席。
       */
      const tag = el('text', {
        x: s.x(cam.x), y: s.y(cam.y) + 4, class: 'previz-label-cam', 'pointer-events': 'none'
      });
      tag.append(document.createTextNode('机'));
      g.append(tag);
      layer.append(g);
    }

    // ── 人 ──
    for (const sub of subjects) {
      const g = el('g');
      // 朝向那根小棍。拖它的头就是转身 —— 比填一个角度数字直观得多
      const rad = ((Number(sub.facing) || 0) * Math.PI) / 180;
      const tipM = { x: clampM(sub.x + Math.sin(rad) * 1.1), y: clampM(sub.y + Math.cos(rad) * 1.1) };
      g.append(el('line', {
        x1: s.x(sub.x), y1: s.y(sub.y), x2: s.x(tipM.x), y2: s.y(tipM.y), class: 'previz-facing'
      }));
      const tip = el('circle', { cx: s.x(tipM.x), cy: s.y(tipM.y), r: 7, class: 'previz-tip' });
      draggable(tip, (mx, my) => {
        const dx = mx - sub.x;
        const dy = my - sub.y;
        if (Math.hypot(dx, dy) < 0.05) return; // 拖到人身上时角度是没有定义的，别乱跳
        sub.facing = Math.round((Math.atan2(dx, dy) * 180) / Math.PI);
      });
      g.append(tip);

      const dot = el('circle', { cx: s.x(sub.x), cy: s.y(sub.y), r: 13, class: 'previz-sub' });
      draggable(dot, (mx, my) => {
        sub.x = Number(mx.toFixed(2));
        sub.y = Number(my.toFixed(2));
      });
      g.append(dot);

      // 同上：名字标签不能挡住底下那个可拖的圆点
      const t = el('text', { x: s.x(sub.x), y: s.y(sub.y) + 4, class: 'previz-label', 'pointer-events': 'none' });
      t.append(document.createTextNode((sub.name || '?').slice(0, 2)));
      g.append(t);
      layer.append(g);
    }
  }

  redraw();
  return { node: svg, redraw };
}

/**
 * 轻量 3D 导演画布。
 *
 * 不引入 Three.js：预演台同时跑在桌面、浏览器和手机壳里，离线也必须能开。
 * 这里用等距投影把同一份米制坐标画成立体舞台；拖动仍落回地面 x/y，因而
 * 越轴、景别、继承和最终提示词继续读取原来的 stage 数据，不会出现两套真相。
 */
export function director3dCanvas(stage, {
  size = 520, onChange = () => {}, onSelect = () => {}, onCommit = () => {}, selected = () => '', onAssetDrop = () => {}
} = {}) {
  normalizeStage(stage);
  const svg = el('svg', {
    viewBox: `0 0 ${size} ${Math.round(size * 0.72)}`,
    class: 'previz-canvas previz-3d',
    style: `width:100%;max-width:${size}px;aspect-ratio:1.38;touch-action:none;user-select:none`
  });
  const height = Math.round(size * 0.72);
  const k = size / (EXTENT * 2.55);
  const ox = size / 2;
  const oy = height * 0.68;
  const project = (x, y, z = 0) => ({
    x: ox + (Number(x) - Number(y)) * k * 0.78,
    y: oy + (Number(x) + Number(y)) * k * 0.38 - Number(z) * k
  });
  const unproject = (px, py) => {
    const a = (px - ox) / (k * 0.78);
    const b = (py - oy) / (k * 0.38);
    return { x: clampM((a + b) / 2), y: clampM((b - a) / 2) };
  };

  svg.append(el('rect', { x: 0, y: 0, width: size, height, class: 'previz-3d-sky' }));
  svg.addEventListener('dragover', (ev) => { ev.preventDefault(); svg.classList.add('drag-over'); });
  svg.addEventListener('dragleave', () => svg.classList.remove('drag-over'));
  svg.addEventListener('drop', (ev) => {
    ev.preventDefault(); svg.classList.remove('drag-over');
    try {
      const asset = JSON.parse(ev.dataTransfer.getData('application/x-futuredream-asset'));
      const rect = svg.getBoundingClientRect();
      const p = unproject(((ev.clientX - rect.left) / rect.width) * size, ((ev.clientY - rect.top) / rect.height) * height);
      onAssetDrop(asset, p);
    } catch { /* 不是本应用的资产，忽略 */ }
  });
  const floor = el('g');
  const layer = el('g');
  svg.append(floor, layer);

  for (let m = -EXTENT; m <= EXTENT; m += 1) {
    const xa = project(m, -EXTENT), xb = project(m, EXTENT);
    const ya = project(-EXTENT, m), yb = project(EXTENT, m);
    floor.append(el('line', { x1: xa.x, y1: xa.y, x2: xb.x, y2: xb.y, class: m === 0 ? 'previz-3d-axis' : 'previz-3d-grid' }));
    floor.append(el('line', { x1: ya.x, y1: ya.y, x2: yb.x, y2: yb.y, class: m === 0 ? 'previz-3d-axis' : 'previz-3d-grid' }));
  }

  function draggable(node, target) {
    node.style.cursor = target.locked ? 'not-allowed' : 'grab';
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onSelect(target.id);
      if (target.locked) return;
      node.setPointerCapture(ev.pointerId);
      const rect = svg.getBoundingClientRect();
      const move = (e) => {
        const px = ((e.clientX - rect.left) / rect.width) * size;
        const py = ((e.clientY - rect.top) / rect.height) * height;
        const p = unproject(px, py);
        target.x = Number(p.x.toFixed(2));
        target.y = Number(p.y.toFixed(2));
        redraw();
        onChange();
      };
      const up = () => {
        node.releasePointerCapture(ev.pointerId);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
        onCommit();
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
    });
  }

  function labelAt(text, p, cls = 'previz-3d-label') {
    const t = el('text', { x: p.x, y: p.y, class: cls, 'pointer-events': 'none' });
    t.append(document.createTextNode(text));
    return t;
  }

  function redraw() {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const things = [
      ...(stage.marks || []).filter((x) => !x.far).map((item) => ({ type: 'prop', item })),
      ...(stage.subjects || []).map((item) => ({ type: 'subject', item })),
      ...(stage.cam ? [{ type: 'camera', item: stage.cam }] : [])
    ].sort((a, b) => (a.item.x + a.item.y) - (b.item.x + b.item.y));

    for (const thing of things) {
      const item = thing.item;
      const base = project(item.x, item.y, 0);
      const g = el('g');
      g.dataset.objectId = item.id;
      if (selected() === item.id) g.classList.add('selected');
      if (item.locked) g.classList.add('locked');
      if (thing.type === 'subject') {
        const bodyH = Number(item.height || 1.72);
        const waist = project(item.x, item.y, bodyH * 0.48);
        const head = project(item.x, item.y, bodyH * 0.88);
        g.append(el('ellipse', { cx: base.x, cy: base.y + 3, rx: 15, ry: 7, class: 'previz-3d-shadow' }));
        g.append(el('path', { d: `M ${base.x - 10} ${base.y} L ${waist.x - 8} ${waist.y} L ${waist.x + 8} ${waist.y} L ${base.x + 10} ${base.y} Z`, class: 'previz-3d-person' }));
        g.append(el('circle', { cx: head.x, cy: head.y, r: 10, class: 'previz-3d-head' }));
        g.append(labelAt((item.name || '?').slice(0, 4), { x: head.x, y: head.y - 15 }));
        draggable(g, item);
      } else if (thing.type === 'camera') {
        const top = project(item.x, item.y, Number(item.height || 1.6));
        g.append(el('line', { x1: base.x, y1: base.y, x2: top.x, y2: top.y, class: 'previz-3d-tripod' }));
        g.append(el('path', { d: `M ${top.x - 15} ${top.y - 9} h 23 l 12 8 -12 8 h -23 Z`, class: 'previz-3d-camera' }));
        g.append(labelAt('摄影机', { x: top.x, y: top.y - 16 }, 'previz-3d-label cam'));
        draggable(g, item);
      } else {
        const h = Number(item.height || (['门', '窗'].includes(item.name) ? 2.1 : 0.9));
        const w = Number(item.width || 0.9);
        const a = project(item.x - w / 2, item.y, 0);
        const b = project(item.x + w / 2, item.y, 0);
        const at = project(item.x - w / 2, item.y, h);
        const bt = project(item.x + w / 2, item.y, h);
        g.append(el('path', { d: `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${bt.x} ${bt.y} L ${at.x} ${at.y} Z`, class: 'previz-3d-prop' }));
        g.append(labelAt((item.name || '道具').slice(0, 4), { x: (at.x + bt.x) / 2, y: (at.y + bt.y) / 2 - 8 }));
        draggable(g, item);
      }
      layer.append(g);
    }
  }

  redraw();
  return { node: svg, redraw };
}

/**
 * 常用运镜。六个数字直接摆出来没人填得动，而这几个覆盖了绝大多数镜头。
 * 高级用法（同时横移 + 推近）仍然可以在下面那排数字里调。
 */
export const MOVE_PRESETS = [
  { id: 'static', label: '固定', move: {} },
  { id: 'push', label: '推近', move: { zoom: -4 } },
  { id: 'pull', label: '拉远', move: { zoom: 4 } },
  { id: 'left', label: '左移', move: { horizontal: -4 } },
  { id: 'right', label: '右移', move: { horizontal: 4 } },
  { id: 'up', label: '上升', move: { vertical: 4 } },
  { id: 'tiltup', label: '上摇', move: { pan: 4 } },
  { id: 'panright', label: '右摇', move: { tilt: 4 } }
];

/** 常用焦段。给一排按钮而不是自由输入 —— 镜头本来就是一档一档的 */
export const LENSES = [24, 35, 50, 85, 135];

/** 一个还没排过位的镜头，从哪儿开始。人在中间、机位在正前方三米 */
export function blankStage(names = []) {
  const list = (names.length ? names : ['主体']).slice(0, 4);
  return normalizeStage({
    cam: { x: 0, y: -3, height: 1.6, lens: 35, move: {} },
    subjects: list.map((name, i) => ({
      name,
      x: Number((((i - (list.length - 1) / 2) * 1.2)).toFixed(2)),
      y: 0,
      // 默认面向机位：绝大多数镜头人是朝着镜头那一侧的，
      // 默认背对的话每一镜都要先转个身
      facing: 180
    }))
  });
}

/** 摄影机真正会看到的简化取景框；用相同米制数据即时计算，不另存一份构图。 */
export function cameraViewport(stage, { width = 480 } = {}) {
  normalizeStage(stage);
  const height = Math.round(width * 9 / 16);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'previz-camera-view' });
  const bg = el('rect', { x: 0, y: 0, width, height, class: 'previz-camera-bg' });
  const layer = el('g');
  svg.append(bg, layer);
  function redraw() {
    layer.replaceChildren();
    const cam = stage.cam;
    const target = stage.subjects[0] || { x: 0, y: 0 };
    const look = Math.atan2(target.y - cam.y, target.x - cam.x);
    const focal = Math.max(24, Number(cam.lens || 35));
    const horizon = height * (0.52 + (Number(cam.height || 1.6) - 1.6) * .04);
    layer.append(el('line', { x1: 0, y1: horizon, x2: width, y2: horizon, class: 'previz-camera-horizon' }));
    const visible = [];
    for (const entry of stageObjects(stage).filter((x) => x.kind !== 'camera')) {
      const dx = Number(entry.item.x) - Number(cam.x), dy = Number(entry.item.y) - Number(cam.y);
      const depth = dx * Math.cos(look) + dy * Math.sin(look);
      const side = -dx * Math.sin(look) + dy * Math.cos(look);
      if (depth <= .15) continue;
      visible.push({ ...entry, depth, side });
    }
    visible.sort((a, b) => b.depth - a.depth);
    for (const entry of visible) {
      const scale = Math.min(3, focal / 35 * 3.4 / entry.depth) * Number(entry.item.scale || 1);
      const x = width / 2 + entry.side * width * .16 * scale;
      const h = Math.max(14, Number(entry.item.height || 1) * height * .24 * scale);
      const y = horizon - h * .12;
      const node = entry.kind === 'subject'
        ? el('rect', { x: x - h * .16, y: y - h, width: h * .32, height: h, rx: h * .14, class: 'previz-camera-subject' })
        : el('rect', { x: x - h * .3, y: y - h * .75, width: h * .6, height: h * .75, class: 'previz-camera-prop' });
      layer.append(node, labelAtViewport(entry.item.name || '道具', x, Math.max(14, y - h - 5)));
    }
    layer.append(el('path', { d: `M ${width / 2 - 10} ${height / 2} h 20 M ${width / 2} ${height / 2 - 10} v 20`, class: 'previz-camera-cross' }));
  }
  function labelAtViewport(text, x, y) {
    const t = el('text', { x, y, class: 'previz-camera-label' });
    t.textContent = String(text).slice(0, 6);
    return t;
  }
  redraw();
  return { node: svg, redraw };
}

/**
 * 整块面板：画布 + 焦段 + 高度 + 运镜 + **实时读数**。
 *
 * 读数是这块面板真正的产出。拖动的时候人要立刻看到
 * "现在是近景、机位在他背后、越轴了"——
 * 排完位再去别处查等于没有预演，那正是这个功能要消灭的往返。
 *
 * 算读数用的是**流水线自己那份 previz.js**（服务端按 /previz.js 原样发过来），
 * 所以这里显示的和最终写进提示词的是同一套算法，不可能对不上。
 */
export function previzPanel(stage, {
  size = 320, onChange = () => {}, prevStage = null,
  duration = 5, assets = [],
  /** 这一镜属于哪个场景。给了才摆得出"存成这个场景的默认布局"那颗按钮 */
  scene = '',
  /** 存：把地标和光位挂到设定集的场景上。回一个 Promise */
  onSaveScene = null,
  /** 套用：把那个场景已经存过的布局搬过来 */
  sceneLayout = null,
  onExportControls = null
} = {}) {
  normalizeStage(stage);
  const host = document.createElement('div');
  host.className = 'previz-panel';

  const history = createHistory(stage);
  let selectedId = stage.cam.id;

  const redrawAll = () => { canvas.redraw(); director.redraw(); viewport.redraw(); refresh(); paintInspector(); paintTimeline(); };
  const canvas = blockingCanvas(stage, { size, onChange: () => { director.redraw(); refresh(); onChange(); } });
  const director = director3dCanvas(stage, {
    size: Math.max(460, size), selected: () => selectedId,
    onSelect: (id) => { selectedId = id; redrawAll(); },
    onCommit: () => { history.commit(); paintInspector(); onChange(); },
    onAssetDrop: (asset, p) => {
      if (asset.kind === 'scene') stage.backdrop = { name: asset.name, image: asset.image || '' };
      else if (asset.kind === 'character') stage.subjects.push({ name: asset.name, x: p.x, y: p.y, facing: 180, height: 1.72, assetRef: asset.ref, thumbnail: asset.image });
      else stage.marks.push({ name: asset.name, x: p.x, y: p.y, height: .9, width: .9, assetRef: asset.ref, thumbnail: asset.image });
      normalizeStage(stage);
      history.commit(); redrawAll(); onChange();
    },
    onChange: () => { canvas.redraw(); refresh(); onChange(); }
  });
  const viewport = cameraViewport(stage, { width: Math.max(460, size) });
  canvas.node.hidden = true;
  const viewBar = document.createElement('div');
  viewBar.className = 'previz-viewbar';
  const viewHint = Object.assign(document.createElement('span'), {
    className: 'field-hint', textContent: '拖人物、道具和摄影机；所有位置都按米保存，并与俯视图实时同步'
  });
  const switchView = (mode) => {
    director.node.hidden = mode !== '3d';
    canvas.node.hidden = mode === '3d';
    for (const b of viewBar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  };
  for (const [mode, label] of [['3d', '3D 导演画布'], ['top', '俯视排位']]) {
    const b = document.createElement('button');
    b.className = `btn ghost sm${mode === '3d' ? ' on' : ''}`;
    b.dataset.mode = mode;
    b.textContent = label;
    b.onclick = () => switchView(mode);
    viewBar.append(b);
  }
  viewBar.append(viewHint);
  const undoBtn = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '撤销' });
  const redoBtn = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '重做' });
  undoBtn.onclick = () => { if (history.undo()) { redrawAll(); onChange(); } };
  redoBtn.onclick = () => { if (history.redo()) { redrawAll(); onChange(); } };
  viewBar.append(undoBtn, redoBtn);
  const readout = document.createElement('div');
  readout.className = 'previz-readout';

  const btn = (label, active, on) => {
    const b = document.createElement('button');
    b.className = `btn ghost sm${active ? ' on' : ''}`;
    b.textContent = label;
    b.onclick = () => { on(); rebuildControls(); redrawAll(); onChange(); };
    return b;
  };

  const controls = document.createElement('div');
  controls.className = 'previz-controls';
  const inspector = document.createElement('div');
  inspector.className = 'previz-inspector';
  const timeline = document.createElement('div');
  timeline.className = 'previz-timeline';
  let currentFrame = 0;
  const assetShelf = document.createElement('div');
  assetShelf.className = 'previz-assets';
  if (assets.length) {
    assetShelf.append(Object.assign(document.createElement('b'), { textContent: '项目资产 · 拖到 3D 画布' }));
    for (const asset of assets) {
      const card = document.createElement('div');
      card.className = 'previz-asset'; card.draggable = true; card.title = `拖入${asset.kind === 'character' ? '人物' : asset.kind === 'scene' ? '场景' : '道具'}：${asset.name}`;
      if (asset.image) card.append(Object.assign(document.createElement('img'), { src: asset.image, alt: asset.name }));
      card.append(Object.assign(document.createElement('span'), { textContent: asset.name }));
      card.ondragstart = (ev) => ev.dataTransfer.setData('application/x-futuredream-asset', JSON.stringify(asset));
      assetShelf.append(card);
    }
  }
  const controlShelf = document.createElement('div');
  controlShelf.className = 'previz-control-shelf';
  if (onExportControls) {
    const exportBtn = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '输出可控视频控制包' });
    exportBtn.onclick = async () => {
      exportBtn.disabled = true; exportBtn.textContent = '正在输出…';
      try {
        const maps = await onExportControls(stage);
        controlShelf.replaceChildren(exportBtn);
        for (const [key, label] of [['start', '首帧'], ['end', '尾帧'], ['depth', '深度图'], ['pose', '人物姿态'], ['edge', '边缘图'], ['mask', '对象遮罩']]) {
          if (!maps?.[key]) continue;
          const card = document.createElement('a'); card.className = 'previz-control'; card.href = maps[key]; card.target = '_blank';
          card.append(Object.assign(document.createElement('img'), { src: maps[key], alt: label }), Object.assign(document.createElement('span'), { textContent: label }));
          controlShelf.append(card);
        }
      } finally { exportBtn.disabled = false; exportBtn.textContent = '重新输出控制包'; }
    };
    controlShelf.append(exportBtn);
  }

  function paintInspector() {
    inspector.replaceChildren();
    undoBtn.disabled = !history.canUndo;
    redoBtn.disabled = !history.canRedo;
    const found = findObject(stage, selectedId);
    if (!found) return;
    const item = found.item;
    const title = Object.assign(document.createElement('b'), {
      textContent: `${found.kind === 'camera' ? '摄影机' : item.name || '对象'} · ${item.id}`
    });
    const makeNumber = (label, key, step = '0.1') => {
      const input = Object.assign(document.createElement('input'), {
        type: 'number', step, value: String(item[key] ?? 0), disabled: item.locked
      });
      input.onchange = () => {
        item[key] = Number(input.value);
        if (key === 'rotation' && found.kind === 'subject') item.facing = item.rotation;
        history.commit(); redrawAll(); onChange();
      };
      const wrap = document.createElement('label');
      wrap.append(document.createTextNode(label), input);
      return wrap;
    };
    const lock = Object.assign(document.createElement('button'), {
      className: `btn ghost sm${item.locked ? ' on' : ''}`, textContent: item.locked ? '🔒 已锁定' : '🔓 锁定'
    });
    lock.onclick = () => { item.locked = !item.locked; history.commit(); redrawAll(); onChange(); };
    inspector.append(title, makeNumber('X', 'x'), makeNumber('Y', 'y'), makeNumber('高度', 'height'),
      makeNumber('旋转°', 'rotation', '1'), makeNumber('缩放', 'scale'), lock);
  }

  function paintTimeline() {
    timeline.replaceChildren();
    const maxFrame = Math.max(24, Math.round(Number(duration || 5) * 24));
    const range = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: String(maxFrame), value: String(currentFrame) });
    const frame = Object.assign(document.createElement('b'), { textContent: `${currentFrame}f / ${maxFrame}f` });
    range.oninput = () => {
      currentFrame = Number(range.value);
      frame.textContent = `${currentFrame}f / ${maxFrame}f`;
      if ((stage.keyframes || []).length) {
        applyFrame(stage, currentFrame);
        canvas.redraw(); director.redraw(); viewport.redraw(); paintInspector();
      }
    };
    const add = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '＋记录关键帧' });
    add.onclick = () => { addKeyframe(stage, currentFrame); history.commit(); paintTimeline(); onChange(); };
    timeline.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '24fps 时间轴' }), range, frame, add);
    for (const kf of stage.keyframes || []) {
      const jump = Object.assign(document.createElement('button'), { className: 'previz-key', textContent: `${kf.frame}f` });
      jump.onclick = () => { currentFrame = kf.frame; paintTimeline(); };
      timeline.append(jump);
    }
  }

  function rebuildControls() {
    while (controls.firstChild) controls.removeChild(controls.firstChild);

    const lensRow = document.createElement('div');
    lensRow.className = 'previz-row';
    lensRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '焦段' }));
    for (const mm of LENSES) {
      lensRow.append(btn(`${mm}`, Number(stage.cam.lens) === mm, () => { stage.cam.lens = mm; }));
    }
    controls.append(lensRow);

    const hRow = document.createElement('div');
    hRow.className = 'previz-row';
    hRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '机位高' }));
    for (const [label, h] of [['地面 0.4', 0.4], ['齐胸 1.2', 1.2], ['齐眼 1.6', 1.6], ['举高 2.4', 2.4]]) {
      hRow.append(btn(label, Number(stage.cam.height) === h, () => { stage.cam.height = h; }));
    }
    controls.append(hRow);

    /**
     * ── 地标那一排 ──
     *
     * 门窗桌椅是**场景的骨架**：人物走位再准，窗一会儿在画面左、一会儿在右，
     * 这场戏的空间就塌了。摆一次就够 —— 同一场次的后面几镜会原样继承，
     * 因为它们不会因为换了个机位就搬家。
     */
    const markRow = document.createElement('div');
    markRow.className = 'previz-row';
    markRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '地标' }));
    for (const name of ['门', '窗', '桌', '床', '楼梯', '椅', '沙发', '车', '剑']) {
      const has = (stage.marks || []).some((m) => m.name === name);
      markRow.append(btn(name, has, () => {
        stage.marks = stage.marks || [];
        if (has) stage.marks = stage.marks.filter((m) => m.name !== name);
        // 新地标先摆在场地边上，等着被拖到该在的位置
        else stage.marks.push({ name, x: (stage.marks.length % 2 ? 1 : -1) * 2.5, y: 2 });
      }));
    }
    markRow.append(Object.assign(document.createElement('span'), {
      className: 'previz-cap',
      style: 'min-width:0',
      textContent: '摆上就能算出"窗在画面哪边"'
    }));
    controls.append(markRow);

    /**
     * ── 外景那一排 ──
     *
     * 外景没有门窗桌椅，钉住空间的是**远处那几样**（山、塔、海）和**光**。
     * 它们和近处地标在数学上完全不同：只有方位，没有坐标 ——
     * 机位挪三米，一座山在画面里纹丝不动。所以它们摆在画布边上，绕着圈拖。
     */
    const farRow = document.createElement('div');
    farRow.className = 'previz-row';
    farRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '远景' }));
    // 名字这一份和场地图共用（previz.FAR_PRESETS）—— 跨场景那条检查是按名字配对的，
    // 两边各写各的清单，它就永远配不上对，而界面上两边都摆得好好的
    for (const { name, deg } of previz.FAR_PRESETS) {
      const has = (stage.marks || []).some((m) => m.far && m.name === name);
      farRow.append(btn(name, has, () => {
        stage.marks = stage.marks || [];
        if (has) stage.marks = stage.marks.filter((m) => !(m.far && m.name === name));
        else stage.marks.push({ name, far: true, deg });
      }));
    }
    controls.append(farRow);

    const sunRow = document.createElement('div');
    sunRow.className = 'previz-row';
    sunRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '光位' }));
    sunRow.append(btn(stage.sun ? '有太阳' : '加太阳', Boolean(stage.sun), () => {
      stage.sun = stage.sun ? null : { deg: -45, elev: 'low' };
    }));
    if (stage.sun) {
      for (const [label, id] of [['早晚斜射', 'low'], ['中等', 'mid'], ['正午顶光', 'high']]) {
        sunRow.append(btn(label, stage.sun.elev === id, () => { stage.sun = { ...stage.sun, elev: id }; }));
      }
    }
    sunRow.append(Object.assign(document.createElement('span'), {
      className: 'previz-cap',
      style: 'min-width:0',
      textContent: '拖边上那个 ☀ 定方向'
    }));
    controls.append(sunRow);

    /**
     * ── 一个场景摆一次 ──
     *
     * 逐镜继承只在**同一场次连着的那几镜**里管用。可同一个场景往往会反复回来：
     * 第 3 镜在码头、第 11 镜又回码头、第 20 镜还在码头。中间隔着别的场次，
     * 继承那条链早断了 —— 于是同一个码头被摆了三遍，三遍的灯塔在不同方位、
     * 太阳在不同高度。而**观众记得住地方**：同一个码头三种长相，
     * 比任何一处越轴都刺眼。
     *
     * ⚠ 存的是**房间**，不是机位：只存地标和光位，不存机位和人的站位。
     * 一起存的话每一镜都从同一个机位开始，那等于把二十镜拍成同一张画。
     */
    if (scene && (onSaveScene || sceneLayout)) {
      const sceneRow = document.createElement('div');
      sceneRow.className = 'previz-row';
      sceneRow.append(Object.assign(document.createElement('span'),
        { className: 'previz-cap', textContent: '场景' }));
      if (onSaveScene) {
        const save = document.createElement('button');
        save.className = 'btn ghost sm';
        save.textContent = `存成「${scene}」的默认布局`;
        save.title = '只存地标和光位（房间长什么样），不存机位和站位。'
          + '所有用到这个场景的镜头都会从这一份起步 —— 哪怕隔着十几镜、跨了场次';
        save.onclick = async () => {
          save.disabled = true;
          const old = save.textContent;
          save.textContent = '存…';
          // cap:scene-layout
          try { await onSaveScene({ marks: stage.marks || [], sun: stage.sun || null }); } finally {
            save.disabled = false;
            save.textContent = old;
          }
        };
        sceneRow.append(save);
      }
      if (sceneLayout && (sceneLayout.marks?.length || sceneLayout.sun)) {
        const apply = document.createElement('button');
        apply.className = 'btn ghost sm';
        apply.textContent = '套用这个场景的布局';
        apply.title = '把这个场景存过的地标和光位搬过来。机位和站位不动';
        apply.onclick = () => {
          stage.marks = (sceneLayout.marks || []).map((m) => ({ ...m }));
          stage.sun = sceneLayout.sun ? { ...sceneLayout.sun } : null;
          rebuildControls();
          redrawAll();
          onChange();
        };
        sceneRow.append(apply);
      }
      controls.append(sceneRow);
    }

    const mRow = document.createElement('div');
    mRow.className = 'previz-row';
    mRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '运镜' }));
    const now = previz.normalizeMove(stage.cam.move);
    for (const p of MOVE_PRESETS) {
      const want = previz.normalizeMove(p.move);
      const same = previz.MOVE_KEYS.every((k) => now[k] === want[k]);
      mRow.append(btn(p.label, same, () => { stage.cam.move = { ...p.move }; }));
    }
    controls.append(mRow);
  }

  function refresh() {
    while (readout.firstChild) readout.removeChild(readout.firstChild);
    const read = previz.readShot(stage);
    const name = stage.subjects?.[0]?.name || '人物';

    const line = document.createElement('div');
    line.className = 'previz-line-text';
    line.textContent = previz.toChinese(read, { subjectName: name });
    readout.append(line);

    const chips = document.createElement('div');
    chips.className = 'previz-chips';
    const chip = (text, cls = '') => {
      const c = document.createElement('span');
      c.className = `badge${cls ? ` ${cls}` : ''}`;
      c.textContent = text;
      return c;
    };
    if (read.size) chips.append(chip(`${read.size.label} · 画面装得下 ${read.size.framedHeight} 米`));
    if (read.facing) chips.append(chip(`看到的是${read.facing.label}（${read.facing.deg}°）`));
    chips.append(chip(read.height.label));
    if (read.distance !== null) chips.append(chip(`距离 ${read.distance} 米`));
    /**
     * 方位那两个字要**当场显示**。
     *
     * "机位在人物右前方"是相对人的 —— 人一转身它就指向房间里别的地方。
     * "机位在场景西南侧、朝东北拍"是相对房间的，房间不会转，
     * 所以它才是同一场戏里每一镜都对得上的那句话。
     */
    const f = previz.framing(stage);
    if (f) {
      chips.append(chip(`场景${f.camAt}侧 · 朝${f.looking}拍`));
      for (const m of f.marks) {
        if (!m.side) continue;
        chips.append(chip(`${m.name}${m.far ? '（远）' : ''}：${m.side}`, m.side === '画外' ? '' : 'ok'));
      }
      // 外景把几镜钉在一起的主要是光，不是地标 —— 它得摆在能看见的地方
      if (f.light) {
        chips.append(chip(`${f.light.kind}${f.light.from ? ` · 光从${f.light.from}` : ''}`, 'ok'));
      }
    }
    readout.append(chips);

    /**
     * 越轴当场报。
     *
     * 这是这块面板最值钱的一条：越轴在成片里的表现是"两个人左右对调"，
     * 逐镜看每一张都没问题，只有连起来放才露馅 —— 而那时候钱已经花完了。
     * 现在它在你拖动机位的**那一刻**就红给你看。
     */
    if (prevStage?.cam) {
      const prevRead = previz.readShot(prevStage);
      if (previz.crossesAxis(prevRead, read)) {
        const warn = document.createElement('div');
        warn.className = 'previz-warn';
        warn.textContent = '⚠ 越轴了：机位跨到了轴线另一侧。成片上会看到两个人左右对调，或者人物突然掉头。把机位挪回同一侧。';
        readout.append(warn);
      }
      /**
       * 越轴之外那四条也当场报：摆太狠、摆太少（跳切）、景别跳太远、
       * 参照物换边。判断走 previz.continuityIssues —— 和分镜体检是同一份，
       * 两处各写一份的话，画布说没事、体检说有事，谁也不信谁。
       */
      for (const one of previz.continuityIssues(prevStage, stage)) {
        const warn = document.createElement('div');
        warn.className = 'previz-warn';
        warn.textContent = `⚠ ${one.what}。${one.fix}`;
        warn.title = one.why;
        readout.append(warn);
      }
    }
  }

  rebuildControls();
  refresh();
  paintInspector();
  paintTimeline();
  const viewWrap = document.createElement('div');
  viewWrap.className = 'previz-workspace';
  viewWrap.append(director.node, Object.assign(document.createElement('div'), { className: 'previz-camera-pane' }));
  viewWrap.lastChild.append(Object.assign(document.createElement('b'), { textContent: '摄影机取景' }), viewport.node);
  host.append(viewBar, assetShelf, viewWrap, canvas.node, inspector, timeline, controlShelf, controls, readout);
  return { node: host, refresh };
}

