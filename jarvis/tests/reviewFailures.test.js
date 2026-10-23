import { describe, it, expect } from 'vitest';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';

describe('失败操作的提示（评测 baseline-21：文档交了却提示“部分操作未成功”）', () => {
  it('改文档失败后，同一份文档又生成成功：算已解决', () => {
    const review = createExecutionReview('写一份方案Word');
    review.record({ name: 'edit_office_document', args: { path: 'a/方案.docx' }, ok: false });
    review.record({ name: 'create_document', args: { path: 'a/方案.docx' }, ok: true });
    expect(review.report().failures).toEqual([]);
  });
  it('真没补上的：说清是哪一步没成功', () => {
    const review = createExecutionReview('写一份方案Word');
    review.record({ name: 'create_document', args: { path: 'a/方案.docx' }, ok: true });
    review.record({ name: 'edit_office_document', args: { path: 'a/方案.docx' }, ok: false });
    const { notice } = reviewOutcome(review.report());
    expect(notice).toMatch(/修改文档/);
  });
});
