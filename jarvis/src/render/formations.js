/**
 * 粒子体的造型。每个造型都是同样数量的点（同一个粒子在不同造型里有各自的位置），变形 = 在两套位置之间插值。
 * 全部程序生成，坐标单位与场景一致（光核半径约 27，中心在原点，调用方再整体平移）。
 *
 * face: 正对用户的造型（不自转，跟着视线微微转动）；eyes: 带眼睛的造型。
 * 前 EYE_COUNT 个粒子是“眼睛”：在有脸的造型（core）里聚成两只眼睛，在其他造型里和别的粒子一样参与造型。
 */

export const FORMS = {
  core: { name: '光核', eyes: true },
  nebula: { name: '星云' },
  rings: { name: '聆听环' },
  helix: { name: '思考螺旋' },
  galaxy: { name: '星系' },
  globe: { name: '地球' },
  lattice: { name: '晶格' },
  pages: { face: true, name: '文档' },
  constellation: { name: '记忆星座' },
  clock: { face: true, name: '时钟' },
  eye: { face: true, name: '观察之眼' },
  swarm: { name: '团队' },
  spike: { name: '警觉' },
  heart: { face: true, name: '心' }
};

export const EYE_FRACTION = 0.04;
const TAU = Math.PI * 2;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
/** 近似高斯 */
const gauss = (r) => (r() + r() + r() - 1.5) / 1.5;

/** 均匀分布在球面上的第 i 个点（斐波那契球） */
function fib(i, n) {
  const y = 1 - (2 * (i + 0.5)) / n;
  const q = Math.sqrt(1 - y * y);
  const th = i * 2.399963229728653;
  return [Math.cos(th) * q, y, Math.sin(th) * q];
}

/** 沿一组折线均匀撒点 */
function alongLines(lines, count, r, jitter = 0.4) {
  const lens = lines.map((l) => l.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - l[i][0], p[1] - l[i][1], p[2] - l[i][2]), 0));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  for (let k = 0; k < count; k++) {
    let t = r() * total;
    let li = 0;
    while (li < lines.length - 1 && t > lens[li]) t -= lens[li++];
    const l = lines[li];
    let si = 0;
    for (; si < l.length - 2; si++) {
      const d = Math.hypot(l[si + 1][0] - l[si][0], l[si + 1][1] - l[si][1], l[si + 1][2] - l[si][2]);
      if (t <= d) break;
      t -= d;
    }
    const a = l[si], b = l[si + 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
    const f = Math.min(1, t / d);
    out.push([a[0] + (b[0] - a[0]) * f + gauss(r) * jitter, a[1] + (b[1] - a[1]) * f + gauss(r) * jitter, a[2] + (b[2] - a[2]) * f + gauss(r) * jitter]);
  }
  return out;
}

const circle = (R, n = 96, y = 0, tilt = 0, yaw = 0) => Array.from({ length: n + 1 }, (_, i) => {
  const a = (i / n) * TAU;
  let x = Math.cos(a) * R, z = Math.sin(a) * R, yy = y;
  // 绕 x 轴倾斜，再绕 y 轴转
  [yy, z] = [yy * Math.cos(tilt) - z * Math.sin(tilt), yy * Math.sin(tilt) + z * Math.cos(tilt)];
  [x, z] = [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  return [x, yy, z];
});

/** 眼睛：两个竖椭圆，贴在球面正前方 */
function eyes(count, r, R) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const a = r() * TAU, rr = Math.sqrt(r());
    const x = side * R * 0.3 + Math.cos(a) * rr * R * 0.1;
    const y = R * 0.1 + Math.sin(a) * rr * R * 0.16;
    out.push([x, y, Math.sqrt(Math.max(0, R * R - x * x - y * y)) + 0.6]);
  }
  return out;
}

