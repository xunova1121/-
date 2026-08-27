/** 从预演台空间数据导出模型可消费的 SVG 控制图。 */
const W = 1280, H = 720;
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function projected(stage) {
  const cam = stage.cam || { x: 0, y: -3, height: 1.6, lens: 35 };
  const target = stage.subjects?.[0] || { x: 0, y: 0 };
  const look = Math.atan2(Number(target.y) - Number(cam.y), Number(target.x) - Number(cam.x));
  const focal = Math.max(24, Number(cam.lens || 35));
  return [
    ...(stage.subjects || []).map((item, i) => ({ kind: 'subject', item, index: i + 1 })),
    ...(stage.marks || []).filter((x) => !x.far).map((item, i) => ({ kind: 'prop', item, index: i + 1 }))
  ].map((entry) => {
    const dx = Number(entry.item.x) - Number(cam.x), dy = Number(entry.item.y) - Number(cam.y);
    const depth = dx * Math.cos(look) + dy * Math.sin(look);
    const side = -dx * Math.sin(look) + dy * Math.cos(look);
    const scale = Math.min(3, focal / 35 * 3.4 / Math.max(.2, depth)) * Number(entry.item.scale || 1);
    const h = Math.max(35, Number(entry.item.height || 1) * H * .24 * scale);
    return { ...entry, depth, x: W / 2 + side * W * .16 * scale, y: H * .54 - h * .12, h };
  }).filter((x) => x.depth > .15).sort((a, b) => b.depth - a.depth);
}

function svg(body, title, background = '#11131a') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>${esc(title)}</title><rect width="100%" height="100%" fill="${background}"/>${body}</svg>`;
}

export function renderControls(stage = {}) {
  const objects = projected(stage);
  const shape = (x, fill, label = true) => {
    const w = x.kind === 'subject' ? x.h * .32 : x.h * .62;
    const h = x.kind === 'subject' ? x.h : x.h * .75;
    return `<rect x="${(x.x - w / 2).toFixed(1)}" y="${(x.y - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${x.kind === 'subject' ? (w * .35).toFixed(1) : 3}" fill="${fill}"/>${label ? `<text x="${x.x.toFixed(1)}" y="${(x.y - h - 12).toFixed(1)}" fill="white" font-size="18" text-anchor="middle">${esc(x.item.name || x.kind)}</text>` : ''}`;
  };
  const start = svg(`<path d="M0 ${H * .54}H${W}" stroke="#3b4050"/>${objects.map((x) => shape(x, x.kind === 'subject' ? '#d8a24d' : '#687083')).join('')}<path d="M620 360h40M640 340v40" stroke="white" opacity=".65"/>`, '首帧构图控制');
  const far = Math.max(1, ...objects.map((x) => x.depth));
  const depth = svg(objects.map((x) => {
    const value = Math.max(20, Math.min(245, Math.round(255 * (1 - x.depth / (far + 1)))));
    return shape(x, `rgb(${value},${value},${value})`, false);
  }).join(''), '深度控制图', '#000');
  const palette = ['#ff355e', '#00d4ff', '#ffe066', '#8aff80', '#b388ff', '#ff9f43'];
  const mask = svg(objects.map((x, i) => shape(x, palette[i % palette.length], false)).join(''), '对象遮罩控制图', '#000');
  return { start, depth, mask, width: W, height: H, objects: objects.map((x) => ({ id: x.item.id, name: x.item.name, kind: x.kind, depth: Number(x.depth.toFixed(3)) })) };
}
