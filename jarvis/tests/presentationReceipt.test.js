import { describe, it, expect } from 'vitest';
import PptxGenJS from 'pptxgenjs';
import { inspectPresentation, presentationAnswerIssues } from '../src/agent/presentationReceipt.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { documentLinePreferences, stripDocumentLines } from '../src/agent/documentLineRules.js';
import { generate } from '../src/agent/docs.js';
import { measureDocx } from '../src/agent/styleCheck.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
const png = 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
describe('真实交付核对', () => {
  it('10页4页有图，图标不冒充配图', async () => {
    const ppt = new PptxGenJS(); ppt.layout = 'LAYOUT_WIDE';
    for (let i = 0; i < 10; i++) {
      const slide = ppt.addSlide(); slide.addText('标题', {x:1,y:1,w:3,h:1});
      if ([1,2,8,9].includes(i)) slide.addImage({data:png,x:7,y:2,w:4,h:3,objectName:'wy-content'});
      else slide.addImage({data:png,x:1,y:2,w:0.3,h:0.3,objectName:'wy-icon'});
    }
    const zip = await openOfficePackage(await ppt.write({outputType:'arraybuffer'}));
    const report = await inspectPresentation(zip);
    expect(report.imagePages).toBe(4);
    expect(report.missingImagePages).toEqual([1,4,5,6,7,8]);
    expect(report.pages[0]).toMatchObject({pictures:1,icons:1,contentImages:0,textBoxes:1});
    expect(report.pages[0].estimatedBlankRatio).toBeGreaterThan(0.5);
    const review = createExecutionReview('PPT每页都要图片');
    review.artifact({path:'test.pptx',validation:{format:'pptx',presentation:report}});
    expect(review.guardsAnswer()).toBe(true);
    expect(review.checkAnswer('9页已配图').join('')).toContain('实际仅4页');
    expect(presentationAnswerIssues('', '4页已配图，其他页未完成', {format:'pptx',presentation:report})).toEqual([]);
  });
  it('没有回执或文件已改不能沿用旧数字', () => {
    expect(presentationAnswerIssues('', '9页已配图', {format:'pptx'})).toHaveLength(1);
    expect(presentationAnswerIssues('', '每页都已经有图', {format:'pptx',stale:true})).toHaveLength(1);
  });
  it('历史Word偏好不被PPT偏好覆盖，本轮可显式恢复', async () => {
    const ctx = { documentStylePreferences: async () => '- pptx · 保留横线\n- docx · 不要横线，不要下划线' };
    expect(await documentLinePreferences(ctx,'整理Word')).toEqual({noRules:true,noUnderline:true});
    expect(await documentLinePreferences(ctx,'这次保留横线')).toEqual({noRules:false,noUnderline:true});
  });
  it('去线不删正文、表格和链接关系', async () => {
    const out = await generate('docx',{content:'# 标题\n\n正文[链接](https://example.com)\n\n---\n\n| A | B |\n|--|--|\n| 甲 | 乙 |'});
    const before = await openOfficePackage(out.blob);
    const clean = await stripDocumentLines(out.blob,{noRules:true,noUnderline:true});
    const after = await openOfficePackage(clean);
    expect(await measureDocx(clean)).toMatchObject({rules:0,underlines:0});
    expect(await after.file('word/_rels/document.xml.rels').async('string')).toBe(await before.file('word/_rels/document.xml.rels').async('string'));
    expect(await after.file('word/document.xml').async('string')).toContain('<w:tbl>');
  });
});
