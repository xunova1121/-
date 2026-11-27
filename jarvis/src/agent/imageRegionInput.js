/** 图片局部参数只做有明确含义的归一化；不猜像素坐标、百分制或无格式的四元数组。 */
const KEYS = ['x', 'y', 'width', 'height', 'w', 'h', 'left', 'top', 'right', 'bottom', 'x1', 'y1', 'x2', 'y2'];
const empty = value => value == null || typeof value === 'string' && !value.trim();
const object = value => value && typeof value === 'object' && !Array.isArray(value);

const invalid = (message, reason = 'invalid_region') => Object.assign(new Error(message), { code: 'IMAGE_REGION', kind: 'input', reason });
const formatHelp = '局部请用0～1比例坐标，例如region:{"x":0,"y":0,"width":0.5,"height":1}；整图只需path和question，省略region与regions';

function parseRegionJson(value) {
  if (typeof value !== 'string' || value.length > 100000 || !/^(?:[\[{]|null$)/.test(value.trim())) return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

function coordinate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 40) {
    const source = value.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source) && Number.isFinite(Number(source))) return Number(source);
  }
  throw invalid('图片坐标必须是完整数字，不接受百分号、像素单位、空值或混合文字；' + formatHelp);
}

function aliasValue(value, names) {
  const values = names.filter(key => !empty(value[key])).map(key => coordinate(value[key]));
  if (values.some(item => item !== values[0])) throw invalid('图片区域同义字段互相冲突，未选择任意一组坐标', 'conflicting_coordinates');
  return values[0];
}

/** null、空对象及纯空占位表示未指定单区域；非空但不完整的ROI不能退化为整图。 */
export function visualRegion(value) {
  value = parseRegionJson(value);
  if (empty(value)) return null;
  if (!object(value) || Object.keys(value).some(key => !KEYS.includes(key))) throw invalid('图片区域需使用有明确字段名的对象，不能猜四元数组的含义；' + formatHelp);
  if (Object.values(value).every(empty)) return null;
  const x = aliasValue(value, ['x', 'left', 'x1']);
  const y = aliasValue(value, ['y', 'top', 'y1']);
  const specifiedWidth = aliasValue(value, ['width', 'w']);
  const specifiedHeight = aliasValue(value, ['height', 'h']);
  const right = aliasValue(value, ['right', 'x2']);
  const bottom = aliasValue(value, ['bottom', 'y2']);
  if (right !== undefined && (right < 0 || right > 1) || bottom !== undefined && (bottom < 0 || bottom > 1))
    throw invalid('图片区域边界必须在0～1范围内，未猜测百分制或像素坐标；' + formatHelp);
  const width = specifiedWidth ?? (right === undefined ? undefined : right - x);
  const height = specifiedHeight ?? (bottom === undefined ? undefined : bottom - y);
  if (right !== undefined && specifiedWidth !== undefined && Math.abs(x + width - right) > 1e-9 || bottom !== undefined && specifiedHeight !== undefined && Math.abs(y + height - bottom) > 1e-9)
    throw invalid('图片区域宽高与边界字段互相冲突，未选择任意一组坐标', 'conflicting_coordinates');
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || width > 1 || height > 1 || x + width > 1.000001 || y + height > 1.000001)
    throw invalid('图片区域必须在0～1范围内且不能越界；' + formatHelp);
  // 仅吸收归一化小数相加的边缘误差；不让裁剪起点落在图像外。
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

/** 空regions仍保留旧输入契约；有明确单区域时才将多区空占位忽略。 */
export function normalizeImageRegions({ region, regions } = {}) {
  const selected = visualRegion(region);
  regions = parseRegionJson(regions);
  if (regions == null) return { region: selected, regions: null };
  if (!Array.isArray(regions) || regions.length > 4) throw invalid('多区域必须1～4个；' + formatHelp, 'invalid_regions');
  if (!regions.length) {
    if (selected) return { region: selected, regions: null };
    throw invalid('regions为空数组，没有指定任何局部；分析整图请删除region与regions，只保留path和question再试一次', 'empty_regions');
  }
  if (selected) throw invalid('非空region与非空regions不能并用，请明确选择单区域或多区域', 'conflicting_regions');
  const normalized = regions.map((value, index) => {
    const item = visualRegion(value);
    if (!item) throw invalid(`regions第${index + 1}项为空，未将无效局部当作整图识别；` + formatHelp, 'empty_region_item');
    return item;
  });
  return { region: null, regions: normalized };
}

const coordinateSchema = { type: ['number', 'string'], minimum: 0, maximum: 1, description: '0～1归一化比例，可使用完整数字字符串；不能用像素数或百分号' };
const coordinateShapes = [
  { required: ['x', 'y', 'width', 'height'] }, { required: ['x', 'y', 'w', 'h'] },
  { required: ['left', 'top', 'right', 'bottom'] }, { required: ['x1', 'y1', 'x2', 'y2'] }
];
export const IMAGE_REGION_SCHEMA = {
  type: ['object', 'null'],
  description: '全图省略或null。局部优先{x,y,width,height}；也支持明确字段名{x,y,w,h}、{left,top,right,bottom}或{x1,y1,x2,y2}。非空时各坐标须完整，不能与非空regions并用。',
  properties: Object.fromEntries(KEYS.map(key => [key, coordinateSchema])),
  anyOf: [...coordinateShapes, { maxProperties: 0 }],
  additionalProperties: false
};
export const IMAGE_REGION_ITEM_SCHEMA = {
  ...IMAGE_REGION_SCHEMA,
  type: 'object',
  description: '必须是一个完整非空局部，不能为null或空对象；各坐标使用0～1比例。',
  anyOf: coordinateShapes
};
