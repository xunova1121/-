import { describe, it, expect } from 'vitest';
import { mediaReceipt, imageDeliveryAnswerIssues } from '../src/agent/actionDelivery.js';
import { createExecutionReview } from '../src/agent/executionReview.js';

const receipt = overrides => JSON.stringify({ kind: 'image', status: 'saved', path: 'images/风景.png', model: 'image-fixture', requested: { size: '3840x2160', quality: 'high', output_format: 'png' }, actual: { width: 1536, height: 1024, format: 'png', dimensions: 'verified' }, sizeMatch: false, formatMatch: true, readback: 'passed', visual: 'not_checked', notes: [], ...overrides });

describe('图片原字节JSON交付回执', () => {
  it('只按真实文件保存和读回记完成，保留实际尺寸不拿请求值填充', () => {
    expect(mediaReceipt('generate_image', true, receipt())).toMatchObject({ state: 'completed', files: ['images/风景.png'], actual: { width: 1536, height: 1024 }, requested: { size: '3840x2160' }, sizeMatch: false, formatMatch: true, visual: 'not_checked' });
    for (const overrides of [{ kind: 'video' }, { status: 'generated' }, { path: null }, { path: 'images/风景.html' }, { readback: 'generated' }, { readback: 'not_checked' }]) {
      expect(mediaReceipt('generate_image', true, receipt(overrides)).state).toBe('pending');
    }
    expect(mediaReceipt('generate_image', false, receipt())).toMatchObject({ state: 'failed', files: [] });
    expect(mediaReceipt('generate_image', true, receipt({ actual: { dimensions: 'unknown' }, sizeMatch: null })).actual).not.toHaveProperty('width');
    expect(mediaReceipt('generate_image', true, '已生成图片，保存在 images/old.png。')).toMatchObject({ state: 'completed', files: ['images/old.png'] });
  });

  it('尺寸不符不能宣称4K达标，原文件仍可交付且不要求自动重生成', () => {
    const review = createExecutionReview('生成一张4K图片');
    review.record({ name: 'generate_image', ok: true, output: receipt() });
    expect(review.report().media.state).toBe('completed');
    expect(review.guardsAnswer()).toBe(true);
    expect(review.checkAnswer('图片已生成，分辨率已满足要求，已达到原生4K。')).toHaveLength(1);
    expect(review.checkAnswer('已生成3840×2160图片。')).toHaveLength(1);
    expect(review.checkAnswer('图片已保存，实际1536×1024，未达到请求尺寸。')).toEqual([]);
    expect(review.checkAnswer('请求尺寸3840×2160，实际尺寸1536×1024。')).toEqual([]);
    expect(review.guidance()).not.toContain('应实际调用');
    expect(imageDeliveryAnswerIssues('已满足请求格式。', mediaReceipt('generate_image', true, receipt({ formatMatch: false })))).toHaveLength(1);
    expect(imageDeliveryAnswerIssues('已达到原生4K。', mediaReceipt('generate_image', true, receipt({ actual: { dimensions: 'unknown' }, sizeMatch: null })))).toHaveLength(1);
  });

  it.each(['auto', null])('请求尺寸为%s时仍以实际像素拦截错误分辨率和4K声明', size => {
    const review = createExecutionReview('生成一张4K图片');
    review.record({ name: 'generate_image', ok: true, output: receipt({ requested: { size }, sizeMatch: null }) });
    expect(review.report().media.state).toBe('completed');
    expect(review.guardsAnswer()).toBe(true);
    for (const answer of ['已生成3840×2160图片。', '这张图是3840x2160。', '已经是4K图片。', '已达到原生4K。']) expect(review.checkAnswer(answer), answer).toHaveLength(1);
    for (const answer of ['已保存图片，实际尺寸1536×1024。', '请求4K，实际1536×1024，未达到4K。', '这张不是4K图片。', '没有达到4K，原图已保留。', '还不到4K。', '如需4K，可以放大到3840×2160，但这不代表原生4K细节。', '模型名带4k-upscale，实际1536×1024。']) expect(review.checkAnswer(answer), answer).toEqual([]);
    expect(review.guidance()).not.toContain('应实际调用');
  });

  it('实际4K可报告输出尺寸，但像素元数据不能证明原生细节，未知尺寸不能填造', () => {
    const actual = { width: 3840, height: 2160, format: 'png', dimensions: 'verified' };
    const known = mediaReceipt('generate_image', true, receipt({ actual, requested: { size: 'auto' }, sizeMatch: null }));
    expect(imageDeliveryAnswerIssues('已生成4K图片，实际3840×2160。', known)).toEqual([]);
    expect(imageDeliveryAnswerIssues('输出3840×2160，不代表原生4K细节。', known)).toEqual([]);
    expect(imageDeliveryAnswerIssues('底图是原生4K。', known)).toHaveLength(1);
    const unknown = mediaReceipt('generate_image', true, receipt({ actual: { dimensions: 'unknown' }, sizeMatch: null }));
    expect(imageDeliveryAnswerIssues('已输出3840×2160。', unknown)).toHaveLength(1);
    expect(imageDeliveryAnswerIssues('实际像素尚未核实，不能确认4K。', unknown)).toEqual([]);
  });
});
