import { it, expect, vi } from 'vitest';
import { followsImage } from '../src/core/imageFollowup.js';
import { visualRegion } from '../src/agent/imageRegion.js';
import { visualFields } from '../src/agent/visualFields.js';
import { createVisualEvidence } from '../src/agent/visualEvidence.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { createInspectImageTool } from '../src/agent/inspectImage.js';
import * as workspace from '../src/agent/workspace.js';
import { withLookupDeadline } from '../src/agent/lookupDeadline.js';

it('纠错继续关联原图，闲聊不带图，图片复核不套联网60秒', async () => {
  const messages = [{ role: 'user', ts: 1, content: '请看看这张图片', images: [{ data: 'QQ==' }] }, { role: 'user', ts: 2, content: 'co那个值再看下' }];
  expect(followsImage('全是错的', messages, new Map([[1, true]]))).toBe(true);
  expect(followsImage('今天吃什么', messages, new Map([[1, true]]))).toBe(false);
  const result = await withLookupDeadline({ userText: 'co那个值再看下', history: messages }, async options => options);
  expect(result.lookupDeadline).toBeUndefined();
});
it('坐标拒绝越界、非数值，保留原始字段前导零和单位', () => {
  expect(() => visualRegion({ x: 0.9, y: 0, width: 0.2, height: 1 })).toThrow();
  expect(() => visualRegion({ x: NaN, y: 0, width: 1, height: 1 })).toThrow();
  expect(visualFields('CO₂：0044 ppm\nHCHO：0.008 mg/m³\n温度：32 ℃')).toEqual([{ label: 'CO2', value: '0044', unit: 'ppm' }, { label: 'HCHO', value: '0.008', unit: 'mg/m³' }, { label: '温度', value: '32', unit: '℃' }]);
});
it('裁剪后交视觉和OCR；冲突不可选一路当真值，快照不留读数', async () => {
  await workspace.write('inspection-original.png', new Blob(['original'], { type: 'image/png' }));
  const cropImage = vi.fn(async () => new Blob(['crop'], { type: 'image/png' }));
  const ocr = vi.fn(async ({ blob }) => { expect(await blob.text()).toBe('crop'); return { text: 'CO2：044 ppm', model: 'fixture' }; });
  const visionLlm = vi.fn(async options => { expect(atob(options.images[0].data)).toBe('crop'); return 'CO2：444 ppm'; });
  const text = await createInspectImageTool({ cropImage, ocr, visionLlm }).run({ path: 'inspection-original.png', question: '重读CO2', region: { x: 0, y: 0, width: 0.5, height: 0.5 } });
  expect(cropImage).toHaveBeenCalledTimes(1);
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(visionLlm).toHaveBeenCalledTimes(1);
  const review = createExecutionReview('用OCR核对');
  review.record({ name: 'inspect_image', ok: true, output: text });
  expect(review.checkAnswer('CO2：444 ppm')).not.toEqual([]);
  expect(review.checkAnswer('两路读数存在冲突，不能确认')).toEqual([]);
  expect(JSON.stringify(review.report().visualReceipts)).not.toContain('444');
});
it('裁剪缺失明确说明，不冒充局部OCR；停止和预算上抛', async () => {
  await workspace.write('inspection-fallback.png', new Blob(['original'], { type: 'image/png' }));
  const ocr = vi.fn();
  const tool = createInspectImageTool({ cropImage: async () => { throw Object.assign(new Error('missing'), { code: 'IMAGE_CROP_UNAVAILABLE' }); }, ocr, visionLlm: async () => '看不清' });
  const text = await tool.run({ path: 'inspection-fallback.png', question: '读数', region: { x: 0, y: 0, width: 1, height: 0.5 } });
  expect(text).toContain('不算完成局部放大');
  expect(ocr).not.toHaveBeenCalled();
  const review = createExecutionReview('识图');
  review.noteVisual({ kind: 'ocr', ok: true });
  review.record({ name: 'inspect_image', ok: true, output: text });
  expect(review.checkAnswer('OCR识别结果为044')).not.toEqual([]);
  for (const error of [new DOMException('stop', 'AbortError'), Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' })]) {
    const failed = createInspectImageTool({ visionLlm: async () => { throw error; } });
    await expect(failed.run({ path: 'inspection-fallback.png', question: '读数' })).rejects.toBe(error);
  }
});
it('否认旧调用不能掩盖虚构新调用，不补零改数', () => {
  const review = createVisualEvidence(true);
  expect(review.issue('刚才没有调用OCR，现在OCR识别结果为044')).toBeTruthy();
  review.note({ kind: 'ocr', ok: true, fields: [{ label: 'CO2', value: '044', unit: 'ppm' }] });
  expect(review.issue('CO2：444 ppm')).toBeTruthy();
  expect(review.issue('OCR候选是044，但看不清，不能确认')).toBe('');
  expect(review.snapshot()[0]).not.toHaveProperty('fields');
});
it('视觉暂不可用时仍尝试已配置OCR，不靠重复问同一模型空转', async () => {
  await workspace.write('inspection-degrade.png', new Blob(['original'], { type: 'image/png' }));
  const tool = createInspectImageTool({ visionLlm: async () => { throw Object.assign(new Error('offline'), { kind: 'network' }); }, ocr: async () => ({ text: 'CO2：0044 ppm', model: 'fixture' }) });
  const text = await tool.run({ path: 'inspection-degrade.png', question: '读数' });
  expect(text).toContain('视觉模型读取失败');
  expect(text).toContain('0044');
});
