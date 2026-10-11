/**
 * 粒子几何（需求 3.1–3.3）。每个粒子同时携带两套坐标：
 *   a_humanPosition   人形点云坐标（Cesium Man 采样）
 *   a_spherePosition  粒子核心坐标（球面 / 体内 / 轨道参数，见 kind）
 *   a_meta            (kind, seed, contour, ring)
 *       kind 0 球面粒子层   a_spherePosition = 单位球面坐标
 *       kind 1 轨道环粒子   a_spherePosition = (半径倍率, 倾角, 相位)，轨迹在顶点着色器里参数化生成
 *       kind 2 内部体积粒子 a_spherePosition = 单位球内坐标（半径 0.3–1.0）
 *
 * 形态切换只改一个 uniform（u_morphFactor），CPU 不做逐顶点循环。
 */
export const HUMAN_COUNT = 4600;
export const INTERIOR_COUNT = 1200;
export const ORBIT_SHARE = 0.15;

/** 三条轨道环：半径倍率、基准倾角、绕 Y 轴相位。粒子与轨道线共用这组参数 */
export const RINGS = [
  { radius: 1.22, tilt: 0.38, phase: 0.0 },
  { radius: 1.42, tilt: -0.52, phase: 1.9 },
  { radius: 1.55, tilt: 0.95, phase: 3.7 }
];

export const CORE_RADIUS = 34;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 斐波那契球面：y 从 +1 到 -1 单调递减，点分布均匀 */
function fibonacciSphere(n) {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out[i * 3] = Math.cos(golden * i) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(golden * i) * r;
  }
  return out;
}

/**
 * @param {Float32Array} human  每点 (x, y, z, contour)，共 4600 点
 * @param {{ lowEnd?: boolean }} opts  低端设备：粒子降到 40%，只保留人形 + 球面层
 */
export function buildParticles(human, { lowEnd = false, seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const total = human.length / 4;

  // 低端设备按步长抽取 40% 的人形点
  let src = [...Array(total).keys()];
  if (lowEnd) src = src.filter((_, i) => i % 5 < 2);

  const interior = lowEnd ? 0 : INTERIOR_COUNT;
  const count = src.length + interior;
  const orbitCount = lowEnd ? 0 : Math.round(count * ORBIT_SHARE);

  // 按高度排序后再与斐波那契球面一一对应：头顶的点飞向北极、脚底的点飞向南极，形变不交叉乱飞
  src.sort((a, b) => human[b * 4 + 1] - human[a * 4 + 1]);

  // 从人形点里等距挑出轨道粒子（剩下的进球面层）
  const isOrbit = new Uint8Array(src.length);
  if (orbitCount) {
    const step = src.length / orbitCount;
    for (let k = 0; k < orbitCount; k++) isOrbit[Math.floor(k * step + rnd() * step * 0.999)] = 1;
  }
  const shellCount = src.length - orbitCount;
  const sphere = fibonacciSphere(shellCount);

  const humanPos = new Float32Array(count * 3);
  const spherePos = new Float32Array(count * 3);
  const meta = new Float32Array(count * 4);

  let shellIdx = 0;
  let orbitIdx = 0;
  src.forEach((h, i) => {
    humanPos.set([human[h * 4], human[h * 4 + 1], human[h * 4 + 2]], i * 3);
    const contour = human[h * 4 + 3];
    if (isOrbit[i]) {
      const ring = orbitIdx++ % RINGS.length;
      const r = RINGS[ring];
      spherePos.set([r.radius * (1 + (rnd() - 0.5) * 0.03), r.tilt, r.phase], i * 3);
      meta.set([1, rnd(), contour, ring], i * 4);
    } else {
      spherePos.set(sphere.subarray(shellIdx * 3, shellIdx * 3 + 3), i * 3);
      shellIdx++;
      meta.set([0, rnd(), contour, 0], i * 4);
    }
  });

  // 内部体积粒子：人形下聚成胸口的“心脏”光团；核心形态下分布在 0.3–1.0 半径的球体内，
  // 半径取 sqrt 分布 —— 越靠核心越稀疏
  for (let k = 0; k < interior; k++) {
    const i = src.length + k;
    const g = () => (rnd() + rnd() + rnd() - 1.5) * 2;
    humanPos.set([g() * 3.2, g() * 3.2 - 1, g() * 2 + 3], i * 3);
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const rr = 0.3 + 0.7 * Math.sqrt(rnd());
    const s = Math.sqrt(1 - u * u);
    spherePos.set([Math.cos(th) * s * rr, u * rr, Math.sin(th) * s * rr], i * 3);
    meta.set([2, rnd(), 0, 0], i * 4);
  }

  return { count, humanPos, spherePos, meta, orbitCount, interior };
}

/** 背景星尘（一个 draw call） */
export function buildStars(n = 700, seed = 11) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(n * 3);
  const seedAttr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = 260 + rnd() * 500;
    const s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(th) * s * r, u * r * 0.7, Math.sin(th) * s * r - 200], i * 3);
    seedAttr[i] = rnd();
  }
  return { pos, seed: seedAttr };
}
