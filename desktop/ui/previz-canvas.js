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
import * as THREE from '/three.js';
import { GLTFLoader } from '/three-gltf-loader.js';
import { OrbitControls } from '/three-orbit-controls.js';
import { TransformControls } from '/three-transform-controls.js';
import { clone as cloneSkeleton } from '/three-skeleton-utils.js';
import { addKeyframe, applyFrame, attachmentPose, createHistory, findObject, normalizeStage, snapToGround, spatialIssues, stageObjects } from './previz-stage.js';

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

/** 把一张人物设定集切成可供贴片使用的单个视图，支持常见横排与 2×2 排版。 */
export function quadTextureTransform(item, viewName) {
  const order = Array.isArray(item.textureOrder) && item.textureOrder.length === 4
    ? item.textureOrder : ['closeup', 'front', 'side', 'back'];
  const panel = Math.max(0, order.indexOf(viewName));
  const inset = Math.max(0, Math.min(.08, Number(item.textureInset || 0)));
  if (item.textureGrid === '2x2') {
    const col = panel % 2, row = Math.floor(panel / 2);
    return {
      repeatX: .5 - inset * 2, repeatY: .5 - inset * 2,
      offsetX: col * .5 + inset, offsetY: (1 - row) * .5 + inset
    };
  }
  return { repeatX: .25 - inset * 2, repeatY: 1 - inset * 2, offsetX: panel * .25 + inset, offsetY: inset };
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

    // 无 WebGL 的降级画布也要看得见场景资产，而不是退回一张空坐标纸。
    if (stage.backdrop?.image) {
      layer.append(el('image', {
        href: stage.backdrop.image, x: 0, y: 0, width: size, height: size,
        preserveAspectRatio: 'none', class: 'previz-top-backdrop', 'pointer-events': 'none'
      }));
      layer.append(el('rect', { x: 0, y: 0, width: size, height: size, class: 'previz-top-shade', 'pointer-events': 'none' }));
    }

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
      const attached = attachmentPose(stage, mk);
      const worldX = Number(attached?.x ?? mk.x ?? 0), worldY = Number(attached?.y ?? mk.y ?? 0);
      const hasTexture = Boolean(mk.textureUrl || mk.thumbnail);
      if (hasTexture) {
        const image = el('image', {
          href: mk.textureUrl || mk.thumbnail, x: s.x(worldX) - 35, y: s.y(worldY) - 55,
          width: 70, height: 70, preserveAspectRatio: 'xMidYMid meet', class: 'previz-top-asset'
        });
        if (!attached) draggable(image, (mx, my) => { mk.x = Number(mx.toFixed(2)); mk.y = Number(my.toFixed(2)); });
        g.append(image);
      }
      const markNode = el('rect', {
        x: s.x(worldX) - 9, y: s.y(worldY) - 9, width: 18, height: 18, rx: 4, class: `previz-mark${hasTexture ? ' textured' : ''}`
      });
      g.append(markNode);
      const t = el('text', { x: s.x(worldX), y: s.y(worldY) + 4, class: 'previz-mark-label', 'pointer-events': 'none' });
      t.append(document.createTextNode((mk.name || '?').slice(0, 2)));
      g.append(t);
      if (!attached) draggable(markNode, (mx, my) => {
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

    for (const light of stage.lights || []) {
      const lg = el('g');
      const target = findObject(stage, light.targetId)?.item || subjects[0];
      if (target) lg.append(el('line', { x1: s.x(light.x), y1: s.y(light.y), x2: s.x(target.x), y2: s.y(target.y), class: 'previz-light-beam', 'pointer-events': 'none' }));
      const dot = el('circle', { cx: s.x(light.x), cy: s.y(light.y), r: 10, class: 'previz-light' });
      draggable(dot, (mx, my) => { light.x = Number(mx.toFixed(2)); light.y = Number(my.toFixed(2)); });
      lg.append(dot);
      const label = el('text', { x: s.x(light.x), y: s.y(light.y) + 4, class: 'previz-light-label', 'pointer-events': 'none' });
      label.append(document.createTextNode('灯')); lg.append(label); layer.append(lg);
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

      const hasTexture = Boolean(sub.textureUrl || sub.thumbnail);
      if (hasTexture) {
        const image = el('image', {
          href: sub.textureUrl || sub.thumbnail, x: s.x(sub.x) - 45, y: s.y(sub.y) - 112,
          width: 90, height: 120, preserveAspectRatio: 'xMidYMax meet', class: 'previz-top-character'
        });
        draggable(image, (mx, my) => { sub.x = Number(mx.toFixed(2)); sub.y = Number(my.toFixed(2)); });
        g.append(image);
      }
      const dot = el('circle', { cx: s.x(sub.x), cy: s.y(sub.y), r: 13, class: `previz-sub${hasTexture ? ' textured' : ''}` });
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
 * Three.js 只作为本地运行时依赖打包，桌面、浏览器和手机壳共用同一份渲染器。
 * 拖动仍落回原有的米制 x/y，因而越轴、景别、继承和生成提示词只有一份真相。
 */
export function director3dCanvas(stage, {
  size = 520, onChange = () => {}, onSelect = () => {}, onCommit = () => {}, selected = () => '',
  onAssetDrop = () => {}, onModelReady = () => {}
} = {}) {
  normalizeStage(stage);
  const host = document.createElement('div');
  host.className = 'previz-canvas previz-3d previz-webgl';
  host.style.cssText = `width:100%;max-width:${size}px;aspect-ratio:1.38;touch-action:none;position:relative;overflow:hidden`;
  // 保留最后一帧，才能把当前预演直接导出为视频模型的首帧参考。
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch {
    const fallback = blockingCanvas(stage, { size, onChange });
    fallback.node.style.width = '100%'; fallback.node.style.height = '100%';
    const note = Object.assign(document.createElement('div'), {
      className: 'previz-gpu-note', textContent: '当前环境未启用 WebGL，已切换为俯视排位；位置、机位和关键帧仍可编辑'
    });
    host.append(fallback.node, note);
    return {
      node: host,
      redraw: fallback.redraw,
      capture: () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(fallback.node))}`
    };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
  host.append(renderer.domElement);
  const scene3d = new THREE.Scene();
  scene3d.background = new THREE.Color(0x151a24);
  scene3d.fog = new THREE.Fog(0x151a24, 14, 30);
  const view = new THREE.PerspectiveCamera(42, 1.38, 0.1, 80);
  view.position.set(9, 8, 10); view.lookAt(0, 0, 0);
  const shotCamera = new THREE.PerspectiveCamera(42, 16 / 9, .05, 200);
  let viewMode = 'director';
  const activeView = () => viewMode === 'shot' ? shotCamera : view;
  const renderNow = () => renderer.render(scene3d, activeView());
  const orbit = new OrbitControls(view, renderer.domElement);
  orbit.target.set(0, 1, 0);
  orbit.enableDamping = false;
  orbit.minDistance = 3; orbit.maxDistance = 28; orbit.maxPolarAngle = Math.PI * .48;
  // 左键留给人物/道具拖拽；右键旋转舞台，中键平移，滚轮缩放。
  orbit.mouseButtons.LEFT = null;
  orbit.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  orbit.touches.ONE = null;
  orbit.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  const transform = new TransformControls(view, renderer.domElement);
  const transformHelper = transform.getHelper();
  scene3d.add(transformHelper);
  let transformMode = 'translate';
  let transforming = false;
  const gizmoBar = document.createElement('div');
  gizmoBar.className = 'previz-gizmo-bar';
  gizmoBar.setAttribute('aria-label', '对象变换工具');
  const gizmoButtons = new Map();
  for (const [mode, label, title] of [
    ['translate', '移动', '沿红绿蓝三轴移动'],
    ['rotate', '旋转', '沿三轴旋转'],
    ['scale', '缩放', '沿三轴缩放']
  ]) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label, title });
    button.className = `previz-gizmo-btn${mode === transformMode ? ' on' : ''}`;
    button.onclick = (event) => {
      event.stopPropagation();
      transformMode = mode;
      transform.setMode(mode);
      for (const [key, node] of gizmoButtons) node.classList.toggle('on', key === mode);
    };
    gizmoButtons.set(mode, button);
    gizmoBar.append(button);
  }
  const viewDivider = Object.assign(document.createElement('span'), { className: 'previz-gizmo-divider' });
  const directorViewBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'previz-gizmo-btn on', textContent: '导演视角' });
  const shotViewBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'previz-gizmo-btn', textContent: '摄影机画面' });
  const shotOverlay = document.createElement('div');
  shotOverlay.className = 'previz-shot-overlay';
  shotOverlay.innerHTML = '<i class="third v1"></i><i class="third v2"></i><i class="third h1"></i><i class="third h2"></i><i class="safe"></i><i class="focus"></i><span>安全框 · 三分构图</span>';
  shotOverlay.hidden = true;
  host.append(shotOverlay);
  const setViewMode = (mode) => {
    viewMode = mode; orbit.enabled = mode === 'director' && !transforming;
    transformHelper.visible = mode === 'director';
    shotOverlay.hidden = mode !== 'shot';
    directorViewBtn.classList.toggle('on', mode === 'director'); shotViewBtn.classList.toggle('on', mode === 'shot');
    renderNow();
  };
  directorViewBtn.onclick = (event) => { event.stopPropagation(); setViewMode('director'); };
  shotViewBtn.onclick = (event) => { event.stopPropagation(); setViewMode('shot'); };
  const backdropBtn = Object.assign(document.createElement('button'), {
    type: 'button', className: 'previz-gizmo-btn', title: '场景设定图可作为环绕摄影棚或平面背景',
    textContent: stage.backdrop?.projection === 'flat' ? '平面场景' : '环绕场景'
  });
  backdropBtn.onclick = (event) => {
    event.stopPropagation();
    if (!stage.backdrop) return;
    stage.backdrop.projection = stage.backdrop.projection === 'flat' ? 'cyclorama' : 'flat';
    backdropBtn.textContent = stage.backdrop.projection === 'flat' ? '平面场景' : '环绕场景';
    onCommit(); redraw();
  };
  gizmoBar.append(viewDivider, directorViewBtn, shotViewBtn, backdropBtn);
  host.append(gizmoBar);
  scene3d.add(new THREE.HemisphereLight(0xbfd8ff, 0x2a2530, 1.5));
  const key = new THREE.DirectionalLight(0xffe3bd, 2.2); key.position.set(-5, 9, -3); key.castShadow = true; scene3d.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ color: 0x29313d, roughness: .92 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene3d.add(floor);
  const grid = new THREE.GridHelper(24, 24, 0x5d7897, 0x384657); grid.position.y = .006; scene3d.add(grid);
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const objects = new Map();
  const textureLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  const modelCache = new Map();
  const mixers = new Map();
  let animationRaf = 0;
  let animationAt = performance.now();
  let capturing = false;
  let backdropObject = null;
  const guides = [];
  const pathHandles = [];

  orbit.addEventListener('change', renderNow);
  transform.setMode(transformMode);
  transform.setTranslationSnap(.05);
  transform.setRotationSnap(THREE.MathUtils.degToRad(1));
  transform.setScaleSnap(.05);
  transform.addEventListener('dragging-changed', (event) => {
    transforming = Boolean(event.value);
    orbit.enabled = !transforming && viewMode === 'director';
  });
  transform.addEventListener('objectChange', () => {
    const obj = transform.object;
    const item = obj?.userData?.item;
    if (!item) return;
    // 挂在人身上的道具编辑的是局部偏移，不能把世界坐标误写回自由摆位坐标。
    if (obj.userData.kind === 'prop' && item.attachToId) return;
    item.x = Number(obj.position.x.toFixed(2));
    item.y = Number(obj.position.z.toFixed(2));
    item.elevation = Number(obj.position.y.toFixed(2));
    item.rotation = Number((-THREE.MathUtils.radToDeg(obj.rotation.y)).toFixed(1));
    item.rotationX = Number(THREE.MathUtils.radToDeg(obj.rotation.x).toFixed(1));
    item.rotationZ = Number(THREE.MathUtils.radToDeg(obj.rotation.z).toFixed(1));
    if (obj.userData.kind === 'subject') item.facing = item.rotation;
    item.scaleX = Number(Math.max(.05, obj.scale.x).toFixed(2));
    item.scaleY = Number(Math.max(.05, obj.scale.y).toFixed(2));
    item.scaleZ = Number(Math.max(.05, obj.scale.z).toFixed(2));
    item.scale = item.scaleX;
    onChange();
    renderNow();
  });
  transform.addEventListener('mouseUp', () => { onCommit(); redraw(); });
  renderer.domElement.oncontextmenu = (ev) => ev.preventDefault();

  function loadModel(url) {
    if (!modelCache.has(url)) modelCache.set(url, gltfLoader.loadAsync(url));
    return modelCache.get(url);
  }

  const animationTerms = {
    stand: ['idle', 'stand', 'breath'], walk: ['walk'], run: ['run', 'jog'], sit: ['sit'],
    crouch: ['crouch', 'squat'], reach: ['reach', 'grab'], fight: ['fight', 'attack', 'punch', 'kick']
  };

  function animationClip(clips, item) {
    if (!clips.length) return null;
    const named = clips.find((clip) => clip.name === item.animationName);
    if (named) return named;
    const terms = animationTerms[item.pose] || animationTerms.stand;
    return clips.find((clip) => terms.some((term) => clip.name.toLowerCase().includes(term))) || clips[0];
  }

  function ensureAnimationLoop() {
    if (animationRaf) return;
    animationAt = performance.now();
    const tick = (now) => {
      if (!host.isConnected || !mixers.size) { animationRaf = 0; return; }
      const delta = Math.min(.05, Math.max(0, (now - animationAt) / 1000));
      animationAt = now;
      for (const mixer of mixers.values()) mixer.update(delta);
      renderNow();
      animationRaf = requestAnimationFrame(tick);
    };
    animationRaf = requestAnimationFrame(tick);
  }

  function normalizedModel(source, targetHeight, { scene = false } = {}) {
    const root = cloneSkeleton(source);
    root.traverse((node) => {
      if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; }
    });
    const box = new THREE.Box3().setFromObject(root);
    const size3 = box.getSize(new THREE.Vector3());
    const wanted = scene ? Math.max(5, targetHeight) : targetHeight;
    const scale = wanted / Math.max(.001, scene ? Math.max(size3.x, size3.z) : size3.y);
    root.scale.setScalar(scale);
    const fitted = new THREE.Box3().setFromObject(root);
    const center = fitted.getCenter(new THREE.Vector3());
    root.position.set(-center.x, -fitted.min.y, -center.z);
    return root;
  }

  function modelOrFallback(item, kind, fallback) {
    const wrapper = new THREE.Group();
    wrapper.add(fallback);
    if (!item.modelUrl) return wrapper;
    loadModel(item.modelUrl).then((gltf) => {
      // 拖动/重绘可能已经换了实例，旧请求不能回头篡改新舞台。
      if (objects.get(item.id) !== wrapper) return;
      wrapper.clear();
      const model = normalizedModel(gltf.scene, Number(item.height || (kind === 'subject' ? 1.72 : .9)));
      wrapper.add(model);
      const clips = gltf.animations || [];
      item.availableAnimations = clips.map((clip) => clip.name).filter(Boolean);
      const clip = kind === 'subject' ? animationClip(clips, item) : null;
      if (clip) {
        const mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(clip).reset().play();
        mixers.set(wrapper, mixer);
        wrapper.userData.animationClip = clip.name;
        ensureAnimationLoop();
      }
      if (selected() === item.id) wrapper.add(new THREE.BoxHelper(model, 0x49c8ff));
      onModelReady(item, clips);
      renderNow();
    }).catch(() => {
      wrapper.userData.modelError = true;
      renderNow();
    });
    return wrapper;
  }

  function materialFor(item, color) {
    const source = item.textureUrl || item.thumbnail || item.image;
    if (!source) return new THREE.MeshStandardMaterial({ color, roughness: .7 });
    const map = textureLoader.load(source, renderNow); map.colorSpace = THREE.SRGBColorSpace;
    if (item.textureLayout === 'quad-character') {
      const requested = item.textureView || 'auto';
      let viewName = requested;
      if (requested === 'auto') {
        const cam = stage.cam || { x: 0, y: -3 };
        const bearing = THREE.MathUtils.radToDeg(Math.atan2(Number(cam.x || 0) - Number(item.x || 0), Number(cam.y || 0) - Number(item.y || 0)));
        const facing = Number(item.rotation ?? item.facing ?? 0);
        const delta = Math.abs(((bearing - facing + 540) % 360) - 180);
        viewName = delta <= 55 ? 'front' : delta >= 125 ? 'back' : 'side';
      }
      const crop = quadTextureTransform(item, viewName);
      map.repeat.set(crop.repeatX, crop.repeatY);
      map.offset.set(crop.offsetX, crop.offsetY);
      map.needsUpdate = true;
      item.resolvedTextureView = viewName;
    }
    return new THREE.MeshStandardMaterial({ map, transparent: true, alphaTest: .08, side: THREE.DoubleSide, roughness: .8 });
  }
  function actor(item) {
    const group = new THREE.Group(), h = Number(item.height || 1.72);
    const card = new THREE.Mesh(new THREE.PlaneGeometry(h * .62, h), materialFor(item, 0xd9a441));
    card.position.y = h / 2; card.castShadow = true; group.add(card);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(.28, .34, .08, 24), new THREE.MeshStandardMaterial({ color: 0x11151d }));
    base.position.y = .04; base.castShadow = true; group.add(base); return group;
  }
  function prop(item) {
    const h = Number(item.height || .9), w = Number(item.width || .9);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * .75), materialFor(item, 0x758196));
    mesh.position.y = h / 2; mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
  }
  function cameraRig() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(.65, .38, .35), new THREE.MeshStandardMaterial({ color: 0x34b7eb, metalness: .35 }));
    body.position.y = 1.55; body.castShadow = true; g.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(.16, .2, .34, 20), new THREE.MeshStandardMaterial({ color: 0x101820, metalness: .7 }));
    lens.rotation.x = Math.PI / 2; lens.position.set(0, 1.55, .33); g.add(lens);
    for (const x of [-.28, .28]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(.025, .035, 1.45, 8), new THREE.MeshStandardMaterial({ color: 0x71879a })); leg.position.set(x, .72, 0); leg.rotation.z = x * .2; g.add(leg); }
    const depth = 2.2, halfW = .82 * 35 / Math.max(12, Number(stage.cam.lens || 35)), halfH = halfW / 1.78, y = 1.55;
    const p = [new THREE.Vector3(0, y, .5), new THREE.Vector3(-halfW, y - halfH, depth), new THREE.Vector3(halfW, y - halfH, depth), new THREE.Vector3(halfW, y + halfH, depth), new THREE.Vector3(-halfW, y + halfH, depth)];
    const edges = [p[0],p[1],p[0],p[2],p[0],p[3],p[0],p[4],p[1],p[2],p[2],p[3],p[3],p[4],p[4],p[1]];
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(edges), new THREE.LineBasicMaterial({ color:0x49c8ff, transparent:true, opacity:.55 })));
    return g;
  }
  function addMotionGuide(item, kind) {
    const keyed = (stage.keyframes || []).slice().sort((a,b) => a.frame-b.frame)
      .map((key) => ({ key, value: key.values?.[item.id] })).filter((entry) => entry.value);
    const points = keyed.map(({ value }) => new THREE.Vector3(
      Number(value.x || 0),
      kind === 'camera' || kind === 'light' ? Number(value.height || item.height || 1) : Number(value.elevation || 0) + .08,
      Number(value.y || 0)
    ));
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const color = kind === 'camera' ? 0x49c8ff : kind === 'light' ? 0xffd08a : kind === 'subject' ? 0xffb648 : 0xaab7c7;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.max(16, points.length * 12))), new THREE.LineDashedMaterial({ color, dashSize:.18, gapSize:.1, transparent:true, opacity:.85 }));
    line.computeLineDistances(); scene3d.add(line); guides.push(line);
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index], entry = keyed[index];
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(.11, 14, 10),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .65, depthTest: false })
      );
      dot.position.copy(point);
      dot.renderOrder = 20;
      dot.userData.pathHandle = { item, value: entry.value, keyframe: entry.key, kind };
      scene3d.add(dot); guides.push(dot); pathHandles.push(dot);
    }
  }
  function lightRig(item) {
    const g = new THREE.Group();
    const color = new THREE.Color(item.color || '#ffd6a3');
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(.13, 18, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2 })
    );
    bulb.position.y = Number(item.height || 2.6); g.add(bulb);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(.025, .04, Number(item.height || 2.6), 8), new THREE.MeshStandardMaterial({ color: 0x596575 }));
    stand.position.y = Number(item.height || 2.6) / 2; g.add(stand);
    const targetItem = findObject(stage, item.targetId)?.item || stage.subjects?.[0] || { x: item.x, y: item.y, height: 1 };
    const target = new THREE.Object3D();
    target.position.set(Number(targetItem.x || 0) - Number(item.x || 0), Number(targetItem.height || 1) * .55, Number(targetItem.y || 0) - Number(item.y || 0));
    g.add(target);
    let source;
    if (item.lightType === 'point') {
      source = new THREE.PointLight(color, Number(item.intensity || 2.5), 12, 2);
    } else if (item.lightType === 'directional') {
      source = new THREE.DirectionalLight(color, Number(item.intensity || 2.5)); source.target = target;
    } else {
      source = new THREE.SpotLight(color, Number(item.intensity || 2.5), 16, Math.PI / 5, .35, 1.2); source.target = target;
    }
    source.position.y = Number(item.height || 2.6); source.castShadow = true; g.add(source);
    const beam = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, Number(item.height || 2.6), 0), target.position.clone()]),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: .65 })
    );
    g.add(beam);
    return g;
  }
  function redraw() {
    transform.detach();
    pathHandles.length = 0;
    for (const obj of objects.values()) {
      scene3d.remove(obj);
      const mixer = mixers.get(obj);
      if (mixer) { mixer.stopAllAction(); mixers.delete(obj); }
    }
    objects.clear();
    for (const guide of guides.splice(0)) {
      scene3d.remove(guide);
      guide.geometry?.dispose();
      if (Array.isArray(guide.material)) guide.material.forEach((material) => material.dispose());
      else guide.material?.dispose();
    }
    if (backdropObject) { scene3d.remove(backdropObject); backdropObject = null; }
    if (stage.backdrop?.image || stage.backdrop?.modelUrl) {
      backdropObject = new THREE.Group();
      if (stage.backdrop.image) {
        const map = textureLoader.load(stage.backdrop.image, renderNow);
        map.colorSpace = THREE.SRGBColorSpace;
        if (stage.backdrop.projection === 'flat') {
          const imageWall = new THREE.Mesh(
            new THREE.PlaneGeometry(12, 6.75),
            new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, toneMapped: false })
          );
          imageWall.position.set(0, 3.35, 5.8); imageWall.rotation.y = Math.PI;
          backdropObject.add(imageWall);
        } else {
          // 普通场景设定图也能变成半环绕摄影棚：不是伪造3D几何，而是给人物、
          // 道具、灯光提供有包围感的真实环境，导演视角不会再看到一张孤零零的纸片。
          const cyc = new THREE.Mesh(
            new THREE.CylinderGeometry(8.8, 8.8, 6.4, 72, 1, true, Math.PI / 2, Math.PI),
            new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, toneMapped: false })
          );
          cyc.position.set(0, 3.15, 0);
          backdropObject.add(cyc);
          const floorMap = map.clone(); floorMap.needsUpdate = true;
          floorMap.wrapS = floorMap.wrapT = THREE.ClampToEdgeWrapping;
          const deck = new THREE.Mesh(
            new THREE.CircleGeometry(8.75, 72, Math.PI, Math.PI),
            new THREE.MeshStandardMaterial({ map: floorMap, color: 0x556070, roughness: .96, transparent: true, opacity: .28 })
          );
          deck.rotation.x = -Math.PI / 2; deck.position.y = .012; deck.receiveShadow = true;
          backdropObject.add(deck);
        }
      }
      backdropObject.userData = { kind: 'backdrop', assetRef: stage.backdrop.assetRef, variantId: stage.backdrop.variantId };
      scene3d.add(backdropObject);
      if (stage.backdrop.modelUrl) {
        const target = backdropObject;
        loadModel(stage.backdrop.modelUrl).then((gltf) => {
          if (backdropObject !== target) return;
          const environment = normalizedModel(gltf.scene, 12, { scene: true });
          target.add(environment);
          renderNow();
        }).catch(() => { target.userData.modelError = true; });
      }
    }
    const entries = [...(stage.subjects || []).map((item) => ({ kind: 'subject', item })), ...(stage.marks || []).filter((x) => !x.far).map((item) => ({ kind: 'prop', item })), ...(stage.lights || []).map((item) => ({ kind: 'light', item })), { kind: 'camera', item: stage.cam }];
    for (const { kind, item } of entries) {
      const fallback = kind === 'subject' ? actor(item) : kind === 'camera' ? cameraRig() : kind === 'light' ? lightRig(item) : prop(item);
      const obj = kind === 'camera' || kind === 'light' ? fallback : modelOrFallback(item, kind, fallback);
      const attached = kind === 'prop' ? attachmentPose(stage, item) : null;
      obj.position.set(Number(attached?.x ?? item.x ?? 0), Number(attached?.elevation ?? item.elevation ?? 0), Number(attached?.y ?? item.y ?? 0));
      if (kind === 'camera' && stage.subjects?.[0]) obj.rotation.y = Math.atan2(Number(stage.subjects[0].x || 0) - Number(item.x || 0), Number(stage.subjects[0].y || 0) - Number(item.y || 0));
      else obj.rotation.y = -THREE.MathUtils.degToRad(Number(attached?.rotation ?? item.rotation ?? item.facing ?? 0));
      obj.rotation.x = THREE.MathUtils.degToRad(Number(item.rotationX || 0));
      obj.rotation.z = THREE.MathUtils.degToRad(Number(item.rotationZ || 0));
      const baseScale = Number(item.scale || 1);
      obj.scale.set(Number(item.scaleX || baseScale), Number(item.scaleY || baseScale), Number(item.scaleZ || baseScale));
      obj.userData = { item, kind };
      if (!capturing && selected() === item.id) { const box = new THREE.BoxHelper(obj, 0x49c8ff); obj.add(box); }
      objects.set(item.id, obj); scene3d.add(obj);
      addMotionGuide(item, kind);
    }
    const active = objects.get(selected());
    if (active && !active.userData.item.locked && !active.userData.item.attachToId) transform.attach(active);
    const rect = host.getBoundingClientRect(); renderer.setSize(Math.max(320, rect.width || size), Math.max(230, rect.height || size * .72), false);
    view.aspect = Math.max(1, (rect.width || size) / (rect.height || size * .72)); view.updateProjectionMatrix(); renderer.render(scene3d, view);
    const cam = stage.cam || {};
    shotCamera.position.set(Number(cam.x || 0), Number(cam.height || 1.6), Number(cam.y || -3));
    const focus = findObject(stage, cam.focusId)?.item || stage.subjects?.[0] || { x: 0, y: 0, height: 1.4 };
    shotCamera.lookAt(Number(focus.x || 0), Number(focus.height || 1.4) * .72 + Number(focus.elevation || 0), Number(focus.y || 0));
    shotCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(24 / (2 * Math.max(8, Number(cam.lens || 35)))));
    shotCamera.aspect = 16 / 9; shotCamera.updateProjectionMatrix(); renderNow();
  }
  const pointer = (ev) => { const r = renderer.domElement.getBoundingClientRect(); mouse.set((ev.clientX-r.left)/r.width*2-1, -(ev.clientY-r.top)/r.height*2+1); ray.setFromCamera(mouse, view); };
  const hitGround = (ev) => { pointer(ev); const p = new THREE.Vector3(); return ray.ray.intersectPlane(ground, p) ? { x: clampM(p.x), y: clampM(p.z) } : { x: 0, y: 0 }; };
  let dragging = null;
  renderer.domElement.onpointerdown = (ev) => {
    if (ev.button !== 0 || transforming || transform.axis) return;
    pointer(ev);
    const pathHit = ray.intersectObjects(pathHandles, false)[0]?.object?.userData?.pathHandle;
    if (pathHit) {
      onSelect(pathHit.item.id);
      dragging = { item: pathHit.item, value: pathHit.value, keyframe: pathHit.keyframe };
      renderer.domElement.setPointerCapture(ev.pointerId);
      return;
    }
    const hits = ray.intersectObjects([...objects.values()], true);
    const root = hits[0]?.object; let obj = root;
    while (obj && !obj.userData?.item) obj = obj.parent;
    if (!obj) return;
    onSelect(obj.userData.item.id);
    if (!obj.userData.item.locked && !obj.userData.item.attachToId && transformMode === 'translate') {
      dragging = { item: obj.userData.item, value: obj.userData.item };
      renderer.domElement.setPointerCapture(ev.pointerId);
    }
    redraw();
  };
  renderer.domElement.onpointermove = (ev) => {
    if (!dragging || transforming) return;
    const p = hitGround(ev), value = dragging.value;
    value.x = Number(p.x.toFixed(2)); value.y = Number(p.y.toFixed(2));
    if (value !== dragging.item) {
      dragging.item.x = value.x; dragging.item.y = value.y;
    }
    redraw(); onChange();
  };
  renderer.domElement.onpointerup = (ev) => { if (dragging) onCommit(); dragging = null; try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch {} };
  host.ondragover = (ev) => ev.preventDefault();
  host.ondrop = (ev) => { ev.preventDefault(); try { onAssetDrop(JSON.parse(ev.dataTransfer.getData('application/x-futuredream-asset')), hitGround(ev)); } catch {} };
  new ResizeObserver(redraw).observe(host); redraw();
  const capture = (type = 'image/png', quality) => {
    capturing = true; redraw();
    // 生成模型需要的是镜头真正看到的画面，不是导演在舞台外观察的工作视角。
    const rect = host.getBoundingClientRect(), restoreW = Math.max(320, rect.width || size), restoreH = Math.max(230, rect.height || size * .72);
    transformHelper.visible = false;
    renderer.setSize(1280, 720, false);
    renderer.render(scene3d, shotCamera);
    const data = renderer.domElement.toDataURL(type, quality);
    renderer.setSize(restoreW, restoreH, false);
    capturing = false; redraw();
    transformHelper.visible = viewMode === 'director'; renderNow();
    return data;
  };
  return { node: host, redraw, capture };
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
    for (const entry of stageObjects(stage).filter((x) => x.kind !== 'camera' && x.kind !== 'light')) {
      const attached = entry.kind === 'prop' ? attachmentPose(stage, entry.item) : null;
      const world = attached ? { ...entry.item, ...attached } : entry.item;
      const dx = Number(world.x) - Number(cam.x), dy = Number(world.y) - Number(cam.y);
      const depth = dx * Math.cos(look) + dy * Math.sin(look);
      const side = -dx * Math.sin(look) + dy * Math.cos(look);
      if (depth <= .15) continue;
      visible.push({ ...entry, item: world, depth, side });
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
  // 实例只保存稳定的设定资产 / 变体 ID；打开镜头时用最新设定图重绑。
  // 因此设定集重出图不会破坏已排好的位置和关键帧。
  const rebind = (item, kind) => {
    if (!item?.assetRef) return;
    const asset = assets.find((x) => x.kind === kind && x.ref === item.assetRef && (!item.variantId || x.variantId === item.variantId))
      || assets.find((x) => x.kind === kind && x.ref === item.assetRef);
    if (!asset) return;
    item.variantId = asset.variantId || item.variantId || 'default';
    item.textureUrl = asset.image || item.textureUrl || '';
    item.thumbnail = item.textureUrl;
    item.textureLayout = asset.textureLayout || item.textureLayout || 'single';
    item.modelUrl = asset.modelUrl || item.modelUrl || '';
  };
  for (const item of stage.subjects || []) rebind(item, 'character');
  for (const item of stage.marks || []) rebind(item, 'prop');
  if (stage.backdrop?.assetRef) {
    const asset = assets.find((x) => x.kind === 'scene' && x.ref === stage.backdrop.assetRef);
    if (asset) Object.assign(stage.backdrop, { image: asset.image || stage.backdrop.image || '', variantId: asset.variantId || stage.backdrop.variantId, modelUrl: asset.modelUrl || stage.backdrop.modelUrl || '' });
  }
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
    onModelReady: () => paintInspector(),
    onAssetDrop: (asset, p) => {
      const binding = {
        assetRef: asset.ref, variantId: asset.variantId || 'default',
        textureUrl: asset.image || '', textureLayout: asset.textureLayout || 'single',
        textureView: asset.kind === 'character' ? 'auto' : '', modelUrl: asset.modelUrl || ''
      };
      if (asset.kind === 'scene') stage.backdrop = { name: asset.name, image: asset.image || '', ...binding };
      else if (asset.kind === 'character') stage.subjects.push({ name: asset.name, x: p.x, y: p.y, facing: 180, height: 1.72, thumbnail: asset.image, ...binding });
      else stage.marks.push({ name: asset.name, x: p.x, y: p.y, height: .9, width: .9, thumbnail: asset.image, ...binding });
      normalizeStage(stage);
      history.commit(); redrawAll(); onChange();
    },
    onChange: () => { canvas.redraw(); refresh(); onChange(); }
  });
  const viewport = cameraViewport(stage, { width: Math.max(460, size) });
  // SVGElement 的 `.hidden` 在部分 Chromium 里只是 expando，不会生成 hidden 属性。
  canvas.node.setAttribute('hidden', '');
  const viewBar = document.createElement('div');
  viewBar.className = 'previz-viewbar';
  const viewHint = Object.assign(document.createElement('span'), {
    className: 'field-hint', textContent: '拖人物、道具和摄影机；所有位置都按米保存，并与俯视图实时同步'
  });
  const switchView = (mode) => {
    director.node.toggleAttribute('hidden', mode !== '3d');
    canvas.node.toggleAttribute('hidden', mode === '3d');
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
  const captureBtn = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '导出当前帧' });
  undoBtn.onclick = () => { if (history.undo()) { redrawAll(); onChange(); } };
  redoBtn.onclick = () => { if (history.redo()) { redrawAll(); onChange(); } };
  captureBtn.onclick = () => {
    const link = document.createElement('a');
    link.href = director.capture('image/png');
    link.download = `预演-${scene || '镜头'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
  };
  viewBar.append(undoBtn, redoBtn, captureBtn);
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
  let playbackRaf = 0;
  const assetShelf = document.createElement('div');
  assetShelf.className = 'previz-assets';
  if (assets.length) {
    assetShelf.append(Object.assign(document.createElement('div'), { className: 'previz-section-title', textContent: '设定集资产' }));
    for (const [kind, label] of [['character', '人物'], ['scene', '场景'], ['prop', '道具']]) {
      const group = document.createElement('section');
      group.className = 'previz-asset-group';
      group.append(Object.assign(document.createElement('b'), { textContent: label }));
      const grid = document.createElement('div');
      grid.className = 'previz-asset-grid';
      for (const asset of assets.filter((x) => x.kind === kind)) {
        const card = document.createElement('div');
        card.className = 'previz-asset'; card.draggable = true; card.title = `拖入${label}：${asset.name}`;
        if (asset.image) card.append(Object.assign(document.createElement('img'), { src: asset.image, alt: asset.name }));
        else card.append(Object.assign(document.createElement('div'), { className: `previz-asset-ph ${kind}`, textContent: label.slice(0, 1) }));
        card.append(Object.assign(document.createElement('span'), { textContent: asset.name }));
        card.ondragstart = (ev) => ev.dataTransfer.setData('application/x-futuredream-asset', JSON.stringify(asset));
        grid.append(card);
      }
      if (!grid.children.length) grid.append(Object.assign(document.createElement('div'), { className: 'field-hint', textContent: `暂无${label}资产` }));
      group.append(grid); assetShelf.append(group);
    }
  }
  const controlShelf = document.createElement('div');
  controlShelf.className = 'previz-control-shelf';
  if (onExportControls) {
    const exportBtn = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '输出可控视频控制包' });
    exportBtn.onclick = async () => {
      exportBtn.disabled = true; exportBtn.textContent = '正在输出…';
      try {
        const renderedFrame = director.capture('image/png');
        const result = await onExportControls(stage, { renderedFrame });
        const maps = result?.previews || result;
        controlShelf.replaceChildren(exportBtn);
        if (result?.frameCount) {
          const summary = document.createElement('div');
          summary.className = 'previz-control-summary';
          summary.textContent = `已输出 ${result.frameCount} 个控制时刻 · ${result.controlFps || '—'}fps · 每个时刻含画面/深度/姿态/边缘/遮罩`;
          controlShelf.append(summary);
          if (result.manifest) {
            const manifest = document.createElement('a');
            manifest.className = 'btn ghost sm'; manifest.href = result.manifest; manifest.target = '_blank';
            manifest.textContent = '打开控制清单'; controlShelf.append(manifest);
          }
          for (const issue of result.issues || []) {
            const warning = document.createElement('div');
            warning.className = `previz-warn${issue.level === 'blocker' ? ' bad' : ''}`;
            warning.textContent = `${issue.level === 'blocker' ? '阻断' : '提醒'}：${issue.message}`;
            controlShelf.append(warning);
          }
        }
        for (const [key, label] of [['rendered', '3D真实渲染帧'], ['start', '首帧'], ['end', '尾帧'], ['depth', '深度图'], ['pose', '人物姿态'], ['edge', '边缘图'], ['mask', '对象遮罩']]) {
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
      className: 'previz-inspector-title',
      textContent: `${found.kind === 'camera' ? '摄影机' : found.kind === 'light' ? '灯光' : item.name || '对象'} · ${item.id}`
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
    const makeSelect = (label, key, options) => {
      const input = document.createElement('select');
      input.disabled = item.locked;
      for (const [value, text] of options) input.append(Object.assign(document.createElement('option'), { value, textContent: text }));
      const booleanKey = key === 'autoOrient' || key === 'grounded';
      input.value = booleanKey ? String(item[key] !== false) : String(item[key] || '');
      input.onchange = () => { item[key] = booleanKey ? input.value === 'true' : input.value; history.commit(); redrawAll(); onChange(); };
      const wrap = document.createElement('label');
      wrap.append(document.createTextNode(label), input);
      return wrap;
    };
    const makeText = (label, key, placeholder) => {
      const input = Object.assign(document.createElement('input'), { value: String(item[key] || ''), placeholder, disabled: item.locked });
      input.onchange = () => { item[key] = input.value.trim(); history.commit(); redrawAll(); onChange(); };
      const wrap = document.createElement('label'); wrap.append(document.createTextNode(label), input); return wrap;
    };
    const lock = Object.assign(document.createElement('button'), {
      className: `btn ghost sm${item.locked ? ' on' : ''}`, textContent: item.locked ? '🔒 已锁定' : '🔓 锁定'
    });
    lock.onclick = () => { item.locked = !item.locked; history.commit(); redrawAll(); onChange(); };
    inspector.append(title, makeNumber('X', 'x'), makeNumber('Y', 'y'), makeNumber('离地', 'elevation'), makeNumber('高度', 'height'),
      makeNumber('水平旋转°', 'rotation', '1'), makeNumber('俯仰°', 'rotationX', '1'), makeNumber('翻滚°', 'rotationZ', '1'),
      makeNumber('缩放X', 'scaleX'), makeNumber('缩放Y', 'scaleY'), makeNumber('缩放Z', 'scaleZ'), lock);
    if (found.kind === 'camera') {
      const targets = [['', '自动跟随主体'], ...(stage.subjects || []).map((x) => [x.id, x.name || x.id]),
        ...(stage.marks || []).filter((x) => !x.far).map((x) => [x.id, x.name || x.id])];
      inspector.append(makeNumber('光圈 f/', 'aperture', '0.1'), makeSelect('对焦目标', 'focusId', targets),
        makeNumber('手动焦距 m', 'focusDistance', '0.1'), makeNumber('快门角度°', 'shutterAngle', '1'), makeNumber('ISO', 'iso', '25'));
    } else if (found.kind === 'subject') {
      const ground = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '脚底贴地' });
      ground.onclick = () => { snapToGround(item); history.commit(); redrawAll(); onChange(); };
      inspector.append(makeSelect('地面约束', 'grounded', [['true', '脚底贴地检查'], ['false', '允许跳跃/悬空']]), ground);
      if (item.textureLayout === 'quad-character') {
        inspector.append(makeSelect('贴图视角', 'textureView', [
          ['auto', '自动随朝向'], ['front', '全身正面'], ['side', '全身侧面'],
          ['back', '全身背面'], ['closeup', '上半身特写']
        ]), makeSelect('设定集排版', 'textureGrid', [
          ['horizontal', '横向四格'], ['2x2', '2×2 四宫格']
        ]), makeNumber('裁切内缩', 'textureInset', '0.005'));
      }
      inspector.append(makeSelect('姿态', 'pose', [
        ['stand', '站立'], ['walk', '行走'], ['run', '奔跑'], ['sit', '坐下'], ['crouch', '下蹲'],
        ['reach', '伸手'], ['fight', '打斗']
      ]), makeSelect('路径朝向', 'autoOrient', [['true', '自动朝向移动方向'], ['false', '保持手动朝向']]),
        makeText('动作指令', 'action', '例如：右手拔剑，左脚向前'));
      if (item.availableAnimations?.length) {
        inspector.append(makeSelect('模型骨骼动画', 'animationName', [
          ['', '按姿态自动匹配'], ...item.availableAnimations.map((name) => [name, name])
        ]));
      }
    } else if (found.kind === 'light') {
      const color = Object.assign(document.createElement('input'), { type: 'color', value: item.color || '#ffd6a3', disabled: item.locked });
      color.oninput = () => { item.color = color.value; director.redraw(); onChange(); };
      color.onchange = () => { history.commit(); paintTimeline(); };
      const colorWrap = document.createElement('label'); colorWrap.append(document.createTextNode('颜色'), color);
      const targets = [['', '自动主体'], ...(stage.subjects || []).map((x) => [x.id, x.name || x.id]), ...(stage.marks || []).filter((x) => !x.far).map((x) => [x.id, x.name || x.id])];
      const remove = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '删除灯光' });
      remove.onclick = () => { stage.lights = (stage.lights || []).filter((x) => x.id !== item.id); selectedId = stage.cam.id; history.commit(); redrawAll(); onChange(); };
      inspector.append(makeSelect('类型', 'lightType', [['spot', '聚光灯'], ['point', '点光源'], ['directional', '平行光']]),
        makeNumber('强度', 'intensity', '0.1'), colorWrap, makeSelect('照向', 'targetId', targets), remove);
    } else if (found.kind === 'prop') {
      const actors = [['', '自由摆放'], ...(stage.subjects || []).map((x) => [x.id, `绑定：${x.name || x.id}`])];
      inspector.append(makeSelect('人物挂点', 'attachToId', actors));
      if (item.attachToId) {
        inspector.append(makeSelect('绑定位置', 'attachPoint', [
          ['rightHand', '右手'], ['leftHand', '左手'], ['back', '背部'], ['waist', '腰部']
        ]), makeNumber('挂点左右', 'attachOffsetX', '0.01'), makeNumber('挂点上下', 'attachOffsetY', '0.01'), makeNumber('挂点前后', 'attachOffsetZ', '0.01'));
      } else {
        const ground = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '底部贴地' });
        ground.onclick = () => { snapToGround(item); history.commit(); redrawAll(); onChange(); };
        inspector.append(makeSelect('地面约束', 'grounded', [['true', '底部贴地检查'], ['false', '允许悬挂/悬空']]), ground);
      }
    }
  }

  function paintTimeline() {
    timeline.replaceChildren();
    const maxFrame = Math.max(24, Math.round(Number(duration || 5) * 24));
    const range = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: String(maxFrame), value: String(currentFrame) });
    const frame = Object.assign(document.createElement('b'), { textContent: `${currentFrame}f / ${maxFrame}f` });
    const stopPlayback = () => {
      if (playbackRaf) cancelAnimationFrame(playbackRaf);
      playbackRaf = 0;
    };
    const showFrame = () => {
      if ((stage.keyframes || []).length) applyFrame(stage, currentFrame);
      canvas.redraw(); director.redraw(); viewport.redraw(); paintInspector(); refresh();
    };
    range.oninput = () => {
      stopPlayback();
      currentFrame = Number(range.value);
      frame.textContent = `${currentFrame}f / ${maxFrame}f`;
      showFrame();
    };
    const play = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: playbackRaf ? '❚❚ 暂停' : '▶ 播放预演' });
    play.onclick = () => {
      if (playbackRaf) { stopPlayback(); paintTimeline(); return; }
      if (currentFrame >= maxFrame) currentFrame = 0;
      const started = performance.now() - currentFrame / 24 * 1000;
      play.textContent = '❚❚ 暂停';
      const tick = (now) => {
        currentFrame = Math.min(maxFrame, Math.round((now - started) / 1000 * 24));
        range.value = String(currentFrame); frame.textContent = `${currentFrame}f / ${maxFrame}f`;
        showFrame();
        if (currentFrame < maxFrame) playbackRaf = requestAnimationFrame(tick);
        else { playbackRaf = 0; paintTimeline(); }
      };
      playbackRaf = requestAnimationFrame(tick);
    };
    const add = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '＋当前对象关键帧' });
    add.onclick = () => {
      stopPlayback();
      addKeyframe(stage, currentFrame, selectedId ? [selectedId] : []);
      history.commit(); paintTimeline(); director.redraw(); onChange();
    };
    const addAll = Object.assign(document.createElement('button'), { className: 'btn ghost sm', textContent: '＋全场关键帧' });
    addAll.onclick = () => { stopPlayback(); addKeyframe(stage, currentFrame); history.commit(); paintTimeline(); director.redraw(); onChange(); };
    const transport = document.createElement('div');
    transport.className = 'previz-transport';
    transport.append(Object.assign(document.createElement('b'), { textContent: '关键帧时间线' }), play, frame, add, addAll);
    const scrub = document.createElement('div');
    scrub.className = 'previz-scrub'; scrub.append(range);
    const ruler = document.createElement('div'); ruler.className = 'previz-ruler';
    for (let second = 0; second <= Math.ceil(maxFrame / 24); second += 1) {
      const tick = document.createElement('span'); tick.style.left = `${Math.min(100, second * 24 / maxFrame * 100)}%`; tick.textContent = `${second}s`; ruler.append(tick);
    }
    scrub.append(ruler);
    const tracks = document.createElement('div'); tracks.className = 'previz-tracks';
    for (const { kind, item } of stageObjects(stage)) {
      const row = document.createElement('div'); row.className = `previz-track ${selectedId === item.id ? 'selected' : ''}`;
      const name = Object.assign(document.createElement('button'), { className: 'previz-track-name', textContent: `${kind === 'camera' ? '▣' : kind === 'light' ? '☀' : kind === 'subject' ? '♙' : '◇'} ${item.name || (kind === 'camera' ? '主摄影机' : item.id)}` });
      name.onclick = () => { selectedId = item.id; redrawAll(); };
      const lane = document.createElement('div'); lane.className = 'previz-track-lane';
      for (const kf of stage.keyframes || []) {
        if (!kf.values?.[item.id]) continue;
        const jump = Object.assign(document.createElement('button'), { className: 'previz-diamond', title: `${kf.frame}f · 拖动改时刻 · 右键删除` });
        jump.style.left = `${kf.frame / maxFrame * 100}%`;
        jump.onclick = () => { stopPlayback(); currentFrame = kf.frame; showFrame(); paintTimeline(); };
        jump.oncontextmenu = (event) => {
          event.preventDefault(); event.stopPropagation();
          delete kf.values[item.id];
          if (!Object.keys(kf.values || {}).length) stage.keyframes = stage.keyframes.filter((entry) => entry !== kf);
          history.commit(); paintTimeline(); director.redraw(); onChange();
        };
        jump.onpointerdown = (event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          jump.setPointerCapture(event.pointerId);
          const rect = lane.getBoundingClientRect(), startFrame = kf.frame;
          let moved = false, nextFrame = startFrame;
          const move = (moveEvent) => {
            const ratio = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / Math.max(1, rect.width)));
            nextFrame = Math.round(ratio * maxFrame); moved ||= nextFrame !== startFrame;
            jump.style.left = `${nextFrame / maxFrame * 100}%`; jump.title = `${nextFrame}f · 松开确认`;
          };
          const up = () => {
            jump.removeEventListener('pointermove', move); jump.removeEventListener('pointerup', up);
            if (!moved) return;
            const collision = stage.keyframes.find((entry) => entry !== kf && entry.frame === nextFrame);
            if (collision) { collision.values[item.id] = kf.values[item.id]; delete kf.values[item.id]; }
            else kf.frame = nextFrame;
            if (!Object.keys(kf.values || {}).length) stage.keyframes = stage.keyframes.filter((entry) => entry !== kf);
            stage.keyframes.sort((a, b) => a.frame - b.frame);
            currentFrame = nextFrame; history.commit(); paintTimeline(); director.redraw(); onChange();
          };
          jump.addEventListener('pointermove', move); jump.addEventListener('pointerup', up);
        };
        lane.append(jump);
      }
      const playhead = document.createElement('i'); playhead.className = 'previz-playhead'; playhead.style.left = `${currentFrame / maxFrame * 100}%`; lane.append(playhead);
      row.append(name, lane); tracks.append(row);
    }
    timeline.append(transport, scrub, tracks);
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

    const easingRow = document.createElement('div');
    easingRow.className = 'previz-row';
    easingRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '路径节奏' }));
    for (const [value, label] of [['easeInOut', '缓入缓出'], ['linear', '匀速'], ['easeIn', '渐加速'], ['easeOut', '渐减速']]) {
      easingRow.append(btn(label, stage.motionEasing === value, () => { stage.motionEasing = value; }));
    }
    controls.append(easingRow);

    const focusRow = document.createElement('div');
    focusRow.className = 'previz-row';
    focusRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '焦点/景深' }));
    focusRow.append(btn('自动主体', !stage.cam.focusId, () => { stage.cam.focusId = ''; }));
    for (const target of [...(stage.subjects || []), ...(stage.marks || []).filter((x) => !x.far)]) {
      focusRow.append(btn(target.name || target.id, stage.cam.focusId === target.id, () => { stage.cam.focusId = target.id; }));
    }
    for (const aperture of [1.4, 2.8, 4, 8, 16]) {
      focusRow.append(btn(`f/${aperture}`, Number(stage.cam.aperture || 4) === aperture, () => { stage.cam.aperture = aperture; }));
    }
    controls.append(focusRow);

    const lightRow = document.createElement('div');
    lightRow.className = 'previz-row';
    lightRow.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '灯光' }));
    for (const [type, label, color] of [['spot', '＋主光', '#ffd6a3'], ['point', '＋实景灯', '#ffb45e'], ['directional', '＋环境光', '#b8d7ff']]) {
      lightRow.append(btn(label, false, () => {
        const light = { name: label.slice(1), lightType: type, x: Number(stage.cam.x || 0) - 1, y: Number(stage.cam.y || 0) + 1, height: 2.6, intensity: type === 'point' ? 1.8 : 2.5, color, targetId: stage.subjects?.[0]?.id || '' };
        stage.lights ||= []; stage.lights.push(light); normalizeStage(stage); selectedId = light.id; history.commit();
      }));
    }
    controls.append(lightRow);

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
    for (const issue of spatialIssues(stage)) {
      const warn = document.createElement('div');
      warn.className = `previz-warn${issue.level === 'blocker' ? ' bad' : ''}`;
      warn.textContent = `${issue.level === 'blocker' ? '⛔' : '⚠'} ${issue.message}`;
      readout.append(warn);
    }

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
  const center = document.createElement('div'); center.className = 'previz-center';
  const viewWrap = document.createElement('div'); viewWrap.className = 'previz-workspace';
  viewWrap.append(director.node, Object.assign(document.createElement('div'), { className: 'previz-camera-pane' }));
  viewWrap.lastChild.append(Object.assign(document.createElement('b'), { textContent: '摄影机取景' }), viewport.node);
  center.append(viewBar, viewWrap, canvas.node, timeline);
  const right = document.createElement('aside'); right.className = 'previz-right';
  right.append(Object.assign(document.createElement('div'), { className: 'previz-section-title', textContent: '对象属性' }), inspector, controls, controlShelf, readout);
  const workbench = document.createElement('div'); workbench.className = 'previz-workbench';
  workbench.append(assetShelf, center, right); host.append(workbench);
  return { node: host, refresh };
}

