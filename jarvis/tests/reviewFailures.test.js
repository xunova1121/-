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

it('补充读回保留未修改文件的实测样式；编辑后不会沿用旧验收', () => {
 const review = createExecutionReview('Word不要横线');
 review.record({name:'write_file',args:{path:'a.docx'},ok:true});
 review.artifact({path:'a.docx',validation:{format:'docx',readback:'passed',structure:'passed',styleFacts:{rules:0,underlines:0},errors:0}},1);
 review.record({name:'read_file',args:{path:'a.docx'},ok:true});
 expect(review.report().artifacts[0].styleFacts.rules).toBe(0);
 review.record({name:'edit_file',args:{path:'a.docx'},ok:true});
 review.record({name:'read_file',args:{path:'a.docx'},ok:true});
 expect(review.report().artifacts[0].styleFacts).toBeUndefined();
});
