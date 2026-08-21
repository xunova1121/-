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

  function redraw() {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const subjects = stage.subjects || [];
    const cam = stage.cam;

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
  return {
    cam: { x: 0, y: -3, height: 1.6, lens: 35, move: {} },
    subjects: list.map((name, i) => ({
      name,
      x: Number((((i - (list.length - 1) / 2) * 1.2)).toFixed(2)),
      y: 0,
      // 默认面向机位：绝大多数镜头人是朝着镜头那一侧的，
      // 默认背对的话每一镜都要先转个身
      facing: 180
    }))
  };
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
export function previzPanel(stage, { size = 320, onChange = () => {}, prevStage = null } = {}) {
  const host = document.createElement('div');
  host.className = 'previz-panel';

  const canvas = blockingCanvas(stage, { size, onChange: () => { refresh(); onChange(); } });
  const readout = document.createElement('div');
  readout.className = 'previz-readout';

  const btn = (label, active, on) => {
    const b = document.createElement('button');
    b.className = `btn ghost sm${active ? ' on' : ''}`;
    b.textContent = label;
    b.onclick = () => { on(); rebuildControls(); canvas.redraw(); refresh(); onChange(); };
    return b;
  };

  const controls = document.createElement('div');
  controls.className = 'previz-controls';

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
    }
  }

  rebuildControls();
  refresh();
  host.append(canvas.node, controls, readout);
  return { node: host, refresh };
}
