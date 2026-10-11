/**
 * 离线采样：Cesium Man (CC BY 4.0, donated by Cesium) → 4600 点人形点云。
 *
 *   node scripts/sample-cesium-man.mjs [输入.glb] [输出.bin]
 *
 * 采样策略（需求 3.1）：
 *   1. 按三角形面积加权在表面上取候选点；
 *   2. 每个顶点估算“曲率”（相邻面法线的离散度）和“正面剪影度”（法线与视线越垂直越高），
 *      两者合成权重，权重越高 Poisson 盘半径越小 —— 轮廓与边缘区域得到更密的采样；
 *   3. 变半径泊松盘飞镖投掷（网格加速），二分搜索基准半径使结果恰好落在 4600 点；
 *   4. 坐标换算到 Y 轴向上、面朝 +Z、身高 100 个单位，以 Float32Array 输出。
 *
 * 输出格式：每点 4 个 float32 —— x, y, z, contour(0..1，轮廓强度，着色器用来提亮剪影)。
 * 选择离线预采样而非运行时解析 GLB：首屏不必下载 430KB 的模型与 GLTFLoader，只需 74KB。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const IN = process.argv[2] || path.join(here, '../assets/CesiumMan.glb');
const OUT = process.argv[3] || path.join(here, '../public/models/cesium-man-points.bin');
const TARGET = 4600;
const HEIGHT = 100;

// ---------- 读取 GLB ----------
const buf = fs.readFileSync(IN);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = buf.subarray(binStart);

const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
function accessor(idx) {
  const a = gltf.accessors[idx];
  const bv = gltf.bufferViews[a.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const [Ctor, read] = {
    5126: [Float32Array, (p) => dv.getFloat32(p, true)],
    5125: [Uint32Array, (p) => dv.getUint32(p, true)],
    5123: [Uint16Array, (p) => dv.getUint16(p, true)]
  }[a.componentType];
  const size = Ctor.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || comps * size;
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Ctor(a.count * comps);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < comps; c++) out[i * comps + c] = read(off + i * stride + c * size);
  }
  return out;
}

const prim = gltf.meshes[0].primitives[0];
const pos = accessor(prim.attributes.POSITION);
const idx = accessor(prim.indices);

// 模型原始坐标：Z 向上、+X 朝前、Y 为左右（双臂沿 ±Y 展开）。
// 换算为 Y 向上、+Z 朝前：(x, y, z) → (y, z, x)，循环置换，保持右手系。
const V = pos.length / 3;
const P = new Float32Array(V * 3);
let minY = Infinity, maxY = -Infinity;
for (let i = 0; i < V; i++) {
  P[i * 3] = pos[i * 3 + 1];
  P[i * 3 + 1] = pos[i * 3 + 2];
  P[i * 3 + 2] = pos[i * 3];
  minY = Math.min(minY, P[i * 3 + 1]);
  maxY = Math.max(maxY, P[i * 3 + 1]);
}
const scale = HEIGHT / (maxY - minY);
let cx = 0, cz = 0;
for (let i = 0; i < V; i++) { cx += P[i * 3]; cz += P[i * 3 + 2]; }
cx /= V; cz /= V;
// 以胸口（约 72% 身高处）为原点，粒子核心的中心正好落在胸口发光核位置
const chestY = minY + (maxY - minY) * 0.72;
for (let i = 0; i < V; i++) {
  P[i * 3] = (P[i * 3] - cx) * scale;
  P[i * 3 + 1] = (P[i * 3 + 1] - chestY) * scale;
  P[i * 3 + 2] = (P[i * 3 + 2] - cz) * scale;
}

// ---------- 面积、面法线、顶点曲率与剪影度 ----------
const T = idx.length / 3;
const area = new Float64Array(T);
const fn = new Float32Array(T * 3);
const vn = new Float32Array(V * 3);
const vAdj = Array.from({ length: V }, () => []);
for (let t = 0; t < T; t++) {
  const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz) || 1;
  area[t] = l / 2;
  fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
  for (const v of [a, b, c]) {
    vn[v * 3] += nx; vn[v * 3 + 1] += ny; vn[v * 3 + 2] += nz;
    vAdj[v].push(t);
  }
}
const curv = new Float32Array(V);
const sil = new Float32Array(V);
for (let v = 0; v < V; v++) {
  const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]) || 1;
  const nx = vn[v * 3] / l, ny = vn[v * 3 + 1] / l, nz = vn[v * 3 + 2] / l;
  let dev = 0;
  for (const t of vAdj[v]) dev += 1 - (fn[t * 3] * nx + fn[t * 3 + 1] * ny + fn[t * 3 + 2] * nz);
  curv[v] = vAdj[v].length ? dev / vAdj[v].length : 0;
  // 正面视线为 Z 轴：|n·z| 越小越靠近剪影
  sil[v] = 1 - Math.abs(nz);
}
const cMax = [...curv].sort((a, b) => a - b)[Math.floor(V * 0.95)] || 1;
const weightV = new Float32Array(V);
for (let v = 0; v < V; v++) {
  const c = Math.min(1, curv[v] / cMax);
  weightV[v] = 1 + 1.6 * c + 1.4 * Math.pow(sil[v], 3);
}

// ---------- 候选点（面积加权） ----------
let seed = 20260411;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const cdf = new Float64Array(T);
let acc = 0;
for (let t = 0; t < T; t++) { acc += area[t]; cdf[t] = acc; }

const NC = TARGET * 14;
const cand = new Float32Array(NC * 4);
for (let i = 0; i < NC; i++) {
  const r = rnd() * acc;
  let lo = 0, hi = T - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
  const t = lo;
  let u = rnd(), w = rnd();
  if (u + w > 1) { u = 1 - u; w = 1 - w; }
  const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
  const s = 1 - u - w;
  for (let k = 0; k < 3; k++) cand[i * 4 + k] = P[a * 3 + k] * s + P[b * 3 + k] * u + P[c * 3 + k] * w;
  cand[i * 4 + 3] = weightV[a] * s + weightV[b] * u + weightV[c] * w;
}
// 打乱一次后固定顺序，保证飞镖投掷与半径无关
const order = Array.from({ length: NC }, (_, i) => i);
for (let i = NC - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }

function dart(r0) {
  const cell = r0;
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const picked = [];
  for (const i of order) {
    const x = cand[i * 4], y = cand[i * 4 + 1], z = cand[i * 4 + 2], wgt = cand[i * 4 + 3];
    const r = r0 / Math.sqrt(wgt);
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let ok = true;
    for (let dx = -1; dx <= 1 && ok; dx++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dz = -1; dz <= 1 && ok; dz++) {
      const list = grid.get(key(gx + dx, gy + dy, gz + dz));
      if (!list) continue;
      for (const j of list) {
        const rr = Math.min(r, r0 / Math.sqrt(cand[j * 4 + 3]));
        const ddx = cand[j * 4] - x, ddy = cand[j * 4 + 1] - y, ddz = cand[j * 4 + 2] - z;
        if (ddx * ddx + ddy * ddy + ddz * ddz < rr * rr) { ok = false; break; }
      }
    }
    if (!ok) continue;
    picked.push(i);
    const k = key(gx, gy, gz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  return picked;
}

let lo = 0.2, hi = 6, best = null;
for (let it = 0; it < 30; it++) {
  const mid = (lo + hi) / 2;
  const got = dart(mid);
  if (got.length >= TARGET) { best = got; lo = mid; } else hi = mid;
  if (best && best.length - TARGET < TARGET * 0.01) break;
}
best = best.slice(0, TARGET);

const out = new Float32Array(TARGET * 4);
best.forEach((i, n) => {
  out[n * 4] = cand[i * 4];
  out[n * 4 + 1] = cand[i * 4 + 1];
  out[n * 4 + 2] = cand[i * 4 + 2];
  out[n * 4 + 3] = Math.min(1, (cand[i * 4 + 3] - 1) / 3);
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(out.buffer));
console.log(`采样完成：${TARGET} 点，基准泊松半径 ${lo.toFixed(3)}，写入 ${path.relative(process.cwd(), OUT)} (${out.byteLength} bytes)`);
