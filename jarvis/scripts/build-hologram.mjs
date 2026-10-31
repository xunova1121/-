/**
 * 离线构建全息胸像：Lee Perry-Smith 头部扫描（CC BY 3.0，Infinite-Realities / triplegangers.com）
 * → public/models/bust-mesh.bin + bust.json
 *
 *   node scripts/build-hologram.mjs
 *
 * 流程：
 *   1. 读 GLB，换算到 Y 向上、面朝 +Z、高度 100 个单位、原点在颈部；
 *   2. 焊接 UV 接缝处的重复顶点；
 *   3. 删掉嘴部被嘴唇挡住的口腔内层（加色混合下两层叠加会勾出一个“口罩”状亮框）；
 *   4. Taubin 平滑：把真人扫描的毛孔、鼻孔、唇纹、眼窝等细节抹平成干净的雕塑感曲面 ——
 *      细节过多的真人脸在暗色全息里很容易显得像骷髅、让人不舒服；
 *   5. 重算平滑法线，定位双眼，把“电路线”从正面投影到表面（只放在颈部以下，脸上不画线）；
 *   6. 输出紧凑的网格二进制：[顶点数 u32][索引数 u32] positions f32×3 · normals f32×3 · indices u16
 *      （运行时直接建 BufferGeometry，不需要 GLTFLoader）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = path.join(root, 'assets/LeePerrySmith.glb');
const HEIGHT = 100;
const ORIGIN_AT = 0.62; // 原点放在离底部 62% 高度处（颈部）
const SMOOTH_ITERATIONS = 14;
const FACE_SMOOTH_ITERATIONS = 40;

/** 正面视角下的电路线（x 向右、y 向上；只写右半边，自动镜像）。脸上不画线，避免“缝合线”观感 */
const LINES = [
  // 颈部两侧
  [[6, -27], [7, -36]],
  // 锁骨
  [[4, -40], [14, -41], [26, -40], [38, -43]],
  // 胸口 V 形
  [[0, -62], [9, -52], [18, -48], [24, -56]],
  // 肩部接缝
  [[33, -41], [40, -49], [44, -60]]
];

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

// —— 1. 坐标换算
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
const P0 = new Float32Array(V * 3);
for (let i = 0; i < V; i++) {
  P0[i * 3] = (pos[i * 3] - cx) * scale;
  P0[i * 3 + 1] = (pos[i * 3 + 1] - originY) * scale;
  P0[i * 3 + 2] = (pos[i * 3 + 2] - cz) * scale;
}

// —— 2. 焊接
const seen = new Map();
const keep = [];
const remap = new Uint32Array(V);
for (let i = 0; i < V; i++) {
  const k = `${Math.round(P0[i * 3] * 1e3)},${Math.round(P0[i * 3 + 1] * 1e3)},${Math.round(P0[i * 3 + 2] * 1e3)}`;
  if (!seen.has(k)) { seen.set(k, keep.length); keep.push(i); }
  remap[i] = seen.get(k);
}
const W = keep.length;
if (W > 65535) throw new Error('顶点数超过 Uint16 索引范围');
let P = new Float32Array(W * 3);
keep.forEach((src, j) => P.set(P0.subarray(src * 3, src * 3 + 3), j * 3));
let tris = Array.from(idx, (i) => remap[i]);

/** 从 (x, y, +∞) 沿 -Z 打到最前面的表面，返回 z（没打中返回 -Infinity） */
function surfaceZ(x, y, PP, II) {
  let best = -Infinity;
  for (let t = 0; t < II.length; t += 3) {
    const a = II[t] * 3, b = II[t + 1] * 3, c = II[t + 2] * 3;
    const x0 = PP[a], y0 = PP[a + 1], x1 = PP[b], y1 = PP[b + 1], x2 = PP[c], y2 = PP[c + 1];
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(d) < 1e-9) continue;
    const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
    const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
    const z = l0 * PP[a + 2] + l1 * PP[b + 2] + l2 * PP[c + 2];
    if (z > best) best = z;
  }
  return best;
}

// —— 3. 删掉嘴部内层：区域内、朝前、且比最前表面靠后 2 个单位以上的三角形
const MOUTH = { minX: -14, maxX: 14, minY: -16, maxY: -2.5, gap: 2 };
const kept = [];
let removed = 0;
for (let t = 0; t < tris.length; t += 3) {
  const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
  const mx = (P[a] + P[b] + P[c]) / 3, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
  const d = (P[b + 1] - P[c + 1]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 1] - P[c + 1]);
  const inBox = mx > MOUTH.minX && mx < MOUTH.maxX && my > MOUTH.minY && my < MOUTH.maxY;
  if (inBox && d > 0 && surfaceZ(mx, my, P, tris) - mz > MOUTH.gap) { removed++; continue; }
  kept.push(tris[t], tris[t + 1], tris[t + 2]);
}
tris = kept;

const WT = W;

