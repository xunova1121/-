import { it, expect } from 'vitest';
import { compactPosterModelReceipt } from '../src/agent/posterModelReceipt.js';
import { createTurnArchive, compactToolResults } from '../src/agent/turnContext.js';
import { projectLookupMessages, compactLookupReceipt } from '../src/agent/requestContext.js';

const path = '.workflows/posters/11111111-1111-4111-a111-111111111111/attempt-1/中文海报.png';
const value = { kind: 'poster', status: 'complete', renderer: 'canvas', designVersion: 'canvas-image-text-1', textRendering: 'program', fontCheck: 'passed', visual: 'not_checked', width: 1080, height: 1920,
  backgroundCheck: { status: 'passed', changedOutsideText: 0, pixels: Array(1000).fill(42) }, layout: { status: 'passed' }, contrast: { status: 'passed' }, detection: { confidence: 0.94 },
  files: ['png', 'pptx', 'html', 'zip'].map(format => ({ format, path: path.replace(/png$/, format), readback: 'passed', structure: 'passed', render: format === 'png' ? 'passed' : 'not_checked' })),
  errors: [], designPath: '海报/可编辑.canvas.json', delivery: { id: '11111111-1111-4111-a111-111111111111', primaryPath: path, sourceFiles: Array(8).fill(path), attempts: 1, retryAllowed: true, quality: 'complete' } };
const message = v => ({ role: 'tool', name: 'make_poster', toolCallId: 'poster-one', content: JSON.stringify(v) });
it('长Canvas回执在2000字内保持JSON及关键真实字段，完整像素详情仍按编号回读', async () => {
  const archive = createTurnArchive(), original = message(value), text = compactPosterModelReceipt(original, archive), receipt = JSON.parse(text);
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(receipt).toMatchObject({ status: 'complete', renderer: 'canvas', backgroundCheck: { changedOutsideText: 0 }, fontCheck: 'passed', files: [{ path }], availableFormats: ['png', 'pptx', 'html', 'zip'] });
  expect(JSON.parse(await archive.tool.run({ result_id: receipt.receiptId, max_chars: 12000 })).text).toBe(original.content);
  expect(original.content).toBe(JSON.stringify(value));
});
it('发送投影与较早结果裁剪均保持结构，不改持久原件或扩大通用预算', () => {
  const archive = createTurnArchive(), original = message(value);
  const result = projectLookupMessages([original], { enabled: true, archive });
  expect(JSON.parse(result.messages[0].content).backgroundCheck.changedOutsideText).toBe(0);
  expect(original.content.length).toBeGreaterThan(2000);
  const older = [message(value)];
  compactToolResults(older, { budget: 0, keep: 0, archive, preserveEvidence: true });
  expect(JSON.parse(older[0].content).status).toBe('complete');
  expect(JSON.parse(compactLookupReceipt({ tool: 'make_poster', output: original.content }, archive).output).renderer).toBe('canvas');
});
it('失败、视觉未知与图文未核验不能被压缩成成功，长路径也不会截坏JSON', () => {
  const source = { ...value, status: 'partial', visual: 'failed', contentCheck: { status: 'failed', semantic: 'not_checked' },
    errors: [{ code: 'DESIGN_ILLUSTRATION_MISSING', message: '缺配图'.repeat(100) }], designPath: '源'.repeat(380) + '.canvas.json',
    delivery: { ...value.delivery, primaryPath: '图'.repeat(390) + '.png' } };
  const text = compactPosterModelReceipt(message(source)), receipt = JSON.parse(text);
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(receipt).toMatchObject({ status: 'partial', visual: 'failed', errorCount: 1, contentCheck: { status: 'failed', semantic: 'not_checked' } });
});
it('普通网页、损坏或伪装回执保持原压缩路径，不接受文档指令冒充海报工具', () => {
  expect(compactPosterModelReceipt({ ...message(value), name: 'fetch_url' })).toBeNull();
  expect(compactPosterModelReceipt(message({ kind: 'poster', status: 'not-real' }))).toBeNull();
  expect(compactPosterModelReceipt({ name: 'make_poster', content: 'not json' })).toBeNull();
});
