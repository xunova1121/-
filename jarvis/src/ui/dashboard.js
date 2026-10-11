/**
 * 右侧悬浮仪表（需求 8）。
 *
 *  - 指针视差：指针相对窗口中心的偏移驱动分层位移，最表层 12px、最深层 3px（CSS translate3d）。
 *  - 透视倾斜：指针靠近仪表时整体绕 Y 轴 ≤ 6°、绕 X 轴 ≤ 3°，弹簧跟随（stiffness 0.08 / damping 0.85）。
 *  - 悬停光晕：悬停的指标周围叠一层径向渐变，颜色取该指标当前数值色，200ms 透明度过渡。
 *  - 指针移出窗口 / 离开仪表区域：所有目标归零，弹簧缓动回位（约 600ms）。
 *
 * 弹簧只在“未收敛”时跑 rAF，静止时不占 CPU。减少动画模式下视差与倾斜全部停用。
 */
import { Spring } from '../core/spring.js';
import { EMOTIONS } from '../core/emotions.js';

const DEPTH = { back: 3, mid: 7, front: 12 };
const NEAR_PX = 140;

/** 指标数值 → 颜色：> 80% 红，< 30% 蓝，中间琥珀 */
export function metricColor(pct) {
  if (pct == null || Number.isNaN(pct)) return 'hsl(200 15% 55%)';
  if (pct > 80) return 'hsl(0 85% 60%)';
  if (pct < 30) return 'hsl(200 90% 60%)';
  return 'hsl(38 95% 58%)';
}

function gauge(id, label) {
  const C = 2 * Math.PI * 34;
  return `
  <div class="gauge layer" data-depth="front" data-metric="${id}">
    <svg viewBox="0 0 86 86" role="img" aria-label="${label}">
      <circle class="track" cx="43" cy="43" r="34" />
      <circle class="arc" id="g-${id}" cx="43" cy="43" r="34" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 43 43)" />
      <text x="43" y="43" id="t-${id}">—</text>
    </svg>
    <span>${label}</span>
  </div>`;
}

