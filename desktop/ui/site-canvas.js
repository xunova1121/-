/**
 * 场地图画布 —— 可以无限平移缩放的那一块。
 *
 * ════════ 它和排位画布是两件事 ════════
 *
 * 排位画布（previz-canvas.js）是**定帧**的：一屏一个场景，六米见方，
 * 摆的是人和机位。那个尺度上定帧是对的 —— 一间屋子就那么大，
 * 能缩放反而让人分不清自己在看多大一块地方。
 *
 * 这一块画的是**几个场景之间的关系**，尺度从三米到四百米。
 * 定帧在这儿是不成立的：缩到能看见整座山，那么屋子就是一个点；
 * 放到能看清屋子，就只剩一间屋子。所以它必须能平移缩放。
 *
 * ════════ 为什么"无限"这件事在这儿是有意义的 ════════
 *
 * 无限画布最常见的毛病是**位置变成了没有正确答案的状态** ——
 * 用户摆的卡片位置纯属排版偏好，新加一张卡该放哪儿谁也说不清，
 * 自动排会毁掉手工布局，不排就找不着。
 *
 * 这块画布没有这个毛病，因为上面的位置**不是排版，是地理**。
 * 大殿在山门外北边三十米，这是剧本决定的事实，不是审美选择。
 * 摆错了有客观标准（人走不过去、太阳对不上），摆对了能算出东西来。
 *
 * ⚠ 这也是为什么分镜墙没有做成画布：镜头的顺序是一维的，
 * 把它铺到二维平面上，那个平面上的位置就没有意义了。
 *
 * ════════ 远景地标和太阳为什么钉在边框上 ════════
 *
 * 它们在无穷远。平移画布时，一座山**不该跟着移动** —— 真山不会因为
 * 你往前走了三十米就换个方位。所以它们不参与世界坐标变换，
 * 只按方位角钉在视口边缘。缩放也不动它们。
 *
 * 这不是省事，是唯一正确的画法：给它们编一个坐标的话，
 * 缩小到看得见整片场地时那座山会跑到画布外面去。
 */

import * as previz from '/previz.js';
import * as site from '/site.js';

const NS = 'http://www.w3.org/2000/svg';

/** 画布的内部像素尺寸。外面用 CSS 撑开，这只是 viewBox 的单位 */
const W = 640;
const H = 460;

/** 缩放范围：米 → 像素。0.4 时四百米的场地刚好装得下，24 时一米有二十四像素 */
const MIN_SCALE = 0.4;
const MAX_SCALE = 24;

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

function text(parent, str, attrs) {
  const t = el('text', { 'pointer-events': 'none', ...attrs });
  t.append(document.createTextNode(str));
  parent.append(t);
  return t;
}

/**
 * 网格的格子该是几米。
 *
 * 固定一米的话，缩小之后网格会糊成一片实心色 —— 那既难看又没信息。
 * 所以按当前缩放挑一个"一格大约四十像素"的档位，1/2/5/10 这么翻上去，
 * 和地图、示波器用的是同一套刻度习惯（人对这几个数有直觉）。
 */
function gridStep(scale) {
  const want = 40 / scale; // 想让一格约 40 像素，对应多少米
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100];
  return steps.find((s) => s >= want) || 200;
}

/**
 * 建一块场地图画布。
 *
 * places 是 [{scene, x, y, layout}]，**就地改** x/y 并在每次改动后回调 onChange。
 * marks / sun 是场地自己的（只有方位），改动走 onSite。
 */
/**
 * ⚠ onChange 和 onCommit 是**两回事**，混用会打爆接口。
 *
 *   onChange  拖动过程中每一帧都在响。只该用来重画和更新读数
 *   onCommit  松手时响一次。存盘走这一条
 *
 * 把存盘挂在 onChange 上的话，拖一次场景会发出几十上百个 POST ——
 * 本机跑着看不出来（都是毫秒级），连服务器就是一串请求排队，
 * 表现是"拖起来很卡"，而没人会想到是自己在拖的时候一直在存。
 */
