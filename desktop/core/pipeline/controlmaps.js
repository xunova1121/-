/** 从预演台空间与关键帧导出可控视频模型能消费的控制包。 */
import { attachmentPose, frameState, normalizeStage, propEventBetween, spatialIssues, stageObjects } from '../../ui/previz-stage.js';

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
  /**
   * ⚠ 时长收不下的值要在门口挡掉，不能让它往下走。
   *
   * 原来是 `Math.max(1, Math.round(Number(duration || 5) * FPS))`。
   * duration 传进来一个非数字字符串（'5秒'、老项目里没规整过的字段）时：
   *   Number('5秒') → NaN → maxFrame 是 NaN
   *   → 采样过滤 `x <= NaN` 把所有帧都筛掉 → frames 是空数组
   *   → 下面 `first.objects` 抛 "Cannot read properties of undefined"
   *
   * 一个"时长写错了"的问题，最后以一句看不懂的 TypeError 露面，
   * 而且指向的是一行跟时长毫无关系的代码。
   *
   * 负数同理：-3 会静默变成 1 帧，出一个谁也没要的单帧计划。
   */
  const seconds = Number(duration);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
  const maxFrame = Math.max(1, Math.round(safeSeconds * FPS));
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
  const focusSequence = sampled.map(({ frame, stage }) => {
    const cam = stage.cam || {};
    const target = stageObjects(stage).find((x) => x.item.id === cam.focusId)?.item;
    const pose = target ? (attachmentPose(stage, target) || target) : null;
    const distance = pose
      ? Math.hypot(Number(pose.x || 0) - Number(cam.x || 0), Number(pose.y || 0) - Number(cam.y || 0), Number(pose.elevation || pose.height || 1) - Number(cam.height || 1.6))
      : Number(cam.focusDistance || 3);
    const aperture = Number(cam.aperture || 4);
    return { frame, time: Number((frame / FPS).toFixed(3)), targetId: cam.focusId || '', targetName: target?.name || '',
      distance: Number(distance.toFixed(3)), aperture, depthBand: Number(Math.max(.3, aperture * .18).toFixed(3)) };
  });
  const poseSequence = sampled.map(({ frame, stage }) => ({ frame, subjects: (stage.subjects || []).map((x) => ({ id: x.id, x: x.x, y: x.y, height: x.height, rotation: x.rotation, scale: x.scale, pose: x.pose || 'stand', action: x.action || '', animationName: x.animationName || '', textureView: x.textureView || 'auto' })) }));
  const lightSequence = sampled.map(({ frame, stage }) => ({ frame, time: Number((frame / FPS).toFixed(3)), lights: (stage.lights || []).map((x) => ({ id: x.id, type: x.lightType, x: x.x, y: x.y, height: x.height, intensity: x.intensity, color: x.color, targetId: x.targetId || '' })) }));
  // 全量道具状态不能只保留“当前被拿着的”；拿起、递交、放下的未绑定帧也重要。
  const propSequence = sampled.map(({ frame, stage }) => ({
    frame, time: Number((frame / FPS).toFixed(3)), props: (stage.marks || []).filter((x) => !x.far).map((item) => {
      const world = attachmentPose(stage, item);
      return { id: item.id, name: item.name, actorId: item.attachToId || '', point: item.attachPoint || '',
        x: Number(world?.x ?? item.x ?? 0), y: Number(world?.y ?? item.y ?? 0), elevation: Number(world?.elevation ?? item.elevation ?? 0),
        offsetX: Number(item.attachOffsetX || 0), offsetY: Number(item.attachOffsetY || 0), offsetZ: Number(item.attachOffsetZ || 0), grounded: item.grounded !== false };
    })
  }));
  const attachmentSequence = propSequence.map(({ frame, time, props }) => ({ frame, time, props: props.filter((item) => item.actorId) }));
  const propEvents = [];
  const previousPropState = new Map();
  for (const state of propSequence) for (const item of state.props || []) {
    const before = previousPropState.get(item.id);
    const type = propEventBetween(before, item);
    if (type) {
      propEvents.push({ type, frame: state.frame, time: state.time, propId: item.id, propName: item.name || item.id,
        fromActorId: before.actorId || '', fromPoint: before.point || '', toActorId: item.actorId || '', toPoint: item.point || '',
        x: item.x, y: item.y, elevation: item.elevation });
    }
    previousPropState.set(item.id, item);
  }
  // 动作不能只留在最后一帧的文字里：例如第 0 帧“持刀警戒”、第 48 帧“右手拔刀”，
  // 两句之间的顺序正是视频模型最容易颠倒的地方。把变化点单列成节拍，既能喂模型，
  // 也能在出片失败时追溯“到底要求它在哪一帧做什么”。
  const actionSequence = (base.subjects || []).map((subject) => {
    const beats = [];
    let previous = null;
    for (const { frame, stage } of sampled) {
      const actor = (stage.subjects || []).find((item) => item.id === subject.id) || subject;
      const heldProps = (stage.marks || []).filter((item) => !item.far && item.attachToId === subject.id)
        .map((item) => ({ id: item.id, name: item.name || item.id, point: item.attachPoint || 'rightHand' }));
      const signature = JSON.stringify([actor.pose || 'stand', actor.action || '', actor.animationName || '',
        heldProps.map((item) => `${item.id}:${item.point}`)]);
      if (!previous || previous.signature !== signature) {
        const distance = previous ? Math.hypot(Number(actor.x || 0) - previous.x, Number(actor.y || 0) - previous.y) : 0;
        const elapsed = previous ? Math.max(1 / FPS, (frame - previous.frame) / FPS) : 0;
        beats.push({
          frame, time: Number((frame / FPS).toFixed(3)), pose: actor.pose || 'stand', action: actor.action || '',
          animationName: actor.animationName || '', rotation: Number(actor.rotation || 0), heldProps,
          speedFromPrevious: Number((distance / Math.max(elapsed, 1 / FPS)).toFixed(3))
        });
      }
      previous = { frame, x: Number(actor.x || 0), y: Number(actor.y || 0), signature };
    }
    return { id: subject.id, name: subject.name || subject.id, beats };
  });
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
  // 这是跨镜头“视觉状态记忆”的可序列化基线：下一镜既能拿它作接缝核验，
  // 也能把上一镜落点作为首帧约束，而不是只记一段泛泛的提示词。
  const visualStateMemory = {
    start: { frame: first.frame, subjects: poseSequence[0]?.subjects || [], props: propSequence[0]?.props || [], camera: trajectory[0] || {}, lights: lightSequence[0]?.lights || [] },
    end: { frame: last.frame, subjects: poseSequence.at(-1)?.subjects || [], props: propSequence.at(-1)?.props || [], camera: trajectory.at(-1) || {}, lights: lightSequence.at(-1)?.lights || [] }
  };
  return { start: first.rgb, end: last.rgb, depth: first.depth, mask: first.mask, edge: first.edge, pose: first.pose,
    frames, sampleEvery: Math.max(1, sampleEvery), controlFps: Number((FPS / Math.max(1, sampleEvery)).toFixed(3)), width: W, height: H, fps: FPS, maxFrame,
    keyframes: (base.keyframes || []).map((x) => x.frame), motionEasing: base.motionEasing || 'easeInOut',
    pathInterpolation: base.pathInterpolation || 'linear',
    trajectory, focusSequence, poseSequence, actionSequence, motionPaths, lightSequence, propSequence, propEvents, attachmentSequence, visualStateMemory, layers, issues,
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
  const actions = bundle.actionSequence || [];
  const lights = bundle.lightSequence || [];
  const attachments = bundle.attachmentSequence || [];
  const props = bundle.propSequence || attachments;
  const propEvents = bundle.propEvents || [];
  const focus = bundle.focusSequence || [];
  const state = bundle.visualStateMemory || {};
  if (!trajectory.length && !poses.length && !paths.length && !actions.length && !lights.length && !attachments.length) return '';

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
  const propBeats = new Map();
  for (const state of props) for (const item of state.props || []) {
    const signature = [item.actorId || '', item.point || '', Number(item.x || 0).toFixed(2), Number(item.y || 0).toFixed(2), Number(item.elevation || 0).toFixed(2)].join('|');
    const track = propBeats.get(item.id) || { name: item.name || item.id, beats: [], signature: null };
    if (track.signature !== signature) {
      track.beats.push({ frame: state.frame, actorId: item.actorId, point: item.point, x: item.x, y: item.y, elevation: item.elevation });
      track.signature = signature;
    }
    propBeats.set(item.id, track);
  }
  const propActions = [...propBeats.values()].map((track) => {
    const beats = track.beats.slice(0, 6).map((beat) => beat.actorId
      ? `${beat.frame}帧由${beat.actorId}持于${pointNames[beat.point] || beat.point || '挂点'}`
      : `${beat.frame}帧落在(${Number(beat.x || 0).toFixed(2)},${Number(beat.y || 0).toFixed(2)},${Number(beat.elevation || 0).toFixed(2)})`);
    return beats.length ? `${track.name}：${beats.join(' → ')}` : '';
  }).filter(Boolean);
  const eventNames = { pickup: '拿起', drop: '放下', handoff: '交接' };
  const propEventActions = propEvents.slice(0, 12).map((event) => `${event.frame}帧${eventNames[event.type] || event.type}${event.propName || event.propId}${event.toActorId ? `，交给${event.toActorId}的${pointNames[event.toPoint] || event.toPoint || '挂点'}` : ''}`);
  const actionBeats = actions.map((track) => {
    const beats = (track.beats || []).slice(0, 6).map((beat) => {
      const held = (beat.heldProps || []).map((item) => `${item.name}在${pointNames[item.point] || item.point}`).join('、');
      const move = Number(beat.speedFromPrevious || 0) > .02 ? `，承接速度${Number(beat.speedFromPrevious).toFixed(2)}m/s` : '';
      return `${beat.frame}帧${beat.pose || 'stand'}${beat.animationName ? `/${beat.animationName}` : ''}${beat.action ? `，${beat.action}` : ''}${held ? `，${held}` : ''}${move}`;
    });
    return beats.length ? `${track.name || track.id}：${beats.join(' → ')}` : '';
  }).filter(Boolean);
  const firstFocus = focus[0], lastFocus = focus.at(-1) || firstFocus;
  const focusPull = firstFocus && lastFocus
    ? `焦点从${firstFocus.targetName || firstFocus.targetId || `${firstFocus.distance.toFixed(1)}米`}平滑拉到${lastFocus.targetName || lastFocus.targetId || `${lastFocus.distance.toFixed(1)}米`}，清晰范围约±${lastFocus.depthBand.toFixed(1)}米，焦点不得抽动`
    : '';

  const pathShape = bundle.pathInterpolation === 'smooth' ? '所有机位与人物移动按平滑曲线过弯' : '所有机位与人物按关键帧之间直线移动';
  const endState = state.end?.subjects?.length ? `本镜结束状态已冻结：${state.end.subjects.map((item) => `${item.id}位于(${Number(item.x || 0).toFixed(2)},${Number(item.y || 0).toFixed(2)})、朝向${Number(item.rotation || 0).toFixed(0)}°`).join('；')}；后续连续镜必须承接此状态` : '';
  return `【3D预演控制】严格保持首尾构图与空间关系；${pathShape}；${camera}`
    + `${actors.length ? `；人物轨迹：${actors.join('；')}` : ''}`
    + `${actionBeats.length ? `；动作节拍（严格按时间顺序，不得提前、倒放或漏做）：${actionBeats.join('；')}` : ''}`
    + `${propActions.length ? `；道具状态节拍（严格执行拿起、交接、放下顺序，不得凭空出现、漂浮或换手）：${propActions.join('；')}` : ''}`
    + `${propEventActions.length ? `；道具交互事件：${propEventActions.join(' → ')}` : ''}`
    + `${focusPull ? `；焦点拉移：${focusPull}` : ''}`
    + `${lighting.length ? `；灯光连续性：${lighting.join('；')}` : ''}`
    + `${endState ? `；${endState}` : ''}`
    + `；按 ${Number(bundle.fps || 24)}fps、${Number(bundle.maxFrame || 0)} 帧平滑插值，不要让人物、道具或机位瞬移。`;
}

