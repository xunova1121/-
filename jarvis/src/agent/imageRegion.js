/** 区域用0～1坐标；原图只在本次调用内处理，不写入对话和缓存。 */
import { visualRegion } from './imageRegionInput.js';
export { visualRegion } from './imageRegionInput.js';

export async function cropImageRegion(blob, value, { signal } = {}) {
  const region = visualRegion(value);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!region) return blob;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw Object.assign(new Error('当前环境不支持图片裁剪'), { code: 'IMAGE_CROP_UNAVAILABLE', kind: 'capability' });
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const sx = Math.floor(bitmap.width * region.x);
    const sy = Math.floor(bitmap.height * region.y);
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(bitmap.width * region.width)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(bitmap.height * region.height)));
    const scale = Math.min(3, 2048 / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const cropped = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!cropped) throw Object.assign(new Error('图片裁剪失败'), { code: 'IMAGE_CROP', kind: 'api' });
    return cropped;
  } finally {
    bitmap.close();
  }
}

export async function imageData(blob, { detail } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { mime: blob.type || 'image/png', data: btoa(text), ...(detail === 'high' && { detail: 'high' }) };
}

/** 从摆正后的单位矩形映射回照片四角；支持90度旋转及透视，不改动原图字节。 */
export function imagePlane(corners) {
  const bad = () => Object.assign(new Error('表格四角无效或交叉，不能校正图片'), { code: 'TABLE_IMAGE_GEOMETRY', kind: 'input' });
  if (!Array.isArray(corners) || corners.length !== 4 || corners.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0 || n > 1))) throw bad();
  const cross = corners.map((p, i) => { const q = corners[(i + 1) % 4], r = corners[(i + 2) % 4]; return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]); });
  if (!cross.every(v => v > 0.0001) && !cross.every(v => v < -0.0001)) throw bad();
  const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] = corners;
  const dx1 = x1-x2, dx2 = x3-x2, dx3 = x0-x1+x2-x3;
  const dy1 = y1-y2, dy2 = y3-y2, dy3 = y0-y1+y2-y3;
  const determinant = dx1*dy2-dx2*dy1;
  if (Math.abs(determinant) < 1e-8) throw bad();
  const g = (dx3*dy2-dx2*dy3)/determinant, h = (dx1*dy3-dx3*dy1)/determinant;
  const a = x1-x0+g*x1, b = x3-x0+h*x3, d = y1-y0+g*y1, e = y3-y0+h*y3;
  return (u,v) => { const z = g*u+h*v+1; return [(a*u+b*v+x0)/z, (d*u+e*v+y0)/z]; };
}

/** 独立像素证据：核对拟合网格的线段，不把模型自报“识别成功”当作边框一致。 */
export function tableGridEvidence(frame, design) {
  if (!frame || frame.width * frame.height > 1100000 || frame.data?.length !== frame.width * frame.height * 4) return { state: 'not_checked', reason: '没有有界的真实图片像素' };
  const project = imagePlane(design.corners), sum = values => values.reduce((a,b) => a+b,0);
  const cumulative = values => { let total = 0; return [0,...values.map(v => total += v)].map(v => v / total); };
  const xs = cumulative(design.columns), ys = cumulative(design.rows), g = design.grid;
  const w = sum(design.columns), h = sum(design.rows);
  const luminance = (u,v) => {
    const [px,py] = project(u,v), x = Math.round(px*(frame.width-1)), y = Math.round(py*(frame.height-1));
    if (x<0 || y<0 || x>=frame.width || y>=frame.height) return 255;
    const i = (y*frame.width+x)*4;
    return (frame.data[i]*0.2126+frame.data[i+1]*0.7152+frame.data[i+2]*0.0722)*(frame.data[i+3]/255) + 255*(1-frame.data[i+3]/255);
  };
  let total = 0, matched = 0;
  const check = (vertical, boundary, start, end, spacing) => {
    // 小于可辨像素的网格不硬判通过；该类照片须依靠真实原图与Office视觉复核。
    const p = project(vertical ? boundary : start, vertical ? start : boundary), q = project(vertical ? boundary+spacing : start, vertical ? start : boundary+spacing);
    if (Math.hypot((p[0]-q[0])*frame.width,(p[1]-q[1])*frame.height) < 5) return;
    let hits = 0;
    for (const f of [0.2,0.4,0.6,0.8]) {
      const along = start + (end-start)*f;
      const read = offset => luminance(vertical ? boundary+offset : along, vertical ? along : boundary+offset);
      const best = Math.min(...[-0.12,-0.06,0,0.06,0.12].map(offset => read(offset*spacing)));
      const paper = Math.max(read(-spacing*0.32),read(spacing*0.32));
      if (best < 220 && paper-best > 18) hits++;
    }
    total++; if (hits >= 2) matched++;
  };
  const merged = design.cells.filter(c => c.rs > 1 || c.cs > 1);
  for (let c=g.c-1;c<=g.c-1+g.cs;c++) for(let r=g.r-1;r<g.r-1+g.rs;r++) {
    if (merged.some(m => m.c-1<c && c<m.c-1+m.cs && m.r-1<=r && r<m.r-1+m.rs)) continue;
    check(true,xs[c],ys[r],ys[r+1],Math.min(design.columns[Math.max(0,c-1)],design.columns[Math.min(c,design.columns.length-1)])/w);
  }
  for (let r=g.r-1;r<=g.r-1+g.rs;r++) for(let c=g.c-1;c<g.c-1+g.cs;c++) {
    if (merged.some(m => m.r-1<r && r<m.r-1+m.rs && m.c-1<=c && c<m.c-1+m.cs)) continue;
    check(false,ys[r],xs[c],xs[c+1],Math.min(design.rows[Math.max(0,r-1)],design.rows[Math.min(r,design.rows.length-1)])/h);
  }
  const ratio = total ? matched/total : 0;
  return { state: total < 12 ? 'not_checked' : ratio >= 0.8 ? 'matched' : 'needs_review', segments: total, matched, ratio: Math.round(ratio*1000)/1000, method: 'projective_source_pixels' };
}