export function siteCanvas(model, {
  onChange = () => {},
  onCommit = () => {},
  onSite = () => {},
  onPick = () => {}
} = {}) {
  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'site-canvas',
    style: 'width:100%;aspect-ratio:640/460;touch-action:none;user-select:none;display:block'
  });

  /** 视口：世界坐标里哪一点在屏幕正中，以及一米画多少像素 */
  const view = { cx: 0, cy: 0, scale: 4 };
  let picked = null;

  const sx = (x) => W / 2 + (x - view.cx) * view.scale;
  const sy = (y) => H / 2 - (y - view.cy) * view.scale;
  const wx = (px) => view.cx + (px - W / 2) / view.scale;
  const wy = (py) => view.cy - (py - H / 2) / view.scale;

  /** 客户端像素 → viewBox 像素。画布被 CSS 压窄时两者不等，不换算拖动就会偏 */
  function local(ev) {
    const r = svg.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  }

  svg.append(el('rect', { x: 0, y: 0, width: W, height: H, class: 'site-bg' }));
  const gridLayer = el('g');
  const linkLayer = el('g');
  const placeLayer = el('g');
  const rimLayer = el('g');
  svg.append(gridLayer, linkLayer, placeLayer, rimLayer);

  // ──────────────────────────────────────────────────────────
  // 平移和缩放
  // ──────────────────────────────────────────────────────────

  /**
   * 缩放锚在指针上，不是锚在画布中心。
   *
   * 锚在中心的话，想看清右上角那个场景就得"放大 → 发现它跑出去了 →
   * 平移回来 → 再放大"，来回三四次。锚在指针上是所有地图都在用的做法，
   * 因为它符合"我盯着的这一点不该动"这个直觉。
   */
  function zoomAt(px, py, factor) {
    const before = [wx(px), wy(py)];
    view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    const after = [wx(px), wy(py)];
    view.cx += before[0] - after[0];
    view.cy += before[1] - after[1];
    redraw();
  }

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [px, py] = local(ev);
    zoomAt(px, py, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  /**
   * 手指：一根拖动，两根缩放。
   *
   * 两根手指那条路必须自己写 —— 浏览器的手势事件只有 Safari 有，
   * 而且它和 pointer 事件混用时行为不一致。自己按指针对之间的距离算，
   * 三个平台一个样。
   */
  const touches = new Map();
  let pinch = null;

  svg.addEventListener('pointerdown', (ev) => {
    // 落在场景圆点上的按下由圆点自己处理（它 stopPropagation 了），到不了这里
    svg.setPointerCapture(ev.pointerId);
    touches.set(ev.pointerId, local(ev));
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) };
    }
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!touches.has(ev.pointerId)) return;
    const now = local(ev);
    const prev = touches.get(ev.pointerId);
    touches.set(ev.pointerId, now);

    if (touches.size === 2 && pinch) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch.dist > 4 && dist > 4) {
        zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dist / pinch.dist);
      }
      pinch.dist = dist;
      return;
    }
    if (touches.size !== 1) return;
    view.cx -= (now[0] - prev[0]) / view.scale;
    view.cy += (now[1] - prev[1]) / view.scale;
    redraw();
  });

  const lift = (ev) => {
    touches.delete(ev.pointerId);
    if (touches.size < 2) pinch = null;
    if (svg.hasPointerCapture?.(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
  };
  svg.addEventListener('pointerup', lift);
  svg.addEventListener('pointercancel', lift);

  /** 拖一个场景。世界坐标里改，所以缩放到哪一档拖起来都是对的 */
  function draggablePlace(node, place) {
    node.style.cursor = 'grab';
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // 不让它变成平移
      node.setPointerCapture(ev.pointerId);
      picked = place.scene;
      onPick(place.scene);
      const [px, py] = local(ev);
      const grab = { dx: place.x - wx(px), dy: place.y - wy(py) };
      let moved = false;
      const move = (e) => {
        moved = true;
        const [mx, my] = local(e);
        place.x = Number((wx(mx) + grab.dx).toFixed(1));
        place.y = Number((wy(my) + grab.dy).toFixed(1));
        redraw();
        onChange(place);
      };
      const up = () => {
        node.releasePointerCapture(ev.pointerId);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
        // 只在真拖动过之后才存。单纯点一下是"选中"，不该产生一次写入
        if (moved) onCommit(place);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
      redraw();
    });
  }

  /** 边框上按方位拖的东西（远景地标、太阳） */
  const RIM = Math.min(W, H) / 2 - 16;
  const rimAt = (deg) => {
    const rad = ((Number(deg) || 0) * Math.PI) / 180;
    return [W / 2 + Math.sin(rad) * RIM, H / 2 - Math.cos(rad) * RIM];
  };
  function draggableAngle(node, onDeg) {
    node.style.cursor = 'grab';
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      node.setPointerCapture(ev.pointerId);
      let moved = false;
      const move = (e) => {
        const [px, py] = local(e);
        const dx = px - W / 2;
        const dy = py - H / 2;
        if (Math.hypot(dx, dy) < 8) return; // 正中间的角度是没有定义的，别乱跳
        moved = true;
        onDeg(Math.round((Math.atan2(dx, -dy) * 180) / Math.PI));
        redraw();
      };
      const up = () => {
        node.releasePointerCapture(ev.pointerId);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
        // 同样只在松手时存一次 —— 拖太阳绕一圈会经过上百个角度
        if (moved) onSite();
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
    });
  }

  // ──────────────────────────────────────────────────────────
  // 画
  // ──────────────────────────────────────────────────────────

  function drawGrid() {
    while (gridLayer.firstChild) gridLayer.removeChild(gridLayer.firstChild);
    const step = gridStep(view.scale);
    const x0 = Math.floor(wx(0) / step) * step;
    const x1 = wx(W);
    const y0 = Math.floor(wy(H) / step) * step;
    const y1 = wy(0);
    for (let x = x0; x <= x1; x += step) {
      gridLayer.append(el('line', {
        x1: sx(x), y1: 0, x2: sx(x), y2: H,
        class: Math.abs(x) < step / 2 ? 'site-axis' : 'site-grid'
      }));
    }
    for (let y = y0; y <= y1; y += step) {
      gridLayer.append(el('line', {
        x1: 0, y1: sy(y), x2: W, y2: sy(y),
        class: Math.abs(y) < step / 2 ? 'site-axis' : 'site-grid'
      }));
    }
    // 比例尺。没有它，缩放之后没人知道自己在看多大一块地
    const barM = step;
    const barPx = barM * view.scale;
    gridLayer.append(el('line', { x1: 14, y1: H - 16, x2: 14 + barPx, y2: H - 16, class: 'site-scalebar' }));
    text(gridLayer, `${barM} 米`, { x: 14 + barPx + 6, y: H - 12, class: 'site-scale-label' });
  }

  function drawRim() {
    while (rimLayer.firstChild) rimLayer.removeChild(rimLayer.firstChild);

    // 东南西北。场地图上这四个字比场景图上更要紧 —— 整张图的方位基准就是它
    for (const [word, dx, dy] of [['北', 0, -1], ['南', 0, 1], ['东', 1, 0], ['西', -1, 0]]) {
      text(rimLayer, word, {
        x: W / 2 + dx * (W / 2 - 10),
        y: H / 2 + dy * (H / 2 - 10) + 4,
        class: 'site-compass'
      });
    }

    for (const mk of model.marks || []) {
      const [fx, fy] = rimAt(mk.deg);
      const g = el('g');
      g.append(el('circle', { cx: fx, cy: fy, r: 11, class: 'site-far' }));
      text(g, (mk.name || '?').slice(0, 2), { x: fx, y: fy + 4, class: 'site-far-label' });
      draggableAngle(g.firstChild, (deg) => { mk.deg = deg; });
      rimLayer.append(g);
    }

    if (model.sun && Number.isFinite(Number(model.sun.deg))) {
      const [ax, ay] = rimAt(model.sun.deg);
      const g = el('g');
      g.append(el('circle', { cx: ax, cy: ay, r: 12, class: 'site-sun' }));
      text(g, '☀', { x: ax, y: ay + 4, class: 'site-sun-label' });
      draggableAngle(g.firstChild, (deg) => { model.sun = { ...model.sun, deg }; });
      rimLayer.append(g);
    }
  }

  /**
   * 选中一个场景时，把它到别处的方向和距离画出来。
   *
   * 这是整块画布真正要交付的东西。"大殿在山门外正北三十米"这句话
   * 在两张分开的俯视图上是无论如何也读不出来的，而它决定了
   * "他往北走出画"的下一场接不接得上。
   */
  function drawLinks() {
    while (linkLayer.firstChild) linkLayer.removeChild(linkLayer.firstChild);
    const from = (model.places || []).find((p) => p.scene === picked);
    if (!from) return;
    for (const to of model.places) {
      if (to === from) continue;
      const d = previz.distance(from, to);
      if (d < 0.5) continue;
      linkLayer.append(el('line', {
        x1: sx(from.x), y1: sy(from.y), x2: sx(to.x), y2: sy(to.y), class: 'site-link'
      }));
      const mx = (sx(from.x) + sx(to.x)) / 2;
      const my = (sy(from.y) + sy(to.y)) / 2;
      text(linkLayer, `${previz.compassOf(previz.bearing(from, to))} ${Math.round(d)}m`, {
        x: mx, y: my - 4, class: 'site-link-label'
      });
    }
  }

  function drawPlaces() {
    while (placeLayer.firstChild) placeLayer.removeChild(placeLayer.firstChild);
    for (const p of model.places || []) {
      const g = el('g');
      const on = p.scene === picked;
      /**
       * 圆的**半径固定在屏幕上**，不跟着缩放变。
       *
       * 跟着变的话，缩小到能看见整片场地时每个场景都成了一个亚像素的点，
       * 谁也点不中；放大时又变成盖住半屏的巨圆。地图上的图钉从来不跟着缩放，
       * 就是这个道理 —— 它标的是"这儿有个东西"，不是"这东西有多大"。
       */
      g.append(el('circle', {
        cx: sx(p.x), cy: sy(p.y), r: on ? 15 : 13,
        class: on ? 'site-place site-place-on' : 'site-place'
      }));
      // 名字放在圆下面，不盖住圆 —— 盖住的话标签会把按下那一下吞掉，
      // 表现是"这个场景拖不动"，而看起来一切正常
      text(g, p.scene.slice(0, 6), { x: sx(p.x), y: sy(p.y) + 28, class: 'site-place-label' });
      // 这个场景自己摆过太阳的话，画一根短针指着光来的方向
      if (p.layout?.sun && Number.isFinite(Number(p.layout.sun.deg))) {
        const rad = ((p.layout.sun.deg) * Math.PI) / 180;
        g.append(el('line', {
          x1: sx(p.x), y1: sy(p.y),
          x2: sx(p.x) + Math.sin(rad) * 22, y2: sy(p.y) - Math.cos(rad) * 22,
          class: 'site-place-sun'
        }));
      }
      draggablePlace(g.firstChild, p);
      placeLayer.append(g);
    }
  }

  function redraw() {
    drawGrid();
    drawLinks();
    drawPlaces();
    drawRim();
  }

  /**
   * 把所有场景装进视口。
   *
   * 无限画布必须有这颗按钮。平移出去之后找不着东西是这类界面最常见的
   * 卡死点 —— 屏幕上一片空白网格，而人不知道自己在哪儿，也不知道往哪走。
   */
  function fit() {
    const ps = model.places || [];
    if (!ps.length) {
      view.cx = 0; view.cy = 0; view.scale = 4;
      redraw();
      return;
    }
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    view.cx = (minX + maxX) / 2;
    view.cy = (minY + maxY) / 2;
    // 留白：圆点半径 + 标签，按最宽的那一维算，最少给 8 米免得单个场景被放到最大
    const spanX = Math.max(maxX - minX, 8);
    const spanY = Math.max(maxY - minY, 8);
    view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
      Math.min((W - 90) / spanX, (H - 90) / spanY)));
    redraw();
  }

  function pick(scene) {
    picked = scene || null;
    redraw();
  }

  fit();
  return { node: svg, redraw, fit, pick, view };
}

