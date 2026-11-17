/** 源稿只存有界参数和素材摘要；编辑另存，源图读一次并用同一字节核验/渲染。 */
import * as ws from './workspace.js';
import { imageFingerprint } from './visualEvidence.js';
import { assertImageExtension } from './imageFormat.js';
import { normalizePosterBackground } from './posterCompositionInput.js';
import { DESIGN_LIMITS, designError, normalizeLayerDesign } from './layeredDesignInput.js';
import { planLayerDesign, planReadableLayerDesign } from './layeredDesignLayout.js';
import { throwControl } from '../core/networkRequest.js';
import { scopedState } from './store.js';
import { prepareFreeLayerDesign } from './layeredDesignPreflight.js';

// 每个账号/后端最多64个在途输出名；WeakMap随原存储作用域回收，不在账号间共享文件名。
const outputState = scopedState('files', () => new Set());
const outputExtensions = ['design.json', 'svg', 'pptx', 'png', 'html', 'zip', 'phone.png'];
const outputNames = base => outputExtensions.map(ext => `${base}.${ext}`);
export const releaseLayerOutputBase = base => outputState().delete(base);

/** 换构图时默认从原图层提取完整栏目，不把旧成品烘焙成新底图。 */
function reflowInput(input, previous) {
  if (input.changes) throw designError('重新构图design与局部changes请分开，避免悄悄忽略改动');
  const spec = input.design;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw designError('design需为构图对象');
  const groups = [...new Set(previous.layers.filter(n => /^section-\d+-title$/.test(n.id)).map(n => n.group))];
  const sections = groups.map(group => {
    const members = previous.layers.filter(n => n.group === group), get = suffix => members.find(n => n.id.endsWith('-' + suffix));
    return { title: get('title').text, body: get('body')?.text || '', ...(get('value') && { value: get('value').text }),
      icon: get('icon')?.icon, category: get('title').category, detail: get('title').detail,
      eyebrow: get('label')?.text || '', ...(get('image') && { asset: get('image').asset }), ...(get('chart') && { points: get('chart').points, chartType: get('chart').chartType, unit: get('chart').unit }) };
  });
  if (!spec.layers && !spec.sections && !sections.length) throw designError('自由稿重新构图请明确提供layers；未擅自丢掉旧文字');
  const byPath = new Map(previous.assets.map(a => [ws.normalize(a.path), a]));
  const assets = (spec.assets || previous.assets).map(a => {
    const before = byPath.get(ws.normalize(a.path));
    if (before && !before.hash) throw designError('原设计缺少素材摘要');
    return { ...a, ...(before && { hash: before.hash }) };
  });
  const original = id => previous.layers.find(n => n.id === id)?.text;
  return { ...input, title: input.title ?? previous.title, subtitle: input.subtitle ?? original('subtitle'), footer: input.footer ?? original('footer'),
    width: input.width ?? previous.width, height: input.height ?? previous.height, dataMode: input.dataMode ?? previous.dataMode,
    source: input.source ?? previous.source, asOf: input.asOf ?? previous.asOf,
    font_family: input.font_family ?? previous.fontFamily,
    design: { ...spec, concept: spec.concept ?? previous.concept, reading: spec.reading ?? previous.reading, palette: { ...previous.palette, ...spec.palette }, assets, ...(!spec.layers && { sections: spec.sections || sections }) } };
}
export async function loadLayerDesign(input, { signal, defaultSize, autoHeight = false } = {}) {
  throwControl(null, signal);
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > DESIGN_LIMITS.source) throw designError('设计参数超过180KB或格式错误');
  let design, preflight;
  if (input.source_path) {
    if (!/\.design\.json$/i.test(input.source_path)) throw designError('新分层设计仅复用.design.json，旧稿继续用原海报/大屏接口');
    const blob = await ws.readBlob(input.source_path);
    if (blob.size > DESIGN_LIMITS.source) throw designError('设计源文件超过180KB');
    let previous;
    try { previous = JSON.parse(await blob.text()); } catch { throw designError('源文件不是有效JSON'); }
    if (previous?.kind !== 'layered-design' || previous.version !== 1) throw designError('不是支持的分层设计源文件');
    design = normalizeLayerDesign(previous);
    if (input.background_path) throw designError('分层稿更换图片请明确design.assets，不用旧底图字段悄悄换素材');
    if (input.design) {
      const rebuilt = reflowInput(input, design);
      if (input.design.layers) ({ design, preflight } = prepareFreeLayerDesign(rebuilt, defaultSize));
      else design = planLayerDesign(rebuilt, defaultSize);
      if (previous.illustrated === true) design.illustrated = true;
    }
    else if (input.width && input.width !== design.width || input.height && input.height !== design.height || input.size) throw designError('改画幅请同时用design重新构图，不能把旧稿整体拉伸成新画幅');
    if (!Array.isArray(input.changes ?? [])) throw designError('changes需为数组');
    if ((input.changes?.length || 0) > 80) throw designError('一次修改最多80个图层');
    const changes = [...(input.changes || [])];
    if (!input.design && input.title !== undefined) changes.push({ id: 'title', text: input.title });
    if (!input.design && input.subtitle !== undefined) changes.push({ id: 'subtitle', text: input.subtitle });
    if (!input.design && input.footer !== undefined) changes.push({ id: 'footer', text: input.footer });
    if (input.lines !== undefined) throw designError('分层稿请按图层id修改changes，不能用lines覆盖图标/分组布局');
    const seen = new Set(), contentChanged = new Set();
    for (const change of changes) {
      const before = design.layers.find(node => node.id === change?.id);
      if (!before || seen.has(change.id)) throw designError('修改需引用存在且不重复的图层ID');
      if (change.type && change.type !== before.type) throw designError('局部修改不能改变图层类型');
      seen.add(change.id);
      if (change.text !== undefined || change.points !== undefined) contentChanged.add(change.id);
      Object.assign(before, change);
    }
    const titleChange = changes.find(change => change.id === 'title' && change.text !== undefined);
    if (titleChange) design.title = titleChange.text;
    for (const key of ['source', 'dataMode', 'asOf']) if (input[key] !== undefined) design[key] = input[key];
    if (input.font_family !== undefined) design.fontFamily = input.font_family;
    // 标题/正文改字不让数据快照悄悄恢复旧值；显式改过的节点同步移出旧快照。
    design.states = design.states.map(s => ({ ...s, changes: s.changes.filter(c => !contentChanged.has(c.id)) }));
    design = normalizeLayerDesign(design);
  } else if (input.design?.layers) ({ design, preflight } = prepareFreeLayerDesign(input, defaultSize));
  else design = planReadableLayerDesign(input, defaultSize, autoHeight);
  const assets = new Map();
  let totalBytes = 0, totalPixels = 0;
  for (const entry of design.assets) {
    throwControl(null, signal);
    const path = ws.normalize(entry.path), blob = await ws.readBlob(path);
    if ((totalBytes += blob.size) > 10e6) throw designError('素材总大小超过10MB');
    const format = await assertImageExtension(path, blob);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = normalizePosterBackground({ bytes, mime: format?.mime });
    if (!info || (totalPixels += info.width * info.height) > 25e6) throw designError('素材像素总量超过2500万');
    const hash = await imageFingerprint(blob);
    if (!hash) throw designError('不能核验素材摘要，未保存可复用源稿');
    if (input.source_path && !input.design && !entry.hash) throw designError('原设计缺少素材摘要，未假装复用');
    if (entry.hash && hash !== entry.hash) throw designError('源稿引用的原图已变化，未替换或重画素材', 'DESIGN_ASSET_CHANGED');
    entry.path = path; entry.hash = hash;
    assets.set(entry.id, { ...info, bytes, mime: format.mime, hash });
  }
  if (design.layers.some(n => n.type === 'image' && !assets.has(n.asset))) throw designError('图片图层引用了不存在的素材');
  throwControl(null, signal);
  return { design, assets, preflight };
}

