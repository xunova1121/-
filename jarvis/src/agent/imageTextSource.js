/** 原图一次读回、摘要绑定与整组另存；识别结果随稿复用，不在账号间缓存图片/模型结果。 */
import * as ws from './workspace.js';
import { scopedState } from './store.js';
import { assertImageExtension } from './imageFormat.js';
import { normalizePosterBackground } from './posterCompositionInput.js';
import { imageFingerprint } from './visualEvidence.js';
import { canvasEntries, normalizeCanvasDesign, canvasError } from './imageTextInput.js';
import { locateImageText } from './imageTextRegions.js';
import { validSlotPlan } from './canvasSlotPlan.js';
import { throwControl } from '../core/networkRequest.js';
const claims = scopedState('files', () => new Set());
const suffixes = ['canvas.json', 'png', 'pptx', 'html', 'zip', 'phone.png'];
const paths = (base) => suffixes.map((ext) => `${base}.${ext}`);

export async function loadCanvasText(input, ctx, renderer, { signal, retrieval, progress } = {}) {
  throwControl(null, signal);
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 180000)
    throw canvasError('填字参数无效或超过180KB');
  if (
    [
      'design',
      'lines',
      'text_style',
      'changes',
      'subtitle',
      'footer',
      'preset',
      'metrics',
      'series',
      'alerts',
      'markers'
    ].some((key) => input[key] !== undefined)
  )
    throw canvasError('Canvas填字请用canvas.entries/header/footer及regions修改，不混用旧版式或数据参数');
  let previous;
  if (input.source_path) {
    if (!/\.canvas\.json$/i.test(input.source_path)) throw canvasError('底图填字请复用.canvas.json，旧稿保留原入口');
    const raw = await ws.readBlob(input.source_path);
    if (raw.size > 180000) throw canvasError('填字源稿超过180KB');
    let value;
    try {
      value = JSON.parse(await raw.text());
    } catch {
      throw canvasError('填字源稿JSON无效');
    }
    previous = normalizeCanvasDesign(value);
  }
  if (previous && input.background_path && ws.normalize(input.background_path) !== previous.image.path)
    throw canvasError('改文案不能悄悄换原图，请用新稿明确选择底图');
  const imagePath = ws.normalize(input.background_path || previous?.image.path || '');
  if (!imagePath) throw canvasError('请提供已有无字底图background_path');
  const blob = await ws.readBlob(imagePath);
  if (blob.size > 10e6) throw canvasError('底图超过10MB');
  const format = await assertImageExtension(imagePath, blob);
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    meta = normalizePosterBackground({ bytes, mime: format?.mime });
  if (!meta || meta.width * meta.height > 25e6) throw canvasError('底图不是支持的PNG/JPEG/WebP或像素超限');
  const hash = await imageFingerprint(blob);
  if (
    !hash ||
    (previous &&
      (previous.image.hash !== hash || previous.image.width !== meta.width || previous.image.height !== meta.height))
  )
    throw canvasError('源稿引用的原图已变化，未替换或重画素材', 'CANVAS_IMAGE_CHANGED');
  const spec = input.canvas || {};
  if (typeof spec !== 'object' || Array.isArray(spec)) throw canvasError('canvas必须是填字参数对象');
  if (spec.entries !== undefined && !Array.isArray(spec.entries)) throw canvasError('canvas.entries必须为文案数组');
  for (const [key, max] of [
    ['regions', 22],
    ['protected', 20]
  ])
    if (spec[key] !== undefined && (!Array.isArray(spec[key]) || spec[key].length > max))
      throw canvasError('文字区/保护区需为限额内的坐标数组');
  const canonicalBlob = blob.type === format.mime ? blob : new Blob([bytes], { type: format.mime });
  const oldSlots = previous?.entries.filter((e) => e.role === 'slot') || [];
  let entries = spec.entries
    ? canvasEntries({
        ...spec,
        entries: spec.entries.map((e, i) => ({ ...e, id: e.id || oldSlots[i]?.id })),
        header: spec.header === undefined ? previous?.entries.find((e) => e.role === 'header') : spec.header,
        footer: spec.footer === undefined ? previous?.entries.find((e) => e.role === 'footer')?.title : spec.footer
      })
    : previous?.entries;
  if (previous && !spec.entries && (spec.header !== undefined || spec.footer !== undefined)) {
    const header = previous.entries.find((e) => e.role === 'header');
    entries = canvasEntries({
      entries: previous.entries.filter((e) => e.role === 'slot'),
      header: spec.header === undefined ? header : spec.header,
      footer: spec.footer === undefined ? previous.entries.find((e) => e.role === 'footer')?.title : spec.footer
    });
  }
  if (!entries) throw canvasError('请在canvas.entries提供原始文案');
  let located;
  if (previous && spec.regions === undefined)
    located = {
      regions: previous.regions,
      protected: spec.protected || previous.protected,
      detection: previous.detection
    };
  else {
    progress?.('正在识别原图中的文字区，保留人物和图标…');
    const inspected = await renderer.inspect(canonicalBlob, { signal });
    if (inspected.width !== meta.width || inspected.height !== meta.height)
      throw canvasError('真实解码尺寸与原图不一致');
    // 同名 .slots.json 是生图前算好的卡槽计划（generate_image purpose=poster_slots 写入）
    let plan = null;
    if (!previous && spec.regions === undefined) {
      const planPath = imagePath.replace(/\.[^./]+$/, '.slots.json');
      try {
        if (planPath !== imagePath && (await ws.exists(planPath)))
          plan = validSlotPlan(JSON.parse(await (await ws.readBlob(planPath)).text()), meta.width, meta.height);
      } catch (error) {
        throwControl(error, signal);
        plan = null;
      }
    }
    located = await locateImageText({
      plan,
      spec,
      entries,
      blob: canonicalBlob,
      frame: inspected.frame,
      ctx,
      signal,
      retrieval
    });
  }
  const design = normalizeCanvasDesign({
    ...previous,
    kind: 'canvas-image-text',
    version: 1,
    title: input.title || previous?.title || spec.header?.title || entries[0].title,
    image: { path: imagePath, hash, width: meta.width, height: meta.height },
    width: input.width ?? previous?.width ?? meta.width,
    height: input.height ?? previous?.height ?? meta.height,
    entries,
    ...located,
    fontFamily: input.font_family ?? previous?.fontFamily ?? 'sans',
    reading: spec.reading ?? previous?.reading ?? 'phone',
    titleSize: spec.title_size ?? previous?.titleSize,
    bodySize: spec.body_size ?? previous?.bodySize,
    textColor: spec.text_color ?? previous?.textColor
  });
  return { design, blob: canonicalBlob, bytes, mime: format.mime };
}
export async function claimCanvasName(input, design, signal) {
  const original =
    input.path ||
    (input.source_path
      ? input.source_path.replace(/\.canvas\.json$/i, '') + '-填字修改.png'
      : '海报/' + design.title.replace(/[\\/:*?"<>|\s]/g, '').slice(0, 36) + '-原图填字.png');
  if (original.length > 230 || !/\.(?:png|pptx|html|zip)$/i.test(original))
    throw canvasError('保存路径需为PNG/PPTX/HTML/ZIP，且不超过230字符');
  const root = ws.normalize(original).replace(/\.(?:png|pptx|html|zip)$/i, ''),
    active = claims();
  if (
    paths(root).includes(design.image.path) ||
    (input.source_path && paths(root).includes(ws.normalize(input.source_path)))
  )
    throw canvasError('输出不得覆盖原图或原稿');
  for (let attempt = 0; attempt < 5; attempt++) {
    throwControl(null, signal);
    if (active.size >= 32) throw canvasError('填字导出繁忙', 'CANVAS_BUSY');
    const base = attempt ? root + '-' + crypto.randomUUID().slice(0, 8) : root,
      names = paths(base);
    const exists = await Promise.all(names.map((path) => ws.exists(path)));
    throwControl(null, signal);
    if (!exists.some(Boolean) && ![...active].some((p) => paths(p).some((path) => names.includes(path)))) {
      active.add(base);
      return { base, release: () => active.delete(base) };
    }
  }
  throw canvasError('无法找到另存文件名，请用较短的新名称');
}
export async function saveCanvasFile(path, blob, ctx, signal) {
  throwControl(null, signal);
  const saved = await ws.write(path, blob),
    check = await ws.readBlob(saved.path);
  const expected = await imageFingerprint(blob);
  if (!expected || expected !== (await imageFingerprint(check)))
    throw canvasError('成品保存读回不一致', 'CANVAS_READBACK');
  throwControl(null, signal);
  ctx.onFileChanged?.(saved.path);
  return saved.path;
}