export class Dashboard {
  constructor(root, { onEmotionPick } = {}) {
    this.root = root;
    this.onEmotionPick = onEmotionPick;
    this.motion = true;
    this.memHistory = [];
    this.turns = 0;
    this.task = 'idle';
    this.connected = false;
    root.innerHTML = `
      <div class="dash-tilt">
        <section class="panel" data-panel="status">
          <div class="glow"></div>
          <h3 class="layer" data-depth="back">系统状态</h3>
          <div class="gauges">${gauge('cpu', '计算')}${gauge('mem', '内存')}${gauge('net', '网络')}</div>
        </section>
        <section class="panel" data-panel="memory" data-metric="mem">
          <div class="glow"></div>
          <h3 class="layer" data-depth="back">内存</h3>
          <span class="status" data-conn>待连接</span>
          <canvas class="layer" data-depth="mid" id="c-mem"></canvas>
        </section>
        <section class="panel" data-panel="task" data-metric="task">
          <div class="glow"></div>
          <h3 class="layer" data-depth="back">任务</h3>
          <span class="status" data-conn>待连接</span>
          <div class="big-number layer" data-depth="front"><span id="task-label">空闲</span><small id="task-sub"></small></div>
          <canvas class="layer" data-depth="mid" id="c-task" style="height: calc(100% - 80px)"></canvas>
        </section>
        <section class="panel" data-panel="exp">
          <div class="glow"></div>
          <h3 class="layer" data-depth="back">经验</h3>
          <span class="status"><span id="exp-turns">0 轮</span></span>
          <div class="emotion-picker" id="emotion-picker" hidden role="group" aria-label="情绪手动覆盖">
            <button type="button" data-emotion="auto">自动</button>
            ${EMOTIONS.map((e) => `<button type="button" data-emotion="${e}">${e}</button>`).join('')}
          </div>
          <div class="emotion-row layer" data-depth="front">
            <span class="muted" style="margin:0">情绪状态</span>
            <button class="emotion-btn" id="emotion-btn" type="button" aria-expanded="false" aria-controls="emotion-picker" title="点击手动锁定情绪">
              <span class="ring" aria-hidden="true"></span><span id="emotion-name">平静</span>
            </button>
          </div>
        </section>
      </div>`;
    this.tilt = root.querySelector('.dash-tilt');
    this.layers = [...root.querySelectorAll('.layer')].map((el) => ({
      el, depth: DEPTH[el.dataset.depth] ?? 5, x: new Spring(0), y: new Spring(0)
    }));
    this.rotX = new Spring(0);
    this.rotY = new Spring(0);
    this.raf = 0;
    this.#bindPointer();
    this.#bindPicker();
    this.#resizeCanvases();
    new ResizeObserver(() => { this.#resizeCanvases(); this.#drawMem(); this.#drawTask(); }).observe(root);
  }

  setMotion(on) {
    this.motion = on;
    if (!on) this.#resetTargets(true);
  }

  // ---------- 数据 ----------
  setMetrics(m) {
    this.connected = true;
    this.root.querySelectorAll('[data-conn]').forEach((el) => { el.textContent = '已连接'; });
    const cpu = m?.cpu?.percent;
    const mem = m?.memory?.percent;
    // 网络：在线时按吞吐量映射到 0–100（对数刻度，1MB/s ≈ 100）
    const kbps = (m?.network?.rxKBps ?? 0) + (m?.network?.txKBps ?? 0);
    const net = m?.network?.online === false ? 0 : Math.min(100, (Math.log10(1 + kbps) / 3) * 100);
    this.#setGauge('cpu', cpu, cpu == null ? '—' : `${Math.round(cpu)}%`);
    this.#setGauge('mem', mem, mem == null ? '—' : `${Math.round(mem)}%`);
    this.#setGauge('net', net, m?.network?.online === false ? '离线' : kbps < 1 ? '在线' : `${kbps < 1000 ? Math.round(kbps) + 'K' : (kbps / 1024).toFixed(1) + 'M'}`);
    if (mem != null) {
      this.memHistory.push(mem);
      if (this.memHistory.length > 40) this.memHistory.shift();
      this.#drawMem();
    }
    this.root.querySelector('[data-panel="memory"]').style.setProperty('--glow-color', metricColor(mem));
    this.metrics = m;
  }

  setDisconnected() {
    this.connected = false;
    this.root.querySelectorAll('[data-conn]').forEach((el) => { el.textContent = '待连接'; });
    for (const id of ['cpu', 'mem', 'net']) this.#setGauge(id, null, '—');
  }

  setEmotion(name, hue) {
    this.root.querySelector('#emotion-name').textContent = name;
    if (hue != null) {
      this.hue = hue;
      this.#drawMem();
      this.#drawTask();
    }
  }

  /** 小图直接用目标色相绘制（CSS 的 --accent 在 400ms 过渡中途读到的是中间色） */
  #accent() {
    return this.hue == null ? 'hsl(200 90% 60%)' : `hsl(${this.hue} 90% 60%)`;
  }

  setManualEmotion(value) {
    this.root.querySelectorAll('[data-emotion]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.emotion === value)));
  }

  setTask(state, sub = '') {
    this.task = state;
    const label = { idle: '空闲', listening: '聆听', processing: '处理中', error: '异常', done: '完成' }[state] ?? state;
    this.root.querySelector('#task-label').textContent = label;
    this.root.querySelector('#task-sub').textContent = sub;
    const pct = { idle: 10, listening: 45, processing: 75, error: 95, done: 20 }[state] ?? 10;
    this.root.querySelector('[data-panel="task"]').style.setProperty('--glow-color', metricColor(pct));
    this.#drawTask();
  }

  setTurns(n) {
    this.turns = n;
    this.root.querySelector('#exp-turns').textContent = `${n} 轮`;
  }

  #setGauge(id, pct, text) {
    const arc = this.root.querySelector(`#g-${id}`);
    const C = 2 * Math.PI * 34;
    arc.style.strokeDashoffset = String(C * (1 - (pct ?? 0) / 100));
    const color = metricColor(pct);
    arc.style.setProperty('--metric-color', color);
    arc.closest('[data-metric]').style.setProperty('--glow-color', color);
    this.root.querySelector(`#t-${id}`).textContent = text;
  }

  // ---------- 小图 ----------
  #resizeCanvases() {
    for (const c of this.root.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    }
  }