export function layerOutputBase(input, design) {
  const safe = [...design.title.replace(/[\\/:*?"<>|\s]+/g, '')].slice(0, 40).join('') || '分层设计';
  const name = input.path || (input.source_path ? input.source_path.replace(/\.design\.json$/i, '') + '-修改-' + Date.now().toString(36) + '.png' : `设计/${safe}.png`);
  if (name.length > 280 || !/\.(png|svg|pptx|html|zip)$/i.test(name)) throw designError('成品路径需为PNG/SVG/PPTX/HTML/ZIP且不超过280字符');
  const base = ws.normalize(name).replace(/\.(png|svg|pptx|html|zip)$/i, '');
  const outputs = outputNames(base);
  if (input.source_path && outputs.includes(ws.normalize(input.source_path)) || design.assets.some(a => outputs.includes(a.path))) throw designError('输出不能覆盖原稿或素材');
  return base;
}
/** 同一组格式整体另存，防止文件夹模式把源稿改名成无法复用的.design (2).json。 */
export async function availableLayerOutputBase(input, design, signal, activeOutputs = outputState()) {
  const original = layerOutputBase(input, design);
  let base = original;
  for (let attempt = 0; attempt < 5; attempt++) {
    throwControl(null, signal);
    if (activeOutputs.size >= 64) throw designError('设计导出繁忙，请稍后重试', 'DESIGN_BUSY');
    const names = outputNames(base);
    const occupied = await Promise.all(names.map(name => ws.exists(name)));
    throwControl(null, signal);
    // await后再次判定，同一时刻两轮都查到“没有文件”也只能有一轮认领原名。
    // foo.phone.png也是foo的整组输出，不能被另一任务以foo.phone为主名抢占。
    const claimed = [...activeOutputs].some(other => outputNames(other).some(name => names.includes(name)));
    if (!occupied.some(Boolean) && !claimed) { activeOutputs.add(base); return base; }
    if (original.length > 240) throw designError('同名成品已存在，请用短一些的新文件名另存');
    base = `${original}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  }
  throw designError('未找到可用的新文件名，请另存重试');
}
export async function claimLayerOutputBase(input, design, signal) {
  const captured = outputState();
  const base = await availableLayerOutputBase(input, design, signal, captured);
  return { base, release: () => captured.delete(base) };
}
export async function saveDesignFile(path, blob, ctx, signal) {
  throwControl(null, signal);
  const saved = await ws.write(path, blob), actual = await ws.readBlob(saved.path);
  const a = new Uint8Array(await blob.arrayBuffer()), b = new Uint8Array(await actual.arrayBuffer());
  if (a.length !== b.length || !a.every((v, i) => v === b[i])) throw designError('写入读回不一致', 'DESIGN_READBACK');
  throwControl(null, signal);
  ctx.onFileChanged?.(saved.path);
  return saved.path;
}