const GEN = {
  core(n, r) {
    const R = 27;
    const out = [];
    const shell = Math.floor(n * 0.86);
    for (let i = 0; i < shell; i++) { const p = fib(i, shell); const k = R * (1 + gauss(r) * 0.015); out.push([p[0] * k, p[1] * k, p[2] * k]); }
    while (out.length < n) { const p = fib(Math.floor(r() * 4000), 4000); const k = R * Math.pow(r(), 0.4) * 0.6; out.push([p[0] * k, p[1] * k, p[2] * k]); }
    return out;
  },
  nebula(n, r) {
    return Array.from({ length: n }, () => {
      const p = fib(Math.floor(r() * 10000), 10000);
      const k = 44 * Math.pow(r(), 0.5);
      const swirl = Math.sin(p[1] * 3 + p[0] * 2) * 6;
      return [p[0] * k + swirl, p[1] * k * 0.6, p[2] * k * 0.8 - swirl * 0.5];
    });
  },
  rings(n, r) {
    const lines = [circle(18, 96, 0, Math.PI / 2), circle(26, 128, 0, Math.PI / 2.4, 0.5), circle(34, 160, 0, Math.PI / 2.8, -0.6), circle(42, 192, 0, Math.PI / 2, 0)];
    const core = GEN.core(Math.floor(n * 0.25), r).map((p) => p.map((v) => v * 0.35));
    return [...core, ...alongLines(lines, n - core.length, r, 0.5)];
  },
  helix(n, r) {
    const H = 72, R = 15, turns = 2.6;
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = r();
      const y = (t - 0.5) * H;
      const a = t * turns * TAU;
      if (i % 7 === 0) {
        // 碱基对：两条链之间的横档
        const f = r();
        const ta = Math.floor(t * 28) / 28, aa = ta * turns * TAU, yy = (ta - 0.5) * H;
        out.push([Math.cos(aa) * R * (1 - 2 * f), yy, Math.sin(aa) * R * (1 - 2 * f)]);
      } else {
        const s = i % 2 ? 0 : Math.PI;
        out.push([Math.cos(a + s) * R + gauss(r) * 0.7, y + gauss(r) * 0.7, Math.sin(a + s) * R + gauss(r) * 0.7]);
      }
    }
    return out;
  },
  galaxy(n, r) {
    const arms = 3;
    return Array.from({ length: n }, (_, i) => {
      if (i % 9 === 0) { const p = fib(i, n); const k = 6 * r(); return [p[0] * k, p[1] * k * 0.6, p[2] * k]; }
      const d = Math.pow(r(), 0.7) * 50;
      const arm = (i % arms) * (TAU / arms);
      const a = arm + d * 0.11 + gauss(r) * (0.25 + d * 0.004);
      const x = Math.cos(a) * d, z = Math.sin(a) * d, y = gauss(r) * (3 - d * 0.04);
      // 朝镜头倾斜
      return [x, y * Math.cos(0.9) - z * Math.sin(0.9), y * Math.sin(0.9) + z * Math.cos(0.9)];
    });
  },
  globe(n, r) {
    const R = 30;
    const lines = [];
    for (let k = -3; k <= 3; k++) { const lat = (k / 4) * (Math.PI / 2); lines.push(circle(R * Math.cos(lat), 96, R * Math.sin(lat))); }
    for (let k = 0; k < 8; k++) {
      const lon = (k / 8) * Math.PI;
      lines.push(Array.from({ length: 65 }, (_, i) => { const a = (i / 64) * TAU; return [Math.cos(a) * R * Math.cos(lon), Math.sin(a) * R, Math.cos(a) * R * Math.sin(lon)]; }));
    }
    const grid = alongLines(lines, Math.floor(n * 0.7), r, 0.25);
    // 大陆：球面上几块随机斑块
    const blobs = Array.from({ length: 7 }, () => fib(Math.floor(r() * 500), 500));
    while (grid.length < n) {
      const b = blobs[Math.floor(r() * blobs.length)];
      const p = [b[0] + gauss(r) * 0.25, b[1] + gauss(r) * 0.18, b[2] + gauss(r) * 0.25];
      const l = Math.hypot(...p) || 1;
      grid.push(p.map((v) => (v / l) * R));
    }
    return grid;
  },
  lattice(n, r) {
    const S = 20, step = 10;
    const lines = [];
    for (let a = -S; a <= S; a += step) for (let b = -S; b <= S; b += step) {
      lines.push([[a, b, -S], [a, b, S]], [[a, -S, b], [a, S, b]], [[-S, a, b], [S, a, b]]);
    }
    const out = alongLines(lines, n, r, 0.25);
    // 节点更亮更密
    for (let i = 0; i < n; i += 6) out[i] = [Math.round(out[i][0] / step) * step, Math.round(out[i][1] / step) * step, Math.round(out[i][2] / step) * step].map((v) => v + gauss(r) * 0.6);
    return out;
  },
  pages(n, r) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const page = i % 3;
      const W = 30, H = 40;
      const x0 = (page - 1) * 9, z0 = (1 - page) * 6, y0 = (page - 1) * -3;
      let x, y;
      if (r() < 0.3) { // 边框
        const t = r() * 2 * (W + H);
        [x, y] = t < W ? [t, 0] : t < W + H ? [W, t - W] : t < 2 * W + H ? [2 * W + H - t, H] : [0, 2 * (W + H) - t];
      } else { // 文字行
        const line = Math.floor(r() * 9);
        x = 4 + r() * (line === 0 ? 14 : W - 8 - (line % 3) * 4);
        y = H - 6 - line * 4;
      }
      const px = x - W / 2, py = y - H / 2;
      out.push([px * Math.cos(-0.3) + x0 + gauss(r) * 0.2, py + y0, px * Math.sin(-0.3) + z0 + gauss(r) * 0.2]);
    }
    return out;
  },
  constellation(n, r) {
    const nodes = Array.from({ length: 22 }, () => { const p = fib(Math.floor(r() * 2000), 2000); const k = 14 + r() * 26; return p.map((v) => v * k); });
    const lines = [];
    nodes.forEach((a, i) => {
      const near = nodes.map((b, j) => [j, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])]).filter(([j]) => j !== i).sort((x, y) => x[1] - y[1]).slice(0, 2);
      for (const [j] of near) if (j > i) lines.push([a, nodes[j]]);
    });
    const links = alongLines(lines, Math.floor(n * 0.45), r, 0.15);
    const stars = Array.from({ length: n - links.length }, () => { const c = nodes[Math.floor(r() * nodes.length)]; return [c[0] + gauss(r) * 1.6, c[1] + gauss(r) * 1.6, c[2] + gauss(r) * 1.6]; });
    return [...stars, ...links];
  },
  clock(n, r) {
    const R = 34;
    const lines = [circle(R, 192, 0, Math.PI / 2), circle(R - 3, 160, 0, Math.PI / 2)];
    for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; const l = k % 3 ? 4 : 7; lines.push([[Math.cos(a) * (R - 5), Math.sin(a) * (R - 5), 0], [Math.cos(a) * (R - 5 - l), Math.sin(a) * (R - 5 - l), 0]]); }
    lines.push([[0, 0, 0], [0, 22, 0]], [[0, 0, 0], [15, -9, 0]]);
    return alongLines(lines, n, r, 0.3);
  },
  eye(n, r) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = r();
      if (k < 0.45) { // 眼眶：两条弧
        const t = r() * 2 - 1, top = r() < 0.5 ? 1 : -1;
        out.push([t * 44 + gauss(r) * 0.4, top * 20 * (1 - t * t) + gauss(r) * 0.4, gauss(r) * 1.2]);
      } else if (k < 0.8) { // 虹膜环
        const a = r() * TAU, rr = 10 + r() * 7;
        out.push([Math.cos(a) * rr, Math.sin(a) * rr, 2 + gauss(r) * 0.5]);
      } else { // 瞳孔
        const a = r() * TAU, rr = Math.sqrt(r()) * 5;
        out.push([Math.cos(a) * rr, Math.sin(a) * rr, 3]);
      }
    }
    return out;
  },
  swarm(n, r) {
    const centers = [[0, 0, 0], ...Array.from({ length: 5 }, (_, k) => { const a = (k / 5) * TAU; return [Math.cos(a) * 34, Math.sin(a * 2) * 6, Math.sin(a) * 34]; })];
    return Array.from({ length: n }, (_, i) => {
      const c = centers[i % 4 === 0 ? 0 : 1 + (i % 5)];
      const R = c === centers[0] ? 13 : 7;
      const p = fib(Math.floor(r() * 3000), 3000);
      return [c[0] + p[0] * R, c[1] + p[1] * R, c[2] + p[2] * R];
    });
  },
  spike(n, r) {
    const dirs = Array.from({ length: 20 }, (_, i) => fib(i, 20));
    return Array.from({ length: n }, (_, i) => {
      if (i % 3) { const p = fib(Math.floor(r() * 3000), 3000); return p.map((v) => v * 16); }
      const d = dirs[i % dirs.length];
      const t = Math.pow(r(), 1.5);
      return d.map((v) => v * (16 + t * 30) + gauss(r) * (1 - t) * 1.2);
    });
  },
  heart(n, r) {
    return Array.from({ length: n }, () => {
      const t = r() * TAU;
      const s = Math.pow(r(), 0.35);
      const x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      return [x * 2 * s, y * 2 * s + 4, gauss(r) * 6 * s];
    });
  }
};

/**
 * 生成一个造型的位置数组（Float32Array，长度 n*3）。眼睛粒子在 core 里聚成眼睛，其余造型里正常参与。
 */
export function buildForm(name, n, seed = 7) {
  const gen = GEN[name] ?? GEN.core;
  const r = rng(seed + name.length * 131 + name.charCodeAt(0));
  const eyeN = Math.floor(n * EYE_FRACTION);
  const pts = name === 'core' ? [...eyes(eyeN, r, 27), ...gen(n - eyeN, r)] : gen(n, r);
  // 打乱顺序（眼睛除外），让变形时粒子从各处飞来，而不是成片平移
  const body = name === 'core' ? pts.slice(eyeN) : pts.slice(eyeN);
  for (let i = body.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [body[i], body[j]] = [body[j], body[i]]; }
  const ordered = [...pts.slice(0, eyeN), ...body];
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set(ordered[i] ?? [0, 0, 0], i * 3);
  return out;
}
