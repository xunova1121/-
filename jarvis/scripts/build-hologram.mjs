/**
 * 离线构建全息胸像：Lee Perry-Smith 头部扫描（CC BY 3.0，Infinite-Realities / triplegangers.com）
 * → public/models/bust-mesh.bin + bust.json
 *
 *   node scripts/build-hologram.mjs
 *
 * 做的事：
 *   1. 读 GLB，换算到 Y 向上、面朝 +Z、高度 100 个单位、原点在颈部；
 *   2. 输出紧凑的网格二进制：[顶点数 u32][索引数 u32] positions f32×3 · normals f32×3 · indices u16
 *      （运行时直接建 BufferGeometry，不需要 GLTFLoader）；
 *   3. 在表面上定位两只眼睛；
 *   4. 把手工设计的“电路线”从正面投影到网格表面（逐点射线求交），输出 3D 折线，
 *      运行时画成发光线条 —— 这是全息胸像上那些面板接缝线的来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = path.join(root, 'assets/LeePerrySmith.glb');
const HEIGHT = 100;
const ORIGIN_AT = 0.62; // 原点放在离底部 62% 高度处（颈部）

/** 正面视角下的电路线（x 向右、y 向上，单位同上；只写右半边，自动镜像） */
const LINES = [
  // 额头中线与两侧折线
  [[0, 24], [0, 36]],
  [[3, 32], [8, 29], [11, 22]],
  // 太阳穴 → 颧骨 → 下颌（走在眼睛外侧）
  [[15, 12], [14, 1], [10, -8], [5, -14]],
  // 下颌线
  [[12, -12], [7, -20], [2, -23]],
  // 颈部两侧
  [[6, -25], [7, -36]],
  // 锁骨
  [[4, -40], [14, -41], [26, -40], [38, -43]],
  // 胸口 V 形
  [[0, -62], [9, -52], [18, -48], [24, -56]],
  // 肩部接缝
  [[33, -41], [40, -49], [44, -60]]
]

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const bin = buf.subarray(20 + jsonLen + 8);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const accessor = (idx) => {
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
    for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = read(off + i * stride + c * size);
    return out;
  };
  const prim = gltf.meshes[0].primitives[0];
  return { pos: accessor(prim.attributes.POSITION), idx: accessor(prim.indices) };
}

const { pos, idx } = readGlb(INPUT);
const V = pos.length / 3;
let minY = Infinity, maxY = -Infinity, cx = 0, cz = 0;
for (let i = 0; i < V; i++) {
  minY = Math.min(minY, pos[i * 3 + 1]);
  maxY = Math.max(maxY, pos[i * 3 + 1]);
  cx += pos[i * 3];
  cz += pos[i * 3 + 2];
}
cx /= V; cz /= V;
const scale = HEIGHT / (maxY - minY);
const originY = minY + (maxY - minY) * ORIGIN_AT;
const P = new Float32Array(V * 3);
for (let i = 0; i < V; i++) {
  P[i * 3] = (pos[i * 3] - cx) * scale;
  P[i * 3 + 1] = (pos[i * 3 + 1] - originY) * scale;
  P[i * 3 + 2] = (pos[i * 3 + 2] - cz) * scale;
}
// —— 焊接：扫描模型在 UV 接缝处有位置相同、法线不同的重复顶点，直接用会在嘴部、下巴出现硬边轮廓光。
//    按位置合并后重新计算面积加权的平滑法线
const remap = new Uint32Array(V);
const keyOf = (i) => `${Math.round(P[i * 3] * 1e3)},${Math.round(P[i * 3 + 1] * 1e3)},${Math.round(P[i * 3 + 2] * 1e3)}`;
const seen = new Map();
const keep = [];
for (let i = 0; i < V; i++) {
  const k = keyOf(i);
  if (!seen.has(k)) { seen.set(k, keep.length); keep.push(i); }
  remap[i] = seen.get(k);
}
const W = keep.length;
const WP = new Float32Array(W * 3);
keep.forEach((src, j) => WP.set(P.subarray(src * 3, src * 3 + 3), j * 3));
const WI = new Uint32Array(idx.length);
for (let i = 0; i < idx.length; i++) WI[i] = remap[idx[i]];
const WN = new Float32Array(W * 3);
for (let t = 0; t < WI.length; t += 3) {
  const a = WI[t] * 3, b = WI[t + 1] * 3, c = WI[t + 2] * 3;
  const ux = WP[b] - WP[a], uy = WP[b + 1] - WP[a + 1], uz = WP[b + 2] - WP[a + 2];
  const vx = WP[c] - WP[a], vy = WP[c + 1] - WP[a + 1], vz = WP[c + 2] - WP[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const v of [a, b, c]) { WN[v] += nx; WN[v + 1] += ny; WN[v + 2] += nz; }
}
for (let v = 0; v < W; v++) {
  const l = Math.hypot(WN[v * 3], WN[v * 3 + 1], WN[v * 3 + 2]) || 1;
  WN[v * 3] /= l; WN[v * 3 + 1] /= l; WN[v * 3 + 2] /= l;
}
if (W > 65535) throw new Error('顶点数超过 Uint16 索引范围');

