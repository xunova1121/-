/** 改动核对：用户说“字大点 / 不要横线”，回答只能说文件里真的发生了的（用户 2026-10-29 招租广告反馈） */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { styleRequests, measureDocx, styleReport, styleIssues, styleNote, rememberStyle } from '../src/agent/styleCheck.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { makeDocx } from '../src/agent/docxWriter.js';
import { THEMES } from '../src/agent/themes.js';

const ids = (text) => styleRequests(text).map((r) => r.id);

async function docx({ body = 24, title = 48, rule = false, underline = false } = {}) {
  const zip = new JSZip();
  zip.file('word/styles.xml', `<w:styles><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="${body}"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="${title}"/></w:rPr></w:style></w:styles>`);
  const border = rule ? '<w:pBdr><w:bottom w:val="single" w:sz="12"/></w:pBdr>' : '';
  zip.file('word/document.xml', `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/>${border}</w:pPr><w:r><w:t>王家园门面房出租</w:t></w:r></w:p><w:p><w:r>${underline ? '<w:rPr><w:u w:val="single"/></w:rPr>' : ''}<w:t>现有门面房对外出租，欢迎有租赁需求的朋友咨询。房屋面积：120平方米</w:t></w:r></w:p></w:body></w:document>`);
  return new Blob([await zip.generateAsync({ type: 'uint8array' })]);
}

describe('认出用户要的调整', () => {
  it('用户的原话都认得', () => {
    expect(ids('字体大点，铺满一页纸，不要下划线')).toEqual(['bigger', 'fill', 'noUnderline']);
    expect(ids('内容字体太少，排下版，标题下面不要横线')).toEqual(['noRule']);
    expect(ids('内筒字体还是小')).toEqual(['bigger']);
    expect(ids('做一页word，铺板整页面')).toEqual(['fill']);
    expect(ids('字号调小一点')).toEqual(['smaller']);
  });
  it('普通请求不误认', () => {
    expect(ids('帮我写一份项目方案')).toEqual([]);
    expect(ids('今天大盘怎么样')).toEqual([]);
  });
});

describe('量 Word 实际字号和线条', () => {
  it('正文按字数最多的字号，标题取最大，线条和下划线如实计数', async () => {
    expect(await measureDocx(await docx())).toEqual({ format: 'docx', body: 12, title: 24, rules: 0, underlines: 0 });
    const f = await measureDocx(await docx({ rule: true, underline: true }));
    expect(f.rules).toBe(1);
    expect(f.underlines).toBe(1);
  });
  it('读不了的文件返回 null，不当成做到了', async () => {
    expect(await measureDocx(new Blob(['不是 Word']))).toBeNull();
  });
  it('现在的生成器给一般文档标题下加装饰横线：量得出来', async () => {
    const { blob } = await makeDocx({ title: '王家园门面房出租', content: '现有门面房对外出租。\n\n房屋面积：120平方米', theme: THEMES.business });
    const f = await measureDocx(blob);
    expect(f.rules).toBeGreaterThan(0);
    expect(f.body).toBeGreaterThan(0);
  });
});

describe('回答对不上文件就要改写', () => {
  const art = (facts, previous) => ({ format: 'docx', styleFacts: facts, previousStyle: previous, pages: 1 });
  it('字号没变却说“已加大”：要改写，并写清从多少磅没变', () => {
    const a = art({ body: 12, title: 24, rules: 0, underlines: 0 }, { body: 12, title: 24 });
    const issues = styleIssues('内筒字体还是小', '已调整成大字一页版，内文字体也加大了。', a);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('正文从12磅没变');
  });
  it('真的变大了就不拦', () => {
    const a = art({ body: 28, title: 60, rules: 0, underlines: 0 }, { body: 12, title: 24 });
    expect(styleReport('字体大点', a)[0].state).toBe('done');
    expect(styleIssues('字体大点', '正文从12磅加大到28磅。', a)).toEqual([]);
  });
  it('还有横线却说“标题下没有横线”：要改写', () => {
    const a = art({ body: 12, title: 24, rules: 1, underlines: 0 }, null);
    expect(styleIssues('标题下面不要横线', '已重新排版，标题下没有横线。', a)[0]).toContain('还有1条横线');
  });
  it('照实说没做到的，不拦', () => {
    const a = art({ body: 12, title: 24, rules: 0, underlines: 0 }, { body: 12, title: 24 });
    expect(styleIssues('字体大点', '字号这次没能加大：这个工具调不了字号，请告诉我具体字号。', a)).toEqual([]);
  });
  it('文件名里的“大字版”不算声称', () => {
    const a = art({ body: 12, title: 24, rules: 0, underlines: 0 }, { body: 12, title: 24 });
    expect(styleIssues('字体大点', '文件在这：[下载《招租广告_大字版.docx》](招租广告_大字版.docx)，正文仍是12磅。', a)).toEqual([]);
  });
  it('没有上一版可比、说“铺满”：都算没法确认，要写实际字号', () => {
    const a = art({ body: 12, title: 24, rules: 0, underlines: 0 }, null);
    expect(styleReport('字体大点，铺满一页', a).map((r) => r.state)).toEqual(['unchecked', 'unchecked']);
    expect(styleNote('字体大点', a)).toContain('标题24磅、正文12磅');
  });
  it('PPT / Excel 读不出字号：说“已加大”也要改写', () => {
    expect(styleIssues('PPT字体大点', '已把字号调大。', { format: 'pptx', styleFacts: undefined })).toHaveLength(1);
  });
});

describe('按对话记住上一版', () => {
  it('新一轮拿到上一轮的量值；同一轮里再生成，基准不变', async () => {
    const one = { body: 12, title: 24 }, two = { body: 12, title: 24 }, three = { body: 28, title: 60 };
    expect(await rememberStyle({ sessionId: 's-style', scope: 't1', facts: one })).toBeNull();
    expect(await rememberStyle({ sessionId: 's-style', scope: 't2', facts: two })).toEqual(one);
    expect(await rememberStyle({ sessionId: 's-style', scope: 't2', facts: three })).toEqual(one);
    expect(await rememberStyle({ sessionId: 's-style', scope: 't3', facts: three })).toEqual(three);
  });
});

describe('接进收尾核对', () => {
  it('有调整要求又生成了 Word：拦住回答、给出实际量值；改写后仍不对就在末尾补实际情况', () => {
    const review = createExecutionReview('内筒字体还是小');
    expect(review.guardsAnswer()).toBe(false);
    review.artifact({ path: 'a.docx', validation: { format: 'docx', readback: 'passed', styleFacts: { body: 12, title: 24, rules: 0, underlines: 0 } }, previousStyle: { body: 12, title: 24 } });
    expect(review.guardsAnswer()).toBe(true);
    expect(review.guidance()).toContain('字体加大：没做到（正文从12磅没变）');
    expect(review.checkAnswer('内文字体也加大了。', Date.now()).join('')).toContain('没做到');
    expect(review.report().answerIssues).toEqual([]);
    expect(review.styleCorrection()).toBe('（读回文件核对：字体加大：没做到（正文从12磅没变）。）');
  });
  it('渲染后的第二次回执沿用第一次的基准', () => {
    const review = createExecutionReview('字体大点');
    const facts = { body: 28, title: 60, rules: 0, underlines: 0 };
    review.artifact({ path: 'a.docx', validation: { format: 'docx', styleFacts: facts }, previousStyle: { body: 12, title: 24 } });
    review.artifact({ path: 'a.docx', validation: { format: 'docx', styleFacts: facts } });
    expect(review.guidance()).toContain('做到了');
  });
});
