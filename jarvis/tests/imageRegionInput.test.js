import { it, expect, vi } from 'vitest';
import { normalizeImageRegions, visualRegion } from '../src/agent/imageRegionInput.js';
import { createInspectImageTool } from '../src/agent/inspectImage.js';
import { normalizeToolFormats } from '../src/agent/toolInputFormats.js';
import * as workspace from '../src/agent/workspace.js';

const half = { x: 0, y: 0, width: 0.5, height: 1 };
const whole = { region: null, regions: null };

it('未指定区域、null和纯空单区占位均明确表示整图', () => {
  for (const region of [undefined, null, {}, '', '  ', { x: null, y: '', width: undefined, height: ' ' }]) {
    expect(normalizeImageRegions({ region })).toEqual(whole);
    expect(normalizeImageRegions({ region, regions: null })).toEqual(whole);
  }
  expect(normalizeImageRegions()).toEqual(whole);
});

it('完整数字字符串和明确具名的坐标格式归一为同一组数字', () => {
  for (const value of [
    { x: '0', y: ' 0 ', width: '.5', height: '1e0' },
    { x: 0, y: 0, w: 0.5, h: 1 },
    { left: '0', top: '0', right: '0.5', bottom: '1' },
    { x1: 0, y1: 0, x2: 0.5, y2: 1 },
    { ...half, left: '0', w: '.5', right: 0.5 }
  ]) expect(visualRegion(value)).toEqual(half);
  expect(visualRegion({ left: 0.25, top: 0.25, right: 0.75, bottom: 1 })).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.75 });
  expect(visualRegion({ x: 0.8, y: 0, width: 0.20000000000000004, height: 1 }).width).toBe(1 - 0.8);
});

it('保留旧JSON对象和数组字符串入口，不因nullable schema失去格式归一能力', () => {
  const tool = createInspectImageTool({});
  const single = normalizeToolFormats(tool, { region: JSON.stringify({ x: '0', y: '0', w: '.5', h: '1' }), regions: 'null' });
  expect(normalizeImageRegions(single)).toEqual({ region: half, regions: null });
  const multiple = normalizeToolFormats(tool, { region: '{}', regions: JSON.stringify([half]) });
  expect(normalizeImageRegions(multiple)).toEqual({ region: null, regions: [half] });
  expect(() => visualRegion('{"x":0')).toThrow(expect.objectContaining({ code: 'IMAGE_REGION' }));
  expect(() => normalizeImageRegions({ regions: '[{"x":0' })).toThrow(expect.objectContaining({ code: 'IMAGE_REGION' }));
});

it('空多区仍拒绝并提供整图最小纠正参数；仅有效单区可吸收多区空占位', () => {
  for (const input of [{ regions: [] }, { region: null, regions: [] }, { region: {}, regions: '[]' }]) {
    expect(() => normalizeImageRegions(input)).toThrow(expect.objectContaining({ code: 'IMAGE_REGION', kind: 'input', reason: 'empty_regions' }));
    expect(() => normalizeImageRegions(input)).toThrow(/删除region与regions，只保留path和question/);
  }
  expect(normalizeImageRegions({ region: half, regions: [] })).toEqual({ region: half, regions: null });
  expect(normalizeImageRegions({ region: {}, regions: [half] })).toEqual({ region: null, regions: [half] });
});

it('不猜像素、百分制、四元数组或不完整非空区域', () => {
  for (const region of [
    [], [0, 0, 0.5, 1], { x: 0, y: 0, width: 50, height: 100 },
    { left: 0, top: 0, right: 1080, bottom: 1440 },
    { ...half, width: '50%' }, { ...half, width: '540px' }, { ...half, width: '0.5abc' },
    { ...half, width: true }, { ...half, width: NaN }, { ...half, width: Infinity },
    { ...half, width: '' }, { x: 0 }, { x: 0, y: 0, width: 0, height: 1 },
    { ...half, x: -0.1 }, { ...half, x: 0.6 }, { ...half, label: '左侧' },
    { left: 0.5, top: 0, right: 0.25, bottom: 1 }
  ]) expect(() => visualRegion(region)).toThrow(expect.objectContaining({ code: 'IMAGE_REGION', kind: 'input' }));
});

it('同义坐标或单区多区非空冲突必须拒绝，不能任取一组', () => {
  for (const region of [{ ...half, left: 0.1 }, { ...half, w: 0.6 }, { ...half, right: 0.75 }, { ...half, bottom: 0.5 }])
    expect(() => visualRegion(region)).toThrow(expect.objectContaining({ reason: 'conflicting_coordinates' }));
  expect(() => normalizeImageRegions({ region: half, regions: [half] })).toThrow(expect.objectContaining({ reason: 'conflicting_regions' }));
  expect(() => normalizeImageRegions({ region: { x: 0 }, regions: [half] })).toThrow(expect.objectContaining({ code: 'IMAGE_REGION' }));
});

