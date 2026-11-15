/** 底图填字独立协议：坐标均为原图归一化位置，不接受SVG、HTML或远端图片。 */
import { boundedText, color, designError, designId } from './layeredDesignInput.js';

const number = { type: 'number', minimum: 0, maximum: 1 },
  text = { type: 'string' };
const regionFields = {
  id: text,
  entryId: text,
  role: { type: 'string', enum: ['header', 'slot', 'footer'] },
  x: number,
  y: number,
  w: number,
  h: number
};
export const CANVAS_TEXT_PROPERTIES = {
  canvas: {
    type: 'object',
    additionalProperties: false,
    description:
      '已有底图直接填字。只叠真实字体，不生成SVG、不裁切原图、不加面板；自动识别卡槽，可提供regions人工指定。root.title为作品名，要画在图上请提供header。',
    properties: {
      header: {
        type: 'object',
        properties: { title: text, body: text },
        required: ['title'],
        additionalProperties: false
      },
      entries: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: { id: text, title: text, body: text },
          required: ['title'],
          additionalProperties: false
        }
      },
      footer: text,
      regions: {
        type: 'array',
        maxItems: 22,
        description: 'x/y/w/h为0到1的原图比例，按header、slot-1…对应文案；不使用屏幕截图像素。',
        items: {
          type: 'object',
          properties: regionFields,
          required: ['id', 'role', 'x', 'y', 'w', 'h'],
          additionalProperties: false
        }
      },
      protected: {
        type: 'array',
        maxItems: 20,
        description: '人物、图标等不允许文字进入的区域；同为原图比例。',
        items: {
          type: 'object',
          properties: { ...regionFields, role: { type: 'string', enum: ['protected'] } },
          required: ['id', 'x', 'y', 'w', 'h'],
          additionalProperties: false
        }
      },
      text_color: text,
      reading: { type: 'string', enum: ['phone', 'desktop'] },
      title_size: { type: 'number', description: '按阅读宽度换算的正文标题字号，默认14，不能小于14' },
      body_size: { type: 'number', description: '按阅读宽度换算的正文字号，默认12，不能小于12' }
    }
  }
};
export const usesCanvasText = (input) => Boolean(input?.canvas || /\.canvas\.json$/i.test(input?.source_path || ''));
export const canvasError = (message, code = 'CANVAS_TEXT_INPUT') =>
  Object.assign(designError(message, code), {
    kind: /TIMEOUT$/.test(code)
      ? 'timeout'
      : /BUSY$/.test(code)
        ? 'busy'
        : /(?:UNAVAILABLE|RENDER_FAILED)$/.test(code)
          ? 'capability'
          : 'input'
  });
