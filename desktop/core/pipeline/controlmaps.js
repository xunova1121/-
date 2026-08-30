/** 从预演台空间与关键帧导出可控视频模型能消费的控制包。 */
import { attachmentPose, frameState, normalizeStage, spatialIssues, stageObjects } from '../../ui/previz-stage.js';

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
      const attached = entry.kind === 'prop' ? attachmentPose(stage, entry.item) : null;
      const world = attached ? { ...entry.item, ...attached } : entry.item;
      const dx = Number(world.x) - Number(cam.x), dy = Number(world.y) - Number(cam.y);
      const depth = dx * Math.cos(look) + dy * Math.sin(look);
      const side = -dx * Math.sin(look) + dy * Math.cos(look);
      const scale = Math.min(3, focal / 35 * 3.4 / Math.max(.2, depth)) * Number(entry.item.scale || 1);
      const h = Math.max(35, Number(entry.item.height || 1) * H * .24 * scale);
      return { ...entry, item: world, depth, x: W / 2 + side * W * .16 * scale, y: H * .54 - h * .12, h };
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
  const pose = x.item.pose || 'stand';
  const crouch = pose === 'crouch' || pose === 'sit' ? g.h * .16 : 0;
  const reach = pose === 'reach' || pose === 'fight';
  const stride = ['walk', 'run', 'fight'].includes(pose) ? g.w * .72 : g.w * .45;
  const armY = reach ? neck - g.h * .02 : neck + g.h * .32;
  return `<g data-pose="${esc(pose)}" stroke="#fff" stroke-width="8" stroke-linecap="round" fill="none"><circle cx="${cx}" cy="${head + crouch}" r="${g.w * .18}"/><path d="M${cx} ${neck + crouch}V${hip + crouch}M${cx} ${neck + g.h * .1 + crouch}L${cx - g.w * .65} ${armY + crouch}M${cx} ${neck + g.h * .1 + crouch}L${cx + g.w * .65} ${armY + crouch}M${cx} ${hip + crouch}L${cx - stride} ${foot}M${cx} ${hip + crouch}L${cx + stride} ${foot}"/></g>`;
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
  const trajectory = sampled.map(({ frame, stage }) => ({
    frame, time: Number((frame / FPS).toFixed(3)), x: stage.cam.x, y: stage.cam.y,
    height: stage.cam.height, rotation: stage.cam.rotation || 0, lens: stage.cam.lens || 35,
    aperture: stage.cam.aperture || 4, focusId: stage.cam.focusId || '',
    focusDistance: stage.cam.focusDistance || 3, shutterAngle: stage.cam.shutterAngle || 180,
    iso: stage.cam.iso || 400
  }));
  const poseSequence = sampled.map(({ frame, stage }) => ({ frame, subjects: (stage.subjects || []).map((x) => ({ id: x.id, x: x.x, y: x.y, height: x.height, rotation: x.rotation, scale: x.scale, pose: x.pose || 'stand', action: x.action || '', animationName: x.animationName || '', textureView: x.textureView || 'auto' })) }));
  const lightSequence = sampled.map(({ frame, stage }) => ({ frame, time: Number((frame / FPS).toFixed(3)), lights: (stage.lights || []).map((x) => ({ id: x.id, type: x.lightType, x: x.x, y: x.y, height: x.height, intensity: x.intensity, color: x.color, targetId: x.targetId || '' })) }));
  const attachmentSequence = sampled.map(({ frame, stage }) => ({
    frame, time: Number((frame / FPS).toFixed(3)), props: (stage.marks || []).filter((x) => !x.far && x.attachToId).map((item) => {
      const world = attachmentPose(stage, item);
      return { id: item.id, name: item.name, actorId: item.attachToId, point: item.attachPoint,
        x: Number(world?.x || item.x || 0), y: Number(world?.y || item.y || 0), elevation: Number(world?.elevation || item.elevation || 0) };
    })
  }));
  const motionPaths = (base.subjects || []).map((subject) => {
    const points = sampled.map(({ frame, stage }) => {
      const current = (stage.subjects || []).find((x) => x.id === subject.id) || subject;
      return { frame, time: Number((frame / FPS).toFixed(3)), x: Number(current.x || 0), y: Number(current.y || 0),
        rotation: Number(current.rotation || 0), pose: current.pose || 'stand', action: current.action || '', animationName: current.animationName || '', textureView: current.textureView || 'auto' };
    });
    let distance = 0;
    let peakSpeed = 0;
    for (let i = 1; i < points.length; i += 1) {
      const segment = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      const elapsed = Math.max(1 / FPS, points[i].time - points[i - 1].time);
      distance += segment;
      peakSpeed = Math.max(peakSpeed, segment / elapsed);
    }
    const totalTime = Math.max(1 / FPS, Number(duration || 5));
    return { id: subject.id, name: subject.name || subject.id, distance: Number(distance.toFixed(3)),
      averageSpeed: Number((distance / totalTime).toFixed(3)), peakSpeed: Number(peakSpeed.toFixed(3)), points };
  });
  const layers = [...(base.backdrop ? [{ id: 'background', kind: 'background', source: base.backdrop.image || null }] : []),
    ...stageObjects(base).filter((x) => x.kind !== 'camera' && x.kind !== 'light').map((x, i) => ({ id: x.item.id, kind: x.kind, name: x.item.name, source: x.item.thumbnail || null, z: i + 1,
      ...(x.item.attachToId ? { attachToId: x.item.attachToId, attachPoint: x.item.attachPoint } : {}) }))];
  const knownIds = new Set(stageObjects(base).map((x) => x.item.id));
  const issues = [];
  for (const point of trajectory) {
    if (point.focusId && !knownIds.has(point.focusId)) {
      issues.push({ code: 'missing-focus-target', frame: point.frame, level: 'blocker', message: `第 ${point.frame} 帧的对焦目标已不存在` });
    }
    if (Number(point.aperture) < 2 && !point.focusId) {
      issues.push({ code: 'shallow-focus-auto', frame: point.frame, level: 'warn', message: `第 ${point.frame} 帧使用超浅景深但没有指定对焦人物` });
    }
  }
  for (const path of motionPaths) {
    if (path.peakSpeed > 15) issues.push({ code: 'subject-teleport', subjectId: path.id, level: 'blocker', message: `${path.name} 峰值速度 ${path.peakSpeed.toFixed(1)}m/s，疑似关键帧瞬移` });
    else if (path.peakSpeed > 8) issues.push({ code: 'subject-speed', subjectId: path.id, level: 'warn', message: `${path.name} 峰值速度 ${path.peakSpeed.toFixed(1)}m/s，请确认奔跑节奏` });
  }
  for (const item of (base.marks || []).filter((x) => !x.far && x.attachToId)) {
    if (!knownIds.has(item.attachToId)) issues.push({ code: 'missing-attachment-target', propId: item.id, level: 'blocker', message: `${item.name || item.id}绑定的人物已不存在` });
  }
  const seenSpatial = new Set();
  for (const { frame, stage } of sampled) for (const issue of spatialIssues(stage)) {
    const signature = `${issue.code}:${(issue.objectIds || [issue.objectId]).filter(Boolean).join(',')}`;
    if (seenSpatial.has(signature)) continue;
    seenSpatial.add(signature);
    issues.push({ ...issue, frame });
  }
  return { start: first.rgb, end: last.rgb, depth: first.depth, mask: first.mask, edge: first.edge, pose: first.pose,
    frames, sampleEvery: Math.max(1, sampleEvery), controlFps: Number((FPS / Math.max(1, sampleEvery)).toFixed(3)), width: W, height: H, fps: FPS, maxFrame,
    keyframes: (base.keyframes || []).map((x) => x.frame), motionEasing: base.motionEasing || 'easeInOut',
    trajectory, poseSequence, motionPaths, lightSequence, attachmentSequence, layers, issues,
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
  const paths = bundle.motionPaths || [];
  const lights = bundle.lightSequence || [];
  const attachments = bundle.attachmentSequence || [];
  if (!trajectory.length && !poses.length && !paths.length && !lights.length && !attachments.length) return '';

  const firstCam = trajectory[0] || {};
  const lastCam = trajectory.at(-1) || firstCam;
  const camera = `摄影机从坐标(${Number(firstCam.x || 0).toFixed(2)},${Number(firstCam.y || 0).toFixed(2)},${Number(firstCam.height || 0).toFixed(2)})、${Number(firstCam.lens || 35).toFixed(0)}mm，`
    + `运动到(${Number(lastCam.x || 0).toFixed(2)},${Number(lastCam.y || 0).toFixed(2)},${Number(lastCam.height || 0).toFixed(2)})、${Number(lastCam.lens || 35).toFixed(0)}mm；`
    + `焦点${firstCam.focusId || `${Number(firstCam.focusDistance || 3).toFixed(1)}m`}→${lastCam.focusId || `${Number(lastCam.focusDistance || 3).toFixed(1)}m`}，`
    + `光圈f/${Number(firstCam.aperture || 4).toFixed(1)}→f/${Number(lastCam.aperture || 4).toFixed(1)}，`
    + `快门角${Number(firstCam.shutterAngle || 180).toFixed(0)}°→${Number(lastCam.shutterAngle || 180).toFixed(0)}°，ISO ${Number(firstCam.iso || 400).toFixed(0)}→${Number(lastCam.iso || 400).toFixed(0)}`;

  const firstPose = new Map((poses[0]?.subjects || []).map((x) => [x.id, x]));
  const lastPose = new Map((poses.at(-1)?.subjects || []).map((x) => [x.id, x]));
  const pathById = new Map(paths.map((x) => [x.id, x]));
  const actors = [...firstPose.entries()].map(([id, start]) => {
    const end = lastPose.get(id) || start;
    const path = pathById.get(id);
    const pace = path ? `，路径${Number(path.distance || 0).toFixed(2)}米，平均${Number(path.averageSpeed || 0).toFixed(2)}m/s、峰值${Number(path.peakSpeed || 0).toFixed(2)}m/s` : '';
    return `${id} 从(${Number(start.x || 0).toFixed(2)},${Number(start.y || 0).toFixed(2)})移动到(${Number(end.x || 0).toFixed(2)},${Number(end.y || 0).toFixed(2)})${pace}，朝向${Number(end.rotation || 0).toFixed(0)}°，姿态${start.pose || 'stand'}→${end.pose || 'stand'}${end.animationName ? `，骨骼动画“${end.animationName}”` : ''}${end.action ? `，动作“${end.action}”` : ''}`;
  });
  const firstLights = lights[0]?.lights || [];
  const lastLights = new Map((lights.at(-1)?.lights || firstLights).map((x) => [x.id, x]));
  const lighting = firstLights.map((start) => {
    const end = lastLights.get(start.id) || start;
    return `${start.id}使用${start.type || 'spot'}光，颜色${start.color || '#ffffff'}，强度${Number(start.intensity || 0).toFixed(1)}→${Number(end.intensity || 0).toFixed(1)}，照向${end.targetId || '主体'}`;
  });
  const pointNames = { rightHand: '右手', leftHand: '左手', back: '背部', waist: '腰部' };
  const attachedProps = (attachments[0]?.props || []).map((item) => `${item.name || item.id}固定在${item.actorId}的${pointNames[item.point] || item.point || '挂点'}，全程随人物移动和转身，不得漂浮、穿模或换手`);

  return `【3D预演控制】严格保持首尾构图与空间关系；${camera}`
    + `${actors.length ? `；人物轨迹：${actors.join('；')}` : ''}`
    + `${attachedProps.length ? `；人物道具绑定：${attachedProps.join('；')}` : ''}`
    + `${lighting.length ? `；灯光连续性：${lighting.join('；')}` : ''}`
    + `；按 ${Number(bundle.fps || 24)}fps、${Number(bundle.maxFrame || 0)} 帧平滑插值，不要让人物、道具或机位瞬移。`;
}