/** 面板上那句摘要，和引擎共用一份措辞 */
export const summarize = site.summarize;

/**
 * 远景地标的名字和排位画布**共用一份**（previz.FAR_PRESETS）。
 *
 * 跨场景那条检查按名字配对：场地图上叫「主峰」而场景里叫「山」的话，
 * 它们永远配不上对，那条检查一次也不会响 —— 而两边看起来都摆好了。
 */
const FAR_PRESETS = previz.FAR_PRESETS;

const ELEV = [['低 早晚', 'low'], ['中', 'mid'], ['高 正午', 'high']];

function elDiv(cls, txt) {
  const d = document.createElement('div');
  d.className = cls;
  if (txt) d.textContent = txt;
  return d;
}

/**
 * 整块场地面板：画布 + 控件 + 检查结果。
 *
 * 电脑版和手机版共用这一份 —— 和排位画布是同一条理由：
 * 这里显示的方位、距离、以及"太阳对不对得上"，必须和服务端体检
 * 算出来的是同一套。两端各写一份的话，图上说正北、体检说西北，
 * 而两句话都是我们自己说的。
 *
 * project 只读。所有改动通过 onPlace / onSite 回调出去存盘，
 * 存完由调用方重新拉一份 project 再 render —— 面板自己不改 project，
 * 免得界面上看着存住了、刷新一下就没了。
 */