// —— 射线求交：从 (x, y, +∞) 沿 -Z 打到最前面的表面（Möller–Trumbore 的 Z 向特化：重心坐标 2D 判定）
const T = idx.length / 3;
function surfaceZ(x, y) {
  let best = -Infinity;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const x0 = P[a], y0 = P[a + 1], x1 = P[b], y1 = P[b + 1], x2 = P[c], y2 = P[c + 1];
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(d) < 1e-9) continue;
    const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
    const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
    const z = l0 * P[a + 2] + l1 * P[b + 2] + l2 * P[c + 2];
    if (z > best) best = z;
  }
  return best;
}

// —— 去掉嘴部的内层：扫描在嘴部有一层被嘴唇挡住的内壳（口腔），全息是加色混合，
//    两层叠加会勾出一个“口罩”状的亮框。区域内、朝前、且比最前表面靠后 2 个单位以上的三角形删掉
const MOUTH = { minX: -14, maxX: 14, minY: -16, maxY: -2.5, gap: 2 };
const keptTri = [];
let removed = 0;
for (let t = 0; t < WI.length; t += 3) {
  const a = WI[t] * 3, b = WI[t + 1] * 3, c = WI[t + 2] * 3;
  const cx3 = (WP[a] + WP[b] + WP[c]) / 3, cy3 = (WP[a + 1] + WP[b + 1] + WP[c + 1]) / 3, cz3 = (WP[a + 2] + WP[b + 2] + WP[c + 2]) / 3;
  const d = (WP[b + 1] - WP[c + 1]) * (WP[a] - WP[c]) + (WP[c] - WP[b]) * (WP[a + 1] - WP[c + 1]);
  const inBox = cx3 > MOUTH.minX && cx3 < MOUTH.maxX && cy3 > MOUTH.minY && cy3 < MOUTH.maxY;
  if (inBox && d > 0 && surfaceZ(cx3, cy3) - cz3 > MOUTH.gap) { removed++; continue; }
  keptTri.push(WI[t], WI[t + 1], WI[t + 2]);
}

// —— 电路线投影：每 0.8 单位一个点，离表面外推 0.35 避免 z-fighting
const lines = [];
for (const line of LINES.flatMap((l) => (l[0][0] === 0 && l.every(([x]) => x === 0) ? [l] : [l, l.map(([x, y]) => [-x, y])]))) {
  const out = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.8));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const z = surfaceZ(x, y);
      if (z > -Infinity) out.push([round(x), round(y), round(z + 0.35)]);
    }
  }
  if (out.length > 1) lines.push(out);
}

// —— 眼睛：在估计位置附近找最靠前的表面点，往眼窝里收一点
let minX = Infinity, maxX = -Infinity;
for (let v = 0; v < V; v++) { minX = Math.min(minX, P[v * 3]); maxX = Math.max(maxX, P[v * 3]); }
const eyeY = -HEIGHT * ORIGIN_AT + HEIGHT * 0.695;
const eyes = [1, -1].map((side) => {
  const ex = side * 0.08 * (maxX - minX);
  let bz = -Infinity, bx = ex, by = eyeY;
  for (let v = 0; v < V; v++) {
    const dx = P[v * 3] - ex, dy = P[v * 3 + 1] - eyeY;
    if (dx * dx + dy * dy < 6.25 && P[v * 3 + 2] > bz) { bz = P[v * 3 + 2]; bx = P[v * 3]; by = P[v * 3 + 1]; }
  }
  return [round(bx), round(by), round(bz - 0.6)];
});

// —— 写出
const header = new Uint32Array([W, keptTri.length]);
const normals = WN;
const indices = new Uint16Array(keptTri);
const pad = indices.byteLength % 4 ? 2 : 0;
const out = Buffer.concat([
  Buffer.from(header.buffer), Buffer.from(WP.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer), Buffer.alloc(pad)
]);
fs.mkdirSync(path.join(root, 'public/models'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/models/bust-mesh.bin'), out);
const meta = {
  attribution: 'Lee Perry-Smith head scan, CC BY 3.0 (Infinite-Realities / triplegangers.com)',
  top: round((maxY - originY) * scale),
  bottom: round((minY - originY) * scale),
  pedestalY: -66,
  haloY: 8,
  haloRadius: 42,
  cameraY: -8,
  neckY: -27,
  eyes,
  lines
};
fs.writeFileSync(path.join(root, 'public/models/bust.json'), JSON.stringify(meta) + '\n');
console.log(`胸像网格：${V} → 焊接后 ${W} 顶点 / ${keptTri.length / 3} 三角形（去掉口腔内层 ${removed}），${(out.length / 1024).toFixed(0)} KB；电路线 ${lines.length} 条 ${lines.reduce((s, l) => s + l.length, 0)} 点；眼睛 ${JSON.stringify(eyes)}`);

function round(x) { return Math.round(x * 100) / 100; }