it('多区保留1到4区契约且不丢弃空项或非法项', () => {
  expect(normalizeImageRegions({ regions: Array(4).fill(half) }).regions).toHaveLength(4);
  for (const regions of [{}, '', 'all', Array(5).fill(half), [null], [{}], [half, null], [half, { x: 2, y: 0, width: 1, height: 1 }]])
    expect(() => normalizeImageRegions({ regions })).toThrow(expect.objectContaining({ code: 'IMAGE_REGION', kind: 'input' }));
  const schema = createInspectImageTool({}).input_schema.properties;
  expect(schema.regions.minItems).toBe(1);
  expect(schema.regions.items.type).toBe('object');
  expect(schema.regions.items.anyOf.every(shape => shape.required?.length === 4)).toBe(true);
  expect(schema.region.description).toContain('全图省略或null');
});

it('整图空占位实际读取原字节，不调用裁剪且不声称局部已验收', async () => {
  const path = 'region-normalization-full.png';
  await workspace.write(path, new Blob(['original bytes'], { type: 'image/png' }));
  const cropImage = vi.fn();
  const visionLlm = vi.fn(async options => {
    expect(options.images.map(image => atob(image.data))).toEqual(['original bytes']);
    expect(options.prompt).not.toContain('仅关注归一化区域');
    return '画面中的文字不清晰';
  });
  const ocr = vi.fn(async ({ blob }) => { expect(await blob.text()).toBe('original bytes'); return { text: '看不清', model: 'fixture' }; });
  const output = await createInspectImageTool({ cropImage, visionLlm, ocr }).run({ path, question: '分析这个图', region: {}, regions: null });
  expect(cropImage).not.toHaveBeenCalled();
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(output).toContain('"cropped":false');
  expect(output).toContain('"regionCount":0');
  expect(output).not.toContain('已裁剪放大');
});

it('单区数字字符串在调用裁剪前变为实际数字，视觉和OCR只用裁剪字节', async () => {
  const path = 'region-normalization-single.png';
  await workspace.write(path, new Blob(['original bytes'], { type: 'image/png' }));
  const cropImage = vi.fn(async (blob, region) => {
    expect(await blob.text()).toBe('original bytes');
    expect(region).toEqual(half);
    return new Blob(['crop bytes'], { type: 'image/png' });
  });
  const visionLlm = vi.fn(async options => { expect(atob(options.images[0].data)).toBe('crop bytes'); return '局部文字不清晰'; });
  const ocr = vi.fn(async ({ blob }) => { expect(await blob.text()).toBe('crop bytes'); return { text: '看不清', model: 'fixture' }; });
  const output = await createInspectImageTool({ cropImage, visionLlm, ocr }).run({ path, question: '分析左侧', region: { x: '0', y: '0', width: '.5', height: '1' }, regions: [] });
  expect(cropImage).toHaveBeenCalledTimes(1);
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(output).toContain('"cropped":true');
});

it('多区空单区占位和具名边界实际归一，OCR仍明确来自整图', async () => {
  const path = 'region-normalization-multiple.png';
  await workspace.write(path, new Blob(['original bytes'], { type: 'image/png' }));
  const cropImage = vi.fn(async (blob, region) => {
    expect(await blob.text()).toBe('original bytes');
    expect(Object.values(region).every(value => typeof value === 'number')).toBe(true);
    return new Blob([String(region.x)], { type: 'image/png' });
  });
  const visionLlm = vi.fn(async options => { expect(options.images.map(image => atob(image.data))).toEqual(['original bytes', '0', '0.5']); return '两个局部文字均不清晰'; });
  const ocr = vi.fn(async ({ blob }) => { expect(await blob.text()).toBe('original bytes'); return { text: '看不清', model: 'fixture' }; });
  const output = await createInspectImageTool({ cropImage, visionLlm, ocr }).run({
    path, question: '从左到右看两列', region: { x: null, y: null, width: null, height: null },
    regions: [{ left: '0', top: '0', right: '.5', bottom: '1' }, { x1: '.5', y1: '0', x2: '1', y2: '1' }]
  });
  expect(cropImage).toHaveBeenNthCalledWith(1, expect.any(Blob), half, { signal: undefined });
  expect(cropImage).toHaveBeenNthCalledWith(2, expect.any(Blob), { ...half, x: 0.5 }, { signal: undefined });
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(output).toContain('"regionCount":2');
  expect(output).toContain('OCR候选来自整图');
});

it('非法或冲突区域在读取文件和调用模型前拒绝，不能冒充整图已读取', async () => {
  const read = vi.spyOn(workspace, 'readBlob');
  const cropImage = vi.fn(), visionLlm = vi.fn(), ocr = vi.fn();
  try {
    const tool = createInspectImageTool({ cropImage, visionLlm, ocr });
    for (const params of [{ regions: [] }, { region: { x: 0 } }, { region: half, regions: [half] }, { regions: [half, {}] }, { region: { ...half, width: '50%' } }])
      await expect(tool.run({ path: 'never-read.png', question: '分析这个图', ...params })).rejects.toMatchObject({ code: 'IMAGE_REGION', kind: 'input' });
    expect(read).not.toHaveBeenCalled();
    expect(cropImage).not.toHaveBeenCalled();
    expect(visionLlm).not.toHaveBeenCalled();
    expect(ocr).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});