/**
 * 连续动作镜的上一镜“最后状态”与下一镜“第一状态”能不能接上。
 *
 * 这项检查只看预演控制数据，不碰视频模型也不读图片，所以在花钱生成前、成片
 * 审核时都能跑。它不替代首尾帧像素复核，而是提前发现更基本的导演错误：人已经
 * 走到门边，下一镜却回到屋中央；刀上一镜在右手，下一镜跳到左手。
 */
export function actionContinuityIssues(previous = {}, next = {}) {
  const out = [];
  const prevPose = previous.poseSequence?.at(-1)?.subjects || [];
  const nextPose = next.poseSequence?.[0]?.subjects || [];
  const byId = new Map(prevPose.map((item) => [item.id, item]));
  for (const start of nextPose) {
    const end = byId.get(start.id);
    if (!end) continue;
    const distance = Math.hypot(Number(start.x || 0) - Number(end.x || 0), Number(start.y || 0) - Number(end.y || 0));
    if (distance > 1.25) out.push({
      kind: 'actor-position-break', severity: 'high', actorId: start.id,
      what: `${start.id} 在两镜接缝相差 ${distance.toFixed(2)} 米`,
      why: '连续动作的下一镜首帧应承接上一镜末帧；人物突然换位会被读成瞬移。',
      fix: '把下一镜人物首个关键帧对齐到上一镜末帧，或把两镜改为硬切。'
    });
    const turn = Math.abs((((Number(start.rotation || 0) - Number(end.rotation || 0)) + 540) % 360) - 180);
    if (turn > 95) out.push({
      kind: 'actor-facing-break', severity: 'normal', actorId: start.id,
      what: `${start.id} 在接缝突然转向 ${Math.round(turn)}°`,
      why: '没有中间转身动作时，人物朝向大幅跳变会显得穿帮。',
      fix: '在上一镜尾部或下一镜开头加入转身关键帧，再让动作路径平滑承接。'
    });
    if ((start.pose || 'stand') !== (end.pose || 'stand') && !String(start.action || '').trim()) out.push({
      kind: 'actor-pose-break', severity: 'normal', actorId: start.id,
      what: `${start.id} 从${end.pose || 'stand'}直接变为${start.pose || 'stand'}`,
      why: '姿态改变没有对应动作说明，模型容易把它做成跳帧或肢体畸变。',
      fix: '为下一镜首帧填写动作指令，或在上一镜尾部补一个姿态过渡关键帧。'
    });
  }
  const prevProps = new Map((previous.attachmentSequence?.at(-1)?.props || []).map((item) => [item.id, item]));
  for (const item of next.attachmentSequence?.[0]?.props || []) {
    const before = prevProps.get(item.id);
    if (before && (before.actorId !== item.actorId || before.point !== item.point)) out.push({
      kind: 'prop-hand-break', severity: 'high', propId: item.id,
      what: `${item.name || item.id} 从${before.actorId}的${before.point}跳到${item.actorId}的${item.point}`,
      why: '手持道具换手或换人却没有交接动作，连续镜头里会非常明显。',
      fix: '保持首尾挂点一致；确实要交接时拆成独立动作镜，并写明交接过程。'
    });
  }
  // 全量道具状态可发现落地道具在两镜之间凭空跳位；旧项目回退到持有道具序列。
  const previousPropStates = previous.propSequence?.at(-1)?.props || previous.attachmentSequence?.at(-1)?.props || [];
  const nextPropStates = next.propSequence?.[0]?.props || next.attachmentSequence?.[0]?.props || [];
  const allPreviousProps = new Map(previousPropStates.map((item) => [item.id, item]));
  for (const item of nextPropStates) {
    const before = allPreviousProps.get(item.id);
    if (!before) continue;
    const distance = Math.hypot(Number(item.x || 0) - Number(before.x || 0), Number(item.y || 0) - Number(before.y || 0), Number(item.elevation || 0) - Number(before.elevation || 0));
    const heldBefore = before.actorId ? `${before.actorId}:${before.point || 'rightHand'}` : '';
    const heldAfter = item.actorId ? `${item.actorId}:${item.point || 'rightHand'}` : '';
    if (distance > 1.25 && !heldBefore && !heldAfter) out.push({
      kind: 'prop-position-break', severity: 'high', propId: item.id,
      what: `${item.name || item.id} 在两镜接缝相差 ${distance.toFixed(2)} 米`,
      why: '静止或落地道具突然换位会被读成凭空移动。',
      fix: '把下一镜首帧道具坐标对齐上一镜末帧，或增加一段拿取/移动的过渡镜。'
    });
    if (heldBefore !== heldAfter && !(heldBefore && heldAfter)) out.push({
      kind: 'prop-pickup-break', severity: 'normal', propId: item.id,
      what: `${item.name || item.id} 在接缝${heldBefore ? '突然放下' : '突然被拿起'}`,
      why: '拿起或放下没有对应动作节拍，视频模型容易做成闪现。',
      fix: '在上一镜尾部或下一镜开头增加道具交互关键帧，并填写拿取/放下动作。'
    });
  }
  const prevLights = new Map((previous.lightSequence?.at(-1)?.lights || []).map((item) => [item.id, item]));
  for (const item of next.lightSequence?.[0]?.lights || []) {
    const before = prevLights.get(item.id);
    if (before && before.color !== item.color) out.push({
      kind: 'light-color-break', severity: 'normal', lightId: item.id,
      what: `${item.id} 的灯色从${before.color}变为${item.color}`,
      why: '同一瞬间的色温跳变会让两个镜头像不同时间、不同地点拍的。',
      fix: '保持接缝两端灯色一致；需要变色时在上一镜内用关键帧渐变。'
    });
  }
  return out;
}
