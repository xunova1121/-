/** 分层设计边界：只保存语义与坐标，不允许任意SVG/HTML/脚本/远端资源。 */
import { wrapParagraphs } from './posterComposition.js';

export const designError = (message, code = 'DESIGN_INVALID') => Object.assign(new Error(message), { code, kind: 'input' });
export const DESIGN_LIMITS = { layers: 160, text: 12000, source: 180000, pixels: 16e6, side: 4096 };
export const PALETTES = {
  campaign: { background: '#EEF6FF', ink: '#10365A', muted: '#294F70', accent: '#1259A5', card: '#FFFFFF' },
  editorial: { background: '#F5F2EB', ink: '#192D30', muted: '#405356', accent: '#962F1B', card: '#FFFFFF' },
  celebration: { background: '#FFF6EB', ink: '#493E41', muted: '#5D4D52', accent: '#8B3342', card: '#FFFFFF' },
  dashboard: { background: '#06162A', ink: '#F1F8FF', muted: '#A1BCD3', accent: '#58D9F5', card: '#0D2841' }
};
export function color(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) throw designError('颜色需为六位十六进制值');
  return value.toUpperCase();
}
export function boundedText(value = '', limit = 3000) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || [...value].some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)) throw designError('文字类型无效、含控制符/孤立代理项或超出长度限制');
  return value;
}
const checkedNumber = (value, min, max, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw designError(`${name}超出允许范围`);
  return value;
};
// 只有布局像素舍入；原始业务数值必须保留，不能复用坐标精度改掉数据。
const finite = (value, min, max, name) => Math.round(checkedNumber(value, min, max, name) * 1000) / 1000;
export function designId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][\w-]{0,47}$/.test(value)) throw designError('图层/素材ID需为48字符以内的英文字母开头标识');
  return value;
}
function normalizeLayer(node, canvas, fitText = true) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw designError('图层必须是对象');
  const id = designId(node.id), type = node.type;
  if (!['text', 'shape', 'icon', 'image', 'chart'].includes(type)) throw designError('不支持的图层类型');
  const x = finite(node.x, 0, canvas.width, '横坐标'), y = finite(node.y, 0, canvas.height, '纵坐标');
  const w = finite(node.w, 1, canvas.width, '宽度'), h = finite(node.h, 1, canvas.height, '高度');
  if (x + w > canvas.width + 0.01 || y + h > canvas.height + 0.01) throw designError(`图层${id}超出画布，未裁掉文字`, 'DESIGN_BOUNDS');
  const out = { id, type, x, y, w, h, color: color(node.color, canvas.palette.ink), fill: color(node.fill, canvas.palette.card),
    group: boundedText(node.group || id, 60), category: boundedText(node.category || '', 40), detail: boundedText(node.detail || '', 1600), decorative: node.decorative === true };
  if (node.stroke !== undefined) out.stroke = color(node.stroke);
  if (node.role !== undefined) {
    if (!['heading', 'body', 'label', 'caption'].includes(node.role)) throw designError('文字用途需为heading/body/label/caption');
    out.role = node.role;
  }
  out.radius = finite(node.radius ?? 0, 0, Math.min(w, h) / 2, '圆角');
  if (type === 'text') {
    out.text = boundedText(node.text);
    out.fontSize = finite(node.fontSize ?? 32, 12, 300, '字号');
    out.minFontSize = finite(node.minFontSize ?? Math.min(out.fontSize, Math.max(12, out.fontSize * 0.78)), 12, out.fontSize, '最小字号');
    out.weight = node.weight === 700 ? 700 : 400;
    out.align = ['left', 'center', 'right'].includes(node.align) ? node.align : 'left';
    if (fitText) fitDesignText(out);
  }
  if (type === 'icon') {
    if (!['news', 'chart', 'leaf', 'heart', 'star', 'calendar', 'cloud', 'check', 'arrow', 'building'].includes(node.icon)) throw designError('请选择内置矢量图标');
    out.icon = node.icon;
  }
  if (type === 'image') { out.asset = designId(node.asset); out.fit = node.fit === 'contain' ? 'contain' : 'cover'; }
  if (type === 'chart') {
    if (node.chartType !== undefined && !['line', 'bar'].includes(node.chartType)) throw designError('图表类型需为line或bar');
    if (node.chartType !== undefined) out.chartType = node.chartType;
    if (node.unit !== undefined) out.unit = boundedText(node.unit, 20);
    if (!Array.isArray(node.points) || node.points.length < 2 || node.points.length > 24) throw designError('图表需2–24个明确数据点');
    out.points = node.points.map(p => ({ label: boundedText(p.label, 40), value: checkedNumber(p.value, -1e10, 1e10, '图表值') }));
  }
  return out;
}
/** 保守估宽、完整换行；宁可拒绝溢出，也不省略、横压或伪造缺字检查。 */
export function fitDesignText(node) {
  for (let size = node.fontSize; size >= node.minFontSize; size = Math.round((size - 0.5) * 1000) / 1000) {
    // 仅分层稿按词折行；原图填字和旧上下/左右排版保持原来的字号、行数及像素位置。
    const rows = wrapParagraphs(node.text, size, node.w, { wordWrap: true });
    if (rows && rows.length * size * 1.4 <= node.h + 0.01) return { fontSize: size, lineHeight: size * 1.4, rows };
  }
  const rows = wrapParagraphs(node.text, node.minFontSize, node.w, { wordWrap: true });
  throw Object.assign(designError(`图层${node.id}文案放不下；请增大文字框或明确调整排版，未截字`, 'DESIGN_TEXT_OVERFLOW'), {
    repair: { field: rows ? 'h' : 'w', ...(rows && { minimumHeight: Math.ceil(rows.length * node.minFontSize * 1.4) }), minimumFontSize: node.minFontSize }
  });
}
/** 错误逐项收集，不能让模型为四个独立文字框来回猜四次。 */
export function throwDesignIssues(issues) {
  const first = issues[0];
  // 原件最多160层及少量顶层字段，完整保留供按编号读取；模型发送副本另有2000字符预算。
  throw Object.assign(designError(first.message, first.code), { issues: issues.slice(0, DESIGN_LIMITS.layers + 8), issueCount: issues.length });
}
export function normalizeLayerDesign(raw, { fitText = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw designError('分层设计必须是对象');
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height)) throw designError('画布需为原始整数像素，不能先舍入后冒充整数');
  const width = finite(raw.width, 256, 4096, '画布宽度'), height = finite(raw.height, 256, 4096, '画布高度');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > DESIGN_LIMITS.pixels) throw designError('画布需整数像素，最长4096且不超过1600万像素');
  const issues = [];
  const checked = (read, field, id) => {
    try { return read(); }
    catch (error) {
      if (error.kind !== 'input') throw error;
      issues.push({ code: error.code, field, ...(typeof id === 'string' && /^[A-Za-z][\w-]{0,47}$/.test(id) && { id }), message: error.message, ...error.repair });
    }
  };
  const title = checked(() => {
    const value = boundedText(raw.title, 300);
    if (!value.trim()) throw designError('请提供准确标题');
    return value;
  }, 'title');
  const palette = Object.fromEntries(Object.keys(PALETTES.editorial).map(key => [key, color(raw.palette?.[key], PALETTES.editorial[key])]));
  const canvas = { width, height, palette };
  if (!Array.isArray(raw.layers) || !raw.layers.length || raw.layers.length > DESIGN_LIMITS.layers) throw designError('设计需1–160个独立图层');
  const layers = raw.layers.map((node, i) => checked(() => normalizeLayer(node, canvas, fitText), `layers[${i}]`, node?.id)).filter(Boolean);
  if (issues.length) throwDesignIssues(issues);
  if (new Set(layers.map(n => n.id)).size !== layers.length) throw designError('图层ID不能重复');
  if (layers.filter(n => n.type === 'image').length > 4) throw designError('每张设计最多放4个图片图层');
  if (!layers.some(n => n.type === 'text' && n.text.trim()) || layers.reduce((sum, n) => sum + (n.text?.length || 0), 0) > DESIGN_LIMITS.text) throw designError('设计需有文字，全文不超过12000字');
  const dataMode = raw.dataMode === 'provided' ? 'provided' : 'demo';
  const source = boundedText(raw.source || '', 1000);
  if (dataMode === 'provided' && !source.trim()) throw designError('用户提供数据需填写来源说明；不据此证明已联网核实');
  if (raw.fontFamily !== undefined && !['sans', 'serif'].includes(raw.fontFamily)) throw designError('字体请选择sans黑体或serif宋体');
  if (raw.reading !== undefined && !['phone', 'desktop'].includes(raw.reading)) throw designError('阅读场景需为phone或desktop');
  return { kind: 'layered-design', version: 1, title, width, height, palette, layers, dataMode, source, asOf: boundedText(raw.asOf || '', 100), fontFamily: raw.fontFamily || 'sans',
    ...(raw.illustrated === true && { illustrated: true }),
    ...(raw.reading !== undefined && { reading: raw.reading }),
    assets: normalizeAssets(raw.assets), states: normalizeStates(raw.states, layers, canvas) };
}
function normalizeAssets(assets = []) {
  if (!Array.isArray(assets) || assets.length > 4) throw designError('素材数量不能超过4');
  const out = assets.map(a => {
    if (!a || typeof a !== 'object' || typeof a.path !== 'string' || !/\.(png|jpe?g|webp)$/i.test(a.path) || a.path.length > 300 || /^(?:https?:|data:|blob:)/i.test(a.path)) throw designError('素材需使用工作区PNG/JPEG/WebP路径');
    if (a.hash !== undefined && !/^[a-f0-9]{64}$/.test(a.hash)) throw designError('素材摘要无效');
    return { id: designId(a.id), path: a.path, ...(a.hash && { hash: a.hash }) };
  });
  if (new Set(out.map(a => a.id)).size !== out.length) throw designError('素材ID不能重复');
  return out;
}
function normalizeStates(states = [], layers, canvas) {
  if (!Array.isArray(states) || states.length > 4) throw designError('数据快照最多4组');
  return states.map(state => {
    if (!Array.isArray(state.changes) || state.changes.length > 40) throw designError('每个快照最多40处值变化');
    const changes = state.changes.map(change => {
      const before = layers.find(n => n.id === change.id);
      if (!before || before.type !== 'text' && before.type !== 'chart') throw designError('快照仅允许更新存在的文字或图表');
      if (Object.keys(change).some(key => !['id', 'text', 'points'].includes(key))) throw designError('快照不可修改图层坐标、类型或素材');
      const after = normalizeLayer({ ...before, ...change }, canvas);
      return { id: after.id, ...(after.type === 'text' ? { text: after.text } : { points: after.points }) };
    });
    return { label: boundedText(state.label, 100), changes };
  });
}
