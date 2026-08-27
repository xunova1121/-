/** 从预演台空间与关键帧导出可控视频模型能消费的控制包。 */
import { frameState, normalizeStage, stageObjects } from '../../ui/previz-stage.js';

const W = 1280, H = 720, FPS = 24;
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function stageAt(source, frame) {
  const stage = structuredClone(source || {});
  normalizeStage(stage);
  const state = frameState(stage, frame);
  for (const { item } of stageObjects(stage)) Object.assign(item, state.values[item.id] || {});
  return stage;
}

function projected(stage) {
  const cam = stage.cam || { x: 0, y: -3, height: 1.6, lens: 35 };
  const target = stage.subjects?.[0] || { x: 0, y: 0 };
  const look = Math.atan2(Number(target.y) - Number(cam.y), Number(target.x) - Number(cam.x));
  const focal = Math.max(24, Number(cam.lens || 35));
  return [...(stage.subjects || []).map((item, i) => ({ kind: 'subject', item, index: i + 1 })),
    ...(stage.marks || []).filter((x) => !x.far).map((item, i) => ({ kind: 'prop', item, index: i + 1 }))]
    .map((entry) => {
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

function geometry(x) {
  const w = x.kind === 'subject' ? x.h * .32 : x.h * .62;
  const h = x.kind === 'subject' ? x.h : x.h * .75;
  return { w, h, left: x.x - w / 2, top: x.y - h };
}

function shape(x, fill, { label = false, image = false, outline = false } = {}) {
  const g = geometry(x), rx = x.kind === 'subject' ? g.w * .35 : 3;
  const href = x.item.thumbnail || x.item.image || '';
  const base = image && href
    ? `<defs><clipPath id="clip-${esc(x.item.id)}"><rect x="${g.left.toFixed(1)}" y="${g.top.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="${rx.toFixed(1)}"/></clipPath></defs><image href="${esc(href)}" x="${g.left.toFixed(1)}" y="${g.top.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip-${esc(x.item.id)})"/>`
    : `<rect x="${g.left.toFixed(1)}" y="${g.top.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="${rx.toFixed(1)}" fill="${fill}"${outline ? ' stroke="white" stroke-width="5" fill="none"' : ''}/>`;
  return `${base}${label ? `<text x="${x.x.toFixed(1)}" y="${(g.top - 12).toFixed(1)}" fill="white" font-size="18" text-anchor="middle">${esc(x.item.name || x.kind)}</text>` : ''}`;
}

function poseShape(x) {
  if (x.kind !== 'subject') return '';
  const g = geometry(x), cx = x.x, head = g.top + g.h * .13, neck = g.top + g.h * .25, hip = g.top + g.h * .6, foot = g.top + g.h;
  return `<g stroke="#fff" stroke-width="8" stroke-linecap="round" fill="none"><circle cx="${cx}" cy="${head}" r="${g.w * .18}"/><path d="M${cx} ${neck}V${hip}M${cx} ${neck + g.h * .1}L${cx - g.w * .65} ${neck + g.h * .32}M${cx} ${neck + g.h * .1}L${cx + g.w * .65} ${neck + g.h * .32}M${cx} ${hip}L${cx - g.w * .45} ${foot}M${cx} ${hip}L${cx + g.w * .45} ${foot}"/></g>`;
}

function renderFrame(stage, title) {
  const objects = projected(stage);
  const backdrop = stage.backdrop?.image ? `<image href="${esc(stage.backdrop.image)}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" opacity=".72"/>` : '';
  return { image: svg(`${backdrop}<path d="M0 ${H * .54}H${W}" stroke="#3b4050"/>${objects.map((x) => shape(x, x.kind === 'subject' ? '#d8a24d' : '#687083', { label: true, image: true })).join('')}<path d="M620 360h40M640 340v40" stroke="white" opacity=".65"/>`, title), objects };
}

function renderFrameControls(stage, title) {
  const composite = renderFrame(stage, title);
  const objects = composite.objects;
  const far = Math.max(1, ...objects.map((x) => x.depth));
  const depth = svg(objects.map((x) => {
    const value = Math.max(20, Math.min(245, Math.round(255 * (1 - x.depth / (far + 1)))));
    return shape(x, `rgb(${value},${value},${value})`);
  }).join(''), `${title}·深度`, '#000');
  const palette = ['#ff355e', '#00d4ff', '#ffe066', '#8aff80', '#b388ff', '#ff9f43'];
  return {
    rgb: composite.image,
    depth,
    mask: svg(objects.map((x, i) => shape(x, palette[i % palette.length])).join(''), `${title}·对象遮罩`, '#000'),
    edge: svg(objects.map((x) => shape(x, 'none', { outline: true })).join(''), `${title}·边缘`, '#000'),
    pose: svg(objects.map(poseShape).join(''), `${title}·人物姿态`, '#000'),
    objects
  };
}

export function renderControls(source = {}, { duration = 5, sampleEvery = 3 } = {}) {
  const base = structuredClone(source || {});
  normalizeStage(base);
  const maxFrame = Math.max(1, Math.round(Number(duration || 5) * FPS));
  const frameSet = new Set([0, ...(base.keyframes || []).map((x) => x.frame), maxFrame]);
  for (let frame = 0; frame <= maxFrame; frame += Math.max(1, sampleEvery)) frameSet.add(frame);
  const sampled = [...frameSet].filter((x) => x >= 0 && x <= maxFrame).sort((a, b) => a - b).map((frame) => ({ frame, stage: stageAt(base, frame) }));
  const frames = sampled.map(({ frame, stage }) => {
    const maps = renderFrameControls(stage, `控制帧 ${String(frame).padStart(4, '0')}`);
    return { frame, time: Number((frame / FPS).toFixed(3)), ...maps };
  });
  const first = frames[0];
  const last = frames.at(-1);
  const objects = first.objects;
  const trajectory = sampled.map(({ frame, stage }) => ({ frame, time: Number((frame / FPS).toFixed(3)), x: stage.cam.x, y: stage.cam.y, height: stage.cam.height, rotation: stage.cam.rotation || 0, lens: stage.cam.lens || 35 }));
  const poseSequence = sampled.map(({ frame, stage }) => ({ frame, subjects: (stage.subjects || []).map((x) => ({ id: x.id, x: x.x, y: x.y, height: x.height, rotation: x.rotation, scale: x.scale })) }));
  const layers = [...(base.backdrop ? [{ id: 'background', kind: 'background', source: base.backdrop.image || null }] : []),
    ...stageObjects(base).filter((x) => x.kind !== 'camera').map((x, i) => ({ id: x.item.id, kind: x.kind, name: x.item.name, source: x.item.thumbnail || null, z: i + 1 }))];
  return { start: first.rgb, end: last.rgb, depth: first.depth, mask: first.mask, edge: first.edge, pose: first.pose,
    frames, sampleEvery: Math.max(1, sampleEvery), controlFps: Number((FPS / Math.max(1, sampleEvery)).toFixed(3)), width: W, height: H, fps: FPS, maxFrame,
    keyframes: (base.keyframes || []).map((x) => x.frame), trajectory, poseSequence, layers,
    objects: objects.map((x) => ({ id: x.item.id, name: x.item.name, kind: x.kind, depth: Number(x.depth.toFixed(3)) })) };
}

/**
 * 把预演台的数值轨迹翻译成所有视频模型都能理解的导演指令。
 *
 * 深度图、姿态图只有部分工作流会直接接收，但提示词是所有适配器的共同入口。
 * 因此控制包至少会真实进入生成请求，而不是只躺在磁盘里等人下载。
 */
export function videoControlPrompt(bundle = {}) {
  const trajectory = bundle.trajectory || bundle.cameraTrajectory || [];
  const poses = bundle.poseSequence || [];
  if (!trajectory.length && !poses.length) return '';

  const firstCam = trajectory[0] || {};
  const lastCam = trajectory.at(-1) || firstCam;
  const camera = `摄影机从坐标(${Number(firstCam.x || 0).toFixed(2)},${Number(firstCam.y || 0).toFixed(2)},${Number(firstCam.height || 0).toFixed(2)})、${Number(firstCam.lens || 35).toFixed(0)}mm，`
    + `运动到(${Number(lastCam.x || 0).toFixed(2)},${Number(lastCam.y || 0).toFixed(2)},${Number(lastCam.height || 0).toFixed(2)})、${Number(lastCam.lens || 35).toFixed(0)}mm`;

  const firstPose = new Map((poses[0]?.subjects || []).map((x) => [x.id, x]));
  const lastPose = new Map((poses.at(-1)?.subjects || []).map((x) => [x.id, x]));
  const actors = [...firstPose.entries()].map(([id, start]) => {
    const end = lastPose.get(id) || start;
    return `${id} 从(${Number(start.x || 0).toFixed(2)},${Number(start.y || 0).toFixed(2)})移动到(${Number(end.x || 0).toFixed(2)},${Number(end.y || 0).toFixed(2)})，朝向${Number(end.rotation || 0).toFixed(0)}°`;
  });

  return `【3D预演控制】严格保持首尾构图与空间关系；${camera}`
    + `${actors.length ? `；人物轨迹：${actors.join('；')}` : ''}`
    + `；按 ${Number(bundle.fps || 24)}fps、${Number(bundle.maxFrame || 0)} 帧平滑插值，不要让人物、道具或机位瞬移。`;
}