export function sitePanel(project, {
  onPlace = async () => {},
  onSite = async () => {},
  onGoScene = null
} = {}) {
  const host = elDiv('site-panel');
  const sites = site.sitesOf(project);
  /**
   * 场景清单每次重画都**重新读一遍**，不在建面板时抓一份留着。
   *
   * ⚠ 抓一份留着的后果：在设定集里新加一个场景之后，「摆上来」那一排
   * 里没有它 —— 而它就在同一页上面几厘米的地方列着。用户会以为
   * "这个场景不能摆到图上"，实际上只是这块面板拿的是老名单。
   * 这类"界面记着一份过期的东西"从来不报错，只是功能看起来少了一块。
   */
  const scenesNow = () => (project?.bible?.scenes || []).map((s) => s.name).filter(Boolean);

  /**
   * 当前在看哪片场地。
   *
   * 一片都还没有的时候不能是空白 —— 空白让人以为功能坏了。
   * 给一个默认名字，让第一颗按钮就能点。
   */
  let current = sites[0]?.name || '';
  let draftName = '外景';

  const body = elDiv('site-body');
  host.append(body);

  /** 存位置：先本地改（画布已经改了），再发出去 */
  const savePlace = (scene, place) => onPlace(scene, place);

  function render() {
    while (body.firstChild) body.removeChild(body.firstChild);

    const allScenes = scenesNow();
    const fresh = site.sitesOf(project);
    const model = fresh.find((s) => s.name === current) || fresh[0] || null;
    if (model) current = model.name;

    // ── 还没有任何场地 ──
    if (!model) {
      const empty = elDiv('site-empty');
      empty.append(elDiv('site-empty-title', '还没有场地图'));
      empty.append(elDiv('site-empty-why',
        '把同一个地方的几个场景摆到一张图上，就能看出"大殿在山门外的北边三十米"——'
        + '而这件事决定了"他往北走出画"的下一场接不接得上。外景尤其需要：'
        + '一片山坡上的三场戏，太阳只有一个。'));
      if (!allScenes.length) {
        empty.append(elDiv('site-empty-why', '不过得先有场景 —— 到「设定集」把场景加出来。'));
        body.append(empty);
        return;
      }
      const row = elDiv('site-row');
      const input = document.createElement('input');
      input.className = 'input sm';
      input.value = draftName;
      input.placeholder = '场地名，比如「雪山」';
      input.oninput = () => { draftName = input.value; };
      const go = document.createElement('button');
      go.className = 'btn sm';
      go.textContent = '建一张图，把第一个场景摆上来';
      go.onclick = async () => {
        const name = String(input.value || '').trim() || '外景';
        go.disabled = true;
        try {
          await savePlace(allScenes[0], { site: name, x: 0, y: 0 });
          current = name;
          render();
        } finally { go.disabled = false; }
      };
      row.append(input, go);
      empty.append(row);
      body.append(empty);
      return;
    }

    // ── 场地切换 ──
    if (fresh.length > 1) {
      const tabs = elDiv('site-tabs');
      for (const s of fresh) {
        const b = document.createElement('button');
        b.className = `btn ghost sm${s.name === current ? ' on' : ''}`;
        b.textContent = s.name;
        b.onclick = () => { current = s.name; render(); };
        tabs.append(b);
      }
      body.append(tabs);
    }

    body.append(elDiv('site-summary', site.summarize(model)));

    let picked = null;
    const issueBox = elDiv('site-issues');

    /**
     * 检查结果就地重画。
     *
     * ⚠ 不重画的话会出现这个功能里最糟的一种状态：两个场景已经被拖到
     * 同一个点上了，而下面那块还写着"都对得上"。界面在说一句
     * 它自己刚刚推翻掉的话 —— 比什么都不说更坏。
     */
    function paintIssues() {
      while (issueBox.firstChild) issueBox.removeChild(issueBox.firstChild);
      const issues = [
        ...site.sunIssues(model),
        ...site.farMarkIssues(model),
        ...site.stackedIssues(model)
      ];
      if (!issues.length) {
        /**
         * 没问题也要说话。
         *
         * 一块什么都不显示的区域，人分不清是"查过了没事"还是"根本没查"——
         * 而这两件事的差别正是这个功能的全部价值。
         */
        issueBox.append(elDiv('site-ok', model.places.length >= 2
          ? '这片场地上的太阳和远景地标都对得上。'
          : '再摆一个场景上来，就能开始对太阳和远景地标了。'));
        return;
      }
      for (const one of issues) {
        const item = elDiv('site-issue');
        item.append(elDiv('site-issue-what', one.what));
        item.append(elDiv('site-issue-why', one.why));
        issueBox.append(item);
      }
    }

    const canvas = siteCanvas(model, {
      // 拖动过程中只重画自己那两块读数，不碰网络
      onChange: () => { paintPick(); paintIssues(); },
      // 松手才存
      onCommit: (place) => savePlace(place.scene, { site: model.name, x: place.x, y: place.y }),
      onSite: () => { paintIssues(); onSite(model.name, { marks: model.marks, sun: model.sun }); },
      onPick: (scene) => { picked = scene; paintPick(); }
    });
    body.append(canvas.node);

    const pickBar = elDiv('site-pick');
    body.append(pickBar);
    function paintPick() {
      while (pickBar.firstChild) pickBar.removeChild(pickBar.firstChild);
      if (!picked) {
        pickBar.append(elDiv('site-hint', '拖场景改位置，滚轮缩放，两指捏合也行。点一个场景看它到别处的方位和距离。'));
        return;
      }
      const p = model.places.find((x) => x.scene === picked);
      if (!p) return;
      pickBar.append(elDiv('site-pick-name', picked));
      for (const other of model.places) {
        if (other.scene === picked) continue;
        const line = site.describeBetween(p, other);
        if (line) pickBar.append(elDiv('site-pick-line', line));
      }
      const off = document.createElement('button');
      off.className = 'btn ghost sm';
      off.textContent = '从这张图上拿掉';
      off.title = '只是不在这张图上了，场景本身和它的布局都还在';
      off.onclick = async () => {
        off.disabled = true;
        try { await savePlace(picked, null); picked = null; render(); } finally { off.disabled = false; }
      };
      pickBar.append(off);
      if (onGoScene) {
        const go = document.createElement('button');
        go.className = 'btn ghost sm';
        go.textContent = '去这个场景';
        go.onclick = () => onGoScene(picked);
        pickBar.append(go);
      }
    }
    paintPick();

    // ── 控件 ──
    const tools = elDiv('site-tools');

    const viewRow = elDiv('site-row');
    viewRow.append(Object.assign(document.createElement('span'), { className: 'site-cap', textContent: '视图' }));
    const fitBtn = document.createElement('button');
    fitBtn.className = 'btn ghost sm';
    fitBtn.textContent = '看全部';
    fitBtn.title = '把所有场景装进画面。平移出去找不着东西时按这个';
    fitBtn.onclick = () => canvas.fit();
    viewRow.append(fitBtn);
    tools.append(viewRow);

    /**
     * ── 远景地标 ──
     *
     * 挂在**场地**上，不挂在场景上。一座山在这片地上只有一个方位 ——
     * 每个场景各摆一次的话，摆出来的三个方位一定不一样，
     * 而那正是我们要检查的毛病，不该让界面先制造出来。
     */
    const farRow = elDiv('site-row');
    farRow.append(Object.assign(document.createElement('span'), { className: 'site-cap', textContent: '远景' }));
    for (const { name, deg } of FAR_PRESETS) {
      const has = model.marks.some((m) => m.name === name);
      const b = document.createElement('button');
      b.className = `btn ghost sm${has ? ' on' : ''}`;
      b.textContent = name;
      b.onclick = async () => {
        model.marks = has
          ? model.marks.filter((m) => m.name !== name)
          : [...model.marks, { name, far: true, deg }];
        await onSite(model.name, { marks: model.marks, sun: model.sun });
        render();
      };
      farRow.append(b);
    }
    tools.append(farRow);

    /**
     * ── 太阳 ──
     *
     * 方位靠拖边框上那个圆（画布里），这儿只放高度。
     * 高度决定影子长短 —— 而影子长短是观众判断"这两场是不是同一时间"
     * 最直接的依据，比方位还直接。
     */
    const sunRow = elDiv('site-row');
    sunRow.append(Object.assign(document.createElement('span'), { className: 'site-cap', textContent: '光位' }));
    const onOff = document.createElement('button');
    onOff.className = `btn ghost sm${model.sun ? ' on' : ''}`;
    onOff.textContent = model.sun ? '有太阳' : '加太阳';
    onOff.onclick = async () => {
      model.sun = model.sun ? null : { deg: 135, elev: 'mid' };
      await onSite(model.name, { marks: model.marks, sun: model.sun });
      render();
    };
    sunRow.append(onOff);
    if (model.sun) {
      for (const [label, id] of ELEV) {
        const b = document.createElement('button');
        b.className = `btn ghost sm${model.sun.elev === id ? ' on' : ''}`;
        b.textContent = label;
        b.onclick = async () => {
          model.sun = { ...model.sun, elev: id };
          await onSite(model.name, { marks: model.marks, sun: model.sun });
          render();
        };
        sunRow.append(b);
      }
    }
    tools.append(sunRow);

    // ── 还没摆上来的场景 ──
    const onMap = new Set(model.places.map((p) => p.scene));
    const rest = allScenes.filter((n) => !onMap.has(n));
    if (rest.length) {
      const addRow = elDiv('site-row');
      addRow.append(Object.assign(document.createElement('span'), { className: 'site-cap', textContent: '摆上来' }));
      for (const name of rest.slice(0, 12)) {
        const b = document.createElement('button');
        b.className = 'btn ghost sm';
        b.textContent = name.slice(0, 8);
        b.onclick = async () => {
          b.disabled = true;
          /**
           * 新场景**不要落在原点**。
           *
           * 都落在原点的话，加第二个场景时它正好盖住第一个 ——
           * 看起来像"没加上"，而实际上加上了、只是叠着。
           * 沿一圈螺旋往外摆，每个都在空地上。
           */
          const n = model.places.length;
          const rad = (n * 2.4);
          const r = 12 + n * 4;
          try {
            await savePlace(name, {
              site: model.name,
              x: Number((Math.sin(rad) * r).toFixed(1)),
              y: Number((Math.cos(rad) * r).toFixed(1))
            });
            render();
          } finally { b.disabled = false; }
        };
        addRow.append(b);
      }
      tools.append(addRow);
    }

    body.append(tools);

    body.append(issueBox);
    paintIssues();
  }

  render();
  return { node: host, render };
}