export function canvasNumber(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw canvasError(label + '超出允许范围');
  return value;
}
export function canvasRegion(raw, index, protectedArea = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw canvasError('文字区/保护区必须为对象');
  const box = {
    id: designId(raw.id || (protectedArea ? 'protect-' : 'slot-') + (index + 1)),
    role: protectedArea ? 'protected' : raw.role || 'slot'
  };
  if (!['slot', 'header', 'footer', 'protected'].includes(box.role) || (!protectedArea && box.role === 'protected'))
    throw canvasError('文字区用途无效');
  for (const key of ['x', 'y', 'w', 'h']) box[key] = canvasNumber(raw[key], 0, 1, '原图比例');
  if (!box.w || !box.h || box.x + box.w > 1.000001 || box.y + box.h > 1.000001)
    throw canvasError('文字区必须位于原图内，不能越界');
  if (!protectedArea && raw.entryId !== undefined) box.entryId = designId(raw.entryId);
  return box;
}
export function canvasEntries(spec) {
  if (!Array.isArray(spec.entries) || !spec.entries.length || spec.entries.length > 20)
    throw canvasError('请提供1–20组完整文案');
  if (spec.entries.some((e) => !e || typeof e !== 'object' || Array.isArray(e)))
    throw canvasError('每组文案必须包含标题和正文对象');
  const entries = spec.entries.map((entry, i) => ({
    id: designId(entry.id || 'entry-' + (i + 1)),
    title: boundedText(entry.title, 500),
    body: boundedText(entry.body || '', 1600)
  }));
  if (entries.some((e) => !e.title.trim()) || new Set(entries.map((e) => e.id)).size !== entries.length)
    throw canvasError('文案标题不能为空，ID不能重复');
  if (spec.header)
    entries.unshift({
      id: 'header',
      title: boundedText(spec.header.title, 300),
      body: boundedText(spec.header.body || '', 500),
      role: 'header'
    });
  if (spec.footer) entries.push({ id: 'footer', title: boundedText(spec.footer, 500), body: '', role: 'footer' });
  if (entries.reduce((n, e) => n + e.title.length + e.body.length, 0) > 6000)
    throw canvasError('填字全文超过6000字，请拆版，未截字');
  return entries;
}
export function normalizeCanvasDesign(raw) {
  if (raw?.kind !== 'canvas-image-text' || raw.version !== 1) throw canvasError('不是支持的底图填字源稿');
  const image = raw.image;
  if (
    !image ||
    typeof image.path !== 'string' ||
    image.path.length > 300 ||
    /^(?:https?:|data:|blob:)/i.test(image.path) ||
    !/\.(png|jpe?g|webp)$/i.test(image.path) ||
    !/^[a-f0-9]{64}$/.test(image.hash)
  )
    throw canvasError('源稿必须绑定工作区原图和真实摘要');
  for (const key of ['width', 'height']) {
    canvasNumber(image[key], 64, 8192, '原图尺寸');
    canvasNumber(raw[key], 256, 4096, '输出尺寸');
    if (!Number.isInteger(image[key]) || !Number.isInteger(raw[key])) throw canvasError('尺寸必须为原始整数像素');
  }
  if (image.width * image.height > 25e6 || raw.width * raw.height > 16e6) throw canvasError('图片像素超过限额');
  if (Math.abs(raw.width * image.height - raw.height * image.width) > Math.max(image.width, image.height))
    throw canvasError('填字必须保持原图比例，不能裁切或拉伸底图');
  if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > 22) throw canvasError('文案组数无效');
  const entries = raw.entries.map((e, i) => ({
    id: designId(e.id),
    role: ['header', 'footer'].includes(e.role) ? e.role : 'slot',
    title: boundedText(e.title, 500),
    body: boundedText(e.body || '', 1600)
  }));
  if (
    entries.some((e) => !e.title.trim()) ||
    new Set(entries.map((e) => e.id)).size !== entries.length ||
    entries.reduce((n, e) => n + e.title.length + e.body.length, 0) > 6000
  )
    throw canvasError('文案为空、ID重复或全文超过6000字');
  if (
    !Array.isArray(raw.regions) ||
    raw.regions.length > 22 ||
    !Array.isArray(raw.protected || []) ||
    (raw.protected || []).length > 20
  )
    throw canvasError('区域数量无效');
  const regions = raw.regions.map((r, i) => canvasRegion(r, i)),
    protectedAreas = (raw.protected || []).map((r, i) => canvasRegion(r, i, true));
  const slots = entries.filter((e) => e.role === 'slot');
  let slotIndex = 0;
  for (const r of regions)
    if (r.role === 'slot') {
      r.entryId ||= slots[slotIndex]?.id;
      slotIndex++;
    }
  if (
    regions.some((r) => r.role === 'slot' && r.entryId && !slots.some((e) => e.id === r.entryId)) ||
    new Set(regions.filter((r) => r.role === 'slot').map((r) => r.entryId)).size !==
      regions.filter((r) => r.role === 'slot').length
  )
    throw canvasError('卡槽与文案对应关系无效');
  if (new Set(regions.map((r) => r.id)).size !== regions.length) throw canvasError('区域ID不能重复');
  if (regions.filter((r) => r.role === 'header').length > 1 || regions.filter((r) => r.role === 'footer').length > 1)
    throw canvasError('标题区和底注区最多各一个');
  if (
    (raw.fontFamily !== undefined && !['sans', 'serif'].includes(raw.fontFamily)) ||
    (raw.reading !== undefined && !['phone', 'desktop'].includes(raw.reading))
  )
    throw canvasError('字体或阅读模式无效');
  const textColor = raw.textColor === undefined || raw.textColor === null ? null : color(raw.textColor);
  return {
    kind: 'canvas-image-text',
    version: 1,
    title: boundedText(raw.title || entries[0].title, 300),
    image: { ...image },
    width: raw.width,
    height: raw.height,
    entries,
    regions,
    protected: protectedAreas,
    fontFamily: raw.fontFamily === 'serif' ? 'serif' : 'sans',
    reading: raw.reading === 'desktop' ? 'desktop' : 'phone',
    titleSize: canvasNumber(raw.titleSize ?? 14, 14, 40, '标题字号'),
    bodySize: canvasNumber(raw.bodySize ?? 12, 12, 32, '正文字号'),
    textColor,
    detection: {
      method: boundedText(raw.detection?.method || 'manual', 40),
      confidence: canvasNumber(raw.detection?.confidence ?? 1, 0, 1, '定位可信度')
    }
  };
}
