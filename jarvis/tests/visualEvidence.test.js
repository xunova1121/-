import { describe, it, expect } from 'vitest';
import { createVisualEvidence, imageFingerprint, scoreRows } from '../src/agent/visualEvidence.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { createImageSight } from '../src/agent/imageSight.js';
import { runAgent } from '../src/agent/agent.js';

describe('图片执行依据', () => {
  it('同名不同内容使用内容摘要', async () => {
    expect(await imageFingerprint(new Blob(['A']))).not.toBe(await imageFingerprint(new Blob(['B'])));
  });
  it('明确表格行才能关联比分，散落的文字不猜对应', () => {
    expect(scoreRows('青山队\n白云队\n0–1')).toEqual([]);
    expect(scoreRows('| 对阵 | 比分 |\n|---|---|\n| 晨光队 vs 远山队 | 0–1 |')).toEqual([{ match: '晨光队 vs 远山队', score: '0-1' }]);
  });
  it('无成功回执不自称调用，成功也不代表绝对准确', () => {
    const ledger = createVisualEvidence(true);
    expect(ledger.issue('我重新用图片识字工具核对了，明确写着A队0–1')).toBeTruthy();
    expect(ledger.issue('没有调用OCR，无法确认')).toBe('');
    ledger.note({ kind: 'ocr', ok: false });
    expect(ledger.issue('OCR识别结果明确写着A队0–1')).toBeTruthy();
    ledger.note({ kind: 'ocr', ok: true, model: 'fixture' });
    expect(ledger.issue('OCR返回了候选文字，还需核对')).toBe('');
    expect(ledger.issue('OCR识别结果绝对准确')).toBeTruthy();
  });
  it('最新失败不能借旧成功冒充已核对，冲突不能靠改口解决', () => {
    const ledger = createVisualEvidence(true);
    ledger.note({ kind: 'ocr', ok: true, rows: [{ match: '晨光队 vs 远山队', score: '0-1' }] });
    expect(ledger.issue('晨光队 vs 远山队：0–0')).toBeTruthy();
    expect(ledger.issue('OCR写0–1，但原图看不清，无法确认')).toBe('');
    ledger.note({ kind: 'ocr', ok: false });
    expect(ledger.issue('OCR明确确认晨光队0–1')).toBeTruthy();
  });
  it('回执最多12条，不留完整正文或原图', () => {
    const ledger = createVisualEvidence();
    for (let n = 0; n < 25; n++) ledger.note({ kind: 'ocr', ok: true, text: '敏感正文', rows: [] });
    expect(ledger.snapshot()).toHaveLength(12);
    expect(JSON.stringify(ledger.snapshot())).not.toContain('敏感正文');
  });
  it('主循环不先显示虚构OCR草稿，至多修正一次', async () => {
    let calls = 0;
    const shown = [];
    const adapter = { async stream(options) {
      calls++;
      const text = calls === 1 ? '我重新调用识图工具，结果明确是A队0–1。' : '本轮没有OCR成功回执，无法确认哪场0–1。';
      options.onText(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    } };
    const result = await runAgent({ adapter, model: 'fixture', userText: '请用识图工具核对截图哪场0–1', history: [], tools: [], context: { dynamic: '' }, quiet: true, emit: (event) => { if (event.type === 'text') shown.push(event.delta); } });
    expect(calls).toBe(2);
    expect(shown.join('')).not.toContain('明确是A队');
    expect(result.text).toContain('无法确认');
  });
  it('OCR预算不能吞掉，实际成功生成真实回执', async () => {
    const budget = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
    const failed = createImageSight({ model: 'gpt-6-luna', readText: async () => { throw budget; } });
    await expect(failed({ content: '提取文字', images: [{ data: 'QQ==', mime: 'image/png' }] }, { hint: '提取文字', ocr: true })).rejects.toBe(budget);
    const receipts = [];
    const see = createImageSight({ model: 'gpt-6-luna', readText: async () => ({ text: '0–1', model: 'fixture' }), onEvidence: (receipt) => receipts.push(receipt) });
    const message = { content: '提取文字', images: [{ data: 'QQ==', mime: 'image/png' }] };
    await see(message, { hint: '提取文字', ocr: true });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ kind: 'ocr', ok: true });
    expect(message.content).not.toContain('比看图读字准');
    const review = createExecutionReview('截图核对');
    review.noteVisual(receipts[0]);
    expect(review.checkAnswer('OCR返回了候选文字')).toEqual([]);
  });
});
