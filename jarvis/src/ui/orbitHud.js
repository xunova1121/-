/**
 * 轨道 HUD：围绕粒子体的一圈“仪表”，把智能体正在做的事画出来，而不是只转一个加载圈。
 *
 *   - 刻度环（慢速旋转）+ 沿上方弧线的状态文字（造型 · 连接 · 模型）
 *   - 左右两条弧形仪表：CPU / 内存（本机网关或浏览器估算）
 *   - 任务卫星：这一轮调用的每个工具是轨道上的一个节点；进行中的节点发光，并有一道“数据光束”连到粒子体；
 *     完成变实心，失败变红。下一轮开始时淡出
 *   - 思考流：舞台角落的等宽日志，逐字打出每一步在做什么
 *
 * 位置跟着粒子体（stage.anchor()）走；页面不可见时停止刷新。
 */
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** 圆弧路径（角度从正上方顺时针，单位度） */
export function arcPath(cx, cy, r, from, to) {
  const p = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(from);
  const [x1, y1] = p(to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} ${to > from ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** 第 i 个卫星的角度：从右上方开始沿轨道排开，最多 8 个，多了就挤一挤 */
export function satelliteAngle(i, n) {
  const span = Math.min(200, 26 * Math.max(1, n - 1));
  return n <= 1 ? 50 : 50 + (span * i) / (n - 1);
}

export function initOrbitHud({ root, getAnchor, reducedMotion = () => false }) {
  const svg = svgEl('svg', { class: 'orbit-hud', 'aria-hidden': 'true' });
  const defs = svgEl('defs');
  const textArc = svgEl('path', { id: 'orbit-text-arc' });
  defs.append(textArc);
  const ticks = svgEl('g', { class: 'oh-ticks' });
  const ring = svgEl('circle', { class: 'oh-ring' });
  const ring2 = svgEl('circle', { class: 'oh-ring2' });
  const cpuBg = svgEl('path', { class: 'oh-gauge-bg' });
  const cpu = svgEl('path', { class: 'oh-gauge' });
  const memBg = svgEl('path', { class: 'oh-gauge-bg' });
  const mem = svgEl('path', { class: 'oh-gauge mem' });
  const cpuT = svgEl('text', { class: 'oh-label', 'text-anchor': 'end' });
  const memT = svgEl('text', { class: 'oh-label', 'text-anchor': 'start' });
  const status = svgEl('text', { class: 'oh-status' });
  const statusPath = svgEl('textPath', { href: '#orbit-text-arc', startOffset: '50%', 'text-anchor': 'middle' });
  status.append(statusPath);
  const beam = svgEl('line', { class: 'oh-beam' });
  const sats = svgEl('g', { class: 'oh-sats' });
  svg.append(defs, ring2, ring, ticks, cpuBg, cpu, memBg, mem, cpuT, memT, status, beam, sats);
  root.append(svg);

  const log = document.createElement('div');
  log.className = 'thought-log';
  log.setAttribute('aria-hidden', 'true');
  log.innerHTML = '<div class="tl-head">THOUGHT STREAM</div><ol></ol>';
  root.append(log);
  const logList = log.querySelector('ol');

  let tickR = 0;
  const metrics = { cpu: 0, mem: 0 };
  let statusText = '';
  /** @type {{ id: string, label: string, state: 'run'|'ok'|'fail' }[]} */
  let satellites = [];
  let fading = false;

  function buildTicks(r) {
    if (Math.abs(r - tickR) < 2) return;
    tickR = r;
    ticks.replaceChildren();
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const long = i % 10 === 0;
      const r0 = r, r1 = r + (long ? 9 : 4);
      ticks.append(svgEl('line', { x1: (Math.sin(a) * r0).toFixed(1), y1: (-Math.cos(a) * r0).toFixed(1), x2: (Math.sin(a) * r1).toFixed(1), y2: (-Math.cos(a) * r1).toFixed(1), class: long ? 'long' : '' }));
    }
  }

  function layout() {
    const a = getAnchor();
    const w = root.clientWidth, h = root.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // 舞台被隐藏（如工作台的“对话”视图）时尺寸为 0，光核半径可能算成负数：不画
    if (!a || !(a.r > 4) || !w || !h) { svg.style.opacity = '0'; return; }
    svg.style.opacity = '';
    const { x, y } = a;
    const R = a.r * 1.9;
    buildTicks(R);
    ticks.setAttribute('transform', `translate(${x} ${y})`);
    for (const [c, r] of [[ring, R - 6], [ring2, R + 16]]) { c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', r); }
    // 仪表：左侧 CPU（从 220° 到 320°），右侧内存（从 40° 到 140°）
    const gR = R + 26;
    cpuBg.setAttribute('d', arcPath(x, y, gR, 220, 320));
    memBg.setAttribute('d', arcPath(x, y, gR, 40, 140));
    cpu.setAttribute('d', arcPath(x, y, gR, 320 - 100 * Math.max(0.02, metrics.cpu), 320));
    mem.setAttribute('d', arcPath(x, y, gR, 40, 40 + 100 * Math.max(0.02, metrics.mem)));
    const lp = (deg, r) => [x + r * Math.sin((deg * Math.PI) / 180), y - r * Math.cos((deg * Math.PI) / 180)];
    const [cx, cy] = lp(306, gR + 12);
    const [mx, my] = lp(54, gR + 12);
    cpuT.setAttribute('x', cx); cpuT.setAttribute('y', cy); cpuT.textContent = `CPU ${Math.round(metrics.cpu * 100)}%`;
    memT.setAttribute('x', mx); memT.setAttribute('y', my); memT.textContent = `MEM ${Math.round(metrics.mem * 100)}%`;
    textArc.setAttribute('d', arcPath(x, y, R + 34, -42, 42));
    statusPath.textContent = statusText;
    // 卫星
    const oR = R + 4;
    let active = null;
    sats.replaceChildren(...satellites.map((s, i) => {
      const deg = satelliteAngle(i, satellites.length);
      const [sx, sy] = lp(deg, oR);
      const g = svgEl('g', { class: `oh-sat ${s.state}`, transform: `translate(${sx.toFixed(1)} ${sy.toFixed(1)})` });
      g.append(svgEl('circle', { r: 5 }), svgEl('circle', { r: 10, class: 'halo' }));
      const right = Math.sin((deg * Math.PI) / 180) >= 0;
      const t = svgEl('text', { x: right ? 14 : -14, y: 4, 'text-anchor': right ? 'start' : 'end' });
      t.textContent = s.label;
      g.append(t);
      if (s.state === 'run') active = [sx, sy];
      return g;
    }));
    if (active) {
      beam.setAttribute('x1', x); beam.setAttribute('y1', y); beam.setAttribute('x2', active[0]); beam.setAttribute('y2', active[1]);
      beam.style.opacity = '1';
    } else beam.style.opacity = '0';
  }

  let raf = 0;
  let last = 0;
  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < (reducedMotion() ? 500 : 33)) return;
    last = t;
    layout();
  }
  const start = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();

  /** 往思考流里加一行（逐字打出） */
  function think(text, kind = '') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    li.dataset.t = stamp.slice(3);
    logList.append(li);
    while (logList.children.length > 6) logList.firstElementChild.remove();
    const full = String(text).slice(0, 80);
    if (reducedMotion()) { li.textContent = full; return; }
    let i = 0;
    const type = () => { li.textContent = full.slice(0, (i += 2)); if (i < full.length) setTimeout(type, 16); };
    type();
  }

  return {
    think,
    setStatus(text) { statusText = text; },
    setMetrics({ cpu, mem }) {
      if (Number.isFinite(cpu)) metrics.cpu = Math.max(0, Math.min(1, cpu));
      if (Number.isFinite(mem)) metrics.mem = Math.max(0, Math.min(1, mem));
    },
    /** 新一轮开始：上一轮的卫星淡出 */
    newTurn() {
      if (!satellites.length) return;
      fading = true;
      sats.classList.add('fade');
      setTimeout(() => { if (fading) { satellites = []; sats.classList.remove('fade'); fading = false; } }, 400);
    },
    toolStart(id, label) {
      if (fading) { satellites = []; sats.classList.remove('fade'); fading = false; }
      satellites = [...satellites.slice(-7), { id, label, state: 'run' }];
    },
    toolEnd(id, ok) {
      satellites = satellites.map((s) => (s.id === id ? { ...s, state: ok ? 'ok' : 'fail' } : s));
    },
    get satellites() { return satellites; },
    dispose() { stop(); svg.remove(); log.remove(); }
  };
}