  #drawMem() {
    const c = this.root.querySelector('#c-mem');
    const g = c.getContext('2d');
    const { width: w, height: h } = c;
    g.clearRect(0, 0, w, h);
    const accent = this.#accent();
    g.strokeStyle = 'rgba(255,255,255,.06)';
    for (let x = 0; x < w; x += w / 12) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    const data = this.memHistory;
    if (data.length < 2) {
      g.fillStyle = 'rgba(255,255,255,.3)';
      g.font = `${12 * (w / c.clientWidth || 1)}px sans-serif`;
      g.fillText(this.connected ? '采集中…' : '等待本机接口', 6, h / 2);
      return;
    }
    const lo = Math.max(0, Math.min(...data) - 5);
    const hi = Math.min(100, Math.max(...data) + 5);
    g.lineWidth = 2 * (window.devicePixelRatio || 1);
    g.strokeStyle = accent;
    g.shadowColor = accent;
    g.shadowBlur = 10;
    g.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - lo) / Math.max(1, hi - lo)) * h * 0.8 - h * 0.1;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
    g.shadowBlur = 0;
  }

  /** 任务活跃度：点阵波形，振幅随任务状态变化（静态绘制，不做持续动画） */
  #drawTask() {
    const c = this.root.querySelector('#c-task');
    if (!c) return;
    const g = c.getContext('2d');
    const { width: w, height: h } = c;
    g.clearRect(0, 0, w, h);
    const amp = { idle: 0.08, listening: 0.3, processing: 0.42, error: 0.45, done: 0.15 }[this.task] ?? 0.1;
    g.fillStyle = this.#accent();
    const dpr = window.devicePixelRatio || 1;
    for (let i = 0; i < 260; i++) {
      const x = (i / 260) * w;
      const env = Math.exp(-Math.pow((i / 260 - 0.45) * 3.2, 2));
      for (let k = 0; k < 3; k++) {
        const y = h / 2 + Math.sin(i * 0.11 + k * 1.7) * env * amp * h * (1 - k * 0.25) + Math.sin(i * 1.7 + k) * h * 0.03;
        g.globalAlpha = 0.25 + env * 0.6;
        g.fillRect(x, y, 1.6 * dpr, 1.6 * dpr);
      }
    }
    g.globalAlpha = 1;
  }

  // ---------- 情绪选择器（可收起） ----------
  #bindPicker() {
    const btn = this.root.querySelector('#emotion-btn');
    const picker = this.root.querySelector('#emotion-picker');
    // 选择器打开期间冻结视差与倾斜：别让按钮在指针下面移动
    btn.addEventListener('click', () => {
      picker.hidden = !picker.hidden;
      btn.setAttribute('aria-expanded', String(!picker.hidden));
      if (!picker.hidden) this.#resetTargets();
    });
    picker.addEventListener('click', (e) => {
      const v = e.target.closest('[data-emotion]')?.dataset.emotion;
      if (!v) return;
      this.onEmotionPick?.(v);
      picker.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  // ---------- 视差 / 倾斜 / 光晕 ----------
  #bindPointer() {
    window.addEventListener('pointermove', (e) => {
      if (!this.motion || e.pointerType === 'touch') return;
      if (!this.root.querySelector('#emotion-picker').hidden) return;
      const rect = this.root.getBoundingClientRect();
      const near = e.clientX > rect.left - NEAR_PX && e.clientX < rect.right + NEAR_PX
        && e.clientY > rect.top - NEAR_PX && e.clientY < rect.bottom + NEAR_PX;
      if (!near) return this.#resetTargets();
      // 视差：指针相对窗口中心，-1..1
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      for (const l of this.layers) {
        l.x.target = -nx * l.depth;
        l.y.target = -ny * l.depth;
      }
      // 倾斜：指针相对仪表几何中心
      const cx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2 + NEAR_PX);
      const cy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2 + NEAR_PX);
      this.rotY.target = clamp(cx, -1, 1) * 6;
      this.rotX.target = -clamp(cy, -1, 1) * 3;
      this.#kick();
    }, { passive: true });

    document.documentElement.addEventListener('mouseleave', () => this.#resetTargets());
    window.addEventListener('blur', () => this.#resetTargets());

    for (const panel of this.root.querySelectorAll('.panel')) {
      panel.addEventListener('pointermove', (e) => {
        const r = panel.getBoundingClientRect();
        const target = e.target.closest('[data-metric]');
        const color = target ? getComputedStyle(target).getPropertyValue('--glow-color') : '';
        panel.style.setProperty('--gx', `${e.clientX - r.left}px`);
        panel.style.setProperty('--gy', `${e.clientY - r.top}px`);
        if (color) panel.querySelector('.glow').style.setProperty('--glow-color', color.trim());
        panel.classList.toggle('hovering', Boolean(target || panel.dataset.metric));
      });
      panel.addEventListener('pointerleave', () => panel.classList.remove('hovering'));
    }
  }

  #resetTargets(immediate = false) {
    for (const l of this.layers) {
      l.x.target = 0;
      l.y.target = 0;
      if (immediate) { l.x.value = l.y.value = l.x.velocity = l.y.velocity = 0; }
    }
    this.rotX.target = 0;
    this.rotY.target = 0;
    if (immediate) {
      this.rotX.value = this.rotY.value = this.rotX.velocity = this.rotY.velocity = 0;
      this.#render();
    } else this.#kick();
  }

  #kick() {
    if (this.raf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(now - last, 100);
      last = now;
      let moving = false;
      for (const s of [this.rotX, this.rotY, ...this.layers.flatMap((l) => [l.x, l.y])]) {
        s.step(dt);
        if (!s.settled) moving = true;
      }
      this.#render();
      this.raf = moving ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  #render() {
    this.tilt.style.transform = `rotateX(${this.rotX.value.toFixed(3)}deg) rotateY(${this.rotY.value.toFixed(3)}deg)`;
    for (const l of this.layers) {
      l.el.style.transform = `translate3d(${l.x.value.toFixed(2)}px, ${l.y.value.toFixed(2)}px, ${l.depth}px)`;
    }
  }
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