// —— 4. Taubin 平滑（λ / μ 交替，近似保体积，不会越抹越瘦）
const nbr = Array.from({ length: WT }, () => new Set());
for (let t = 0; t < tris.length; t += 3) {
  const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
  nbr[a].add(b).add(c); nbr[b].add(a).add(c); nbr[c].add(a).add(b);
}
const tmp = new Float32Array(WT * 3);
/** mask(v) ∈ [0,1]：每个顶点参与平滑的程度 */
function laplacian(f, mask = () => 1) {
  for (let v = 0; v < WT; v++) {
    const n = nbr[v];
    if (!n.size) { tmp.set(P.subarray(v * 3, v * 3 + 3), v * 3); continue; }
    let sx = 0, sy = 0, sz = 0;
    for (const u of n) { sx += P[u * 3]; sy += P[u * 3 + 1]; sz += P[u * 3 + 2]; }
    const g = f * mask(v);
    tmp[v * 3] = P[v * 3] + g * (sx / n.size - P[v * 3]);
    tmp[v * 3 + 1] = P[v * 3 + 1] + g * (sy / n.size - P[v * 3 + 1]);
    tmp[v * 3 + 2] = P[v * 3 + 2] + g * (sz / n.size - P[v * 3 + 2]);
  }
  P.set(tmp);
}
for (let i = 0; i < SMOOTH_ITERATIONS; i++) { laplacian(0.5); laplacian(-0.53); }
// 脸部正面再额外平滑：眼窝、嘴唇压浅，得到平静的“人台”式面孔（五官仍可辨认）
const faceMask = (v) => {
  const x = P[v * 3] / 15, y = (P[v * 3 + 1] - 0) / 17, z = P[v * 3 + 2];
  if (z < 4) return 0;
  const r = x * x + y * y;
  return r >= 1 ? 0 : (1 - r) * (1 - r);
};
for (let i = 0; i < FACE_SMOOTH_ITERATIONS; i++) { laplacian(0.5, faceMask); laplacian(-0.53, faceMask); }

// —— 5. 法线
const N = new Float32Array(WT * 3);
for (let t = 0; t < tris.length; t += 3) {
  const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
}
for (let v = 0; v < WT; v++) {
  const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
  N[v * 3] /= l; N[v * 3 + 1] /= l; N[v * 3 + 2] /= l;
}

// —— 电路线投影：每 0.8 单位一个点，离表面外推 0.35 避免 z-fighting
const lines = [];
for (const line of LINES.flatMap((l) => (l.every(([x]) => x === 0) ? [l] : [l, l.map(([x, y]) => [-x, y])]))) {
  const out = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.8));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const z = surfaceZ(x, y, P, tris);
      if (z > -Infinity) out.push([round(x), round(y), round(z + 0.35)]);
    }
  }
  if (out.length > 1) lines.push(out);
}

// —— 眼睛：在估计位置附近找最靠前的表面点，往里收一点
let minX = Infinity, maxX = -Infinity;
for (let v = 0; v < WT; v++) { minX = Math.min(minX, P[v * 3]); maxX = Math.max(maxX, P[v * 3]); }
const eyeY = -HEIGHT * ORIGIN_AT + HEIGHT * 0.695;
const eyes = [1, -1].map((side) => {
  const ex = side * 0.08 * (maxX - minX);
  let bz = -Infinity, bx = ex, by = eyeY;
  for (let v = 0; v < WT; v++) {
    const dx = P[v * 3] - ex, dy = P[v * 3 + 1] - eyeY;
    if (dx * dx + dy * dy < 6.25 && P[v * 3 + 2] > bz) { bz = P[v * 3 + 2]; bx = P[v * 3]; by = P[v * 3 + 1]; }
  }
  return [round(bx), round(by), round(bz + 0.2)];
});

// —— 6. 写出
const indices = new Uint16Array(tris);
const pad = indices.byteLength % 4 ? 2 : 0;
const out = Buffer.concat([
  Buffer.from(new Uint32Array([WT, tris.length]).buffer), Buffer.from(P.buffer), Buffer.from(N.buffer),
  Buffer.from(indices.buffer), Buffer.alloc(pad)
]);
fs.mkdirSync(path.join(root, 'public/models'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/models/bust-mesh.bin'), out);
let top = -Infinity, bottom = Infinity;
for (let v = 0; v < WT; v++) { top = Math.max(top, P[v * 3 + 1]); bottom = Math.min(bottom, P[v * 3 + 1]); }
const meta = {
  attribution: 'Lee Perry-Smith head scan, CC BY 3.0 (Infinite-Realities / triplegangers.com)',
  top: round(top),
  bottom: round(bottom),
  pedestalY: -66,
  haloY: 8,
  haloRadius: 42,
  cameraY: -8,
  neckY: -27,
  eyes,
  lines
};
fs.writeFileSync(path.join(root, 'public/models/bust.json'), JSON.stringify(meta) + '\n');
console.log(`胸像网格：${V} → 焊接后 ${W} 顶点 / ${tris.length / 3} 三角形（去掉口腔内层 ${removed}，平滑 ${SMOOTH_ITERATIONS}+${FACE_SMOOTH_ITERATIONS} 轮），${(out.length / 1024).toFixed(0)} KB；电路线 ${lines.length} 条；眼睛 ${JSON.stringify(eyes)}`);

function round(x) { return Math.round(x * 100) / 100; }
