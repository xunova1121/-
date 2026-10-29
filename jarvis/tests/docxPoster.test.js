/** 单页告示 + “字大点 / 小点 / 不要横线”真的生效（用户 2026-10-29 招租广告反馈） */
import { describe, it, expect } from 'vitest';
import { generate } from '../src/agent/docs.js';
import { chooseDesign } from '../src/agent/documentDesign.js';
import { posterLayout, posterLines } from '../src/agent/docxPoster.js';
import { measureDocx, relativeTypography, styleRequests } from '../src/agent/styleCheck.js';

// 电话用假号码，不写用户的真实信息
const AD = `# 王家园门面房出租

现有门面房对外出租，欢迎有租赁需求的朋友咨询。

房屋面积：120平方米
租赁价格：面议
联系电话：13800000000

有意者欢迎来电联系，具体租赁事宜可电话沟通。`;

describe('哪些算单页告示', () => {
  it('招租、招聘、寻物启事、海报：短内容自动用单页告示', () => {
    for (const title of ['王家园门面房招租广告', '招聘启事', '寻物启事', '开业海报'])
      expect(chooseDesign({ format: 'docx', title, content: AD }).kind).toBe('poster');
  });
  it('招聘方案、长文档不算', () => {
    expect(chooseDesign({ format: 'docx', title: '2026年招聘方案', content: AD }).kind).toBe('proposal');
    expect(chooseDesign({ format: 'docx', title: '招租说明', content: '很长的正文。'.repeat(120) }).kind).not.toBe('poster');
    expect(chooseDesign({ format: 'docx', title: '工作报告', content: AD }).kind).toBe('report');
  });
});

describe('单页告示排出来', () => {
  it('大字、一页、没有横线和下划线、名目加粗', async () => {
    const r = await generate('docx', { title: '王家园门面房招租广告', content: AD, kind: 'poster' });
    const f = await measureDocx(r.blob);
    expect(f.title).toBeGreaterThanOrEqual(48);
    expect(f.body).toBeGreaterThanOrEqual(28);
    expect(f.body).toBeLessThan(f.title);
    expect(f.rules).toBe(0);
    expect(f.underlines).toBe(0);
    expect(r.info.poster).toEqual({ titleSize: f.title, bodySize: f.body });
  });
  it('估算的高度放得进一页（留余量），内容越多字越小', () => {
    const short = posterLayout(posterLines(AD));
    const long = posterLayout(posterLines(AD + '\n\n' + '交通便利，周边小区多，适合餐饮、超市、药店等多种经营。'.repeat(4)));
    expect(long.body).toBeLessThan(short.body);
    expect(short.top).toBeGreaterThan(0);
  });
  it('用户说了具体字号就用用户的', async () => {
    const r = await generate('docx', { title: '招租', content: AD, kind: 'poster', typography: { body: { size: 26 }, title: { size: 42 } } });
    expect(await measureDocx(r.blob)).toMatchObject({ body: 26, title: 42 });
  });
  it('“小点”在自动字号上缩一档', () => {
    const base = posterLayout(posterLines(AD));
    expect(posterLayout(posterLines(AD), { scale: 0.85 }).body).toBeLessThan(base.body);
  });
});

describe('“字大点 / 小点”换算成真实字号', () => {
  const asks = (t) => styleRequests(t);
  it('在上一版实际字号上放大一档；没有上一版按默认字号放大', () => {
    expect(relativeTypography({}, asks('字体大点'), { previous: { body: 12, title: 22 }, request: '字体大点' }).typography).toEqual({ body: { size: 15 }, title: { size: 28 } });
    expect(relativeTypography({}, asks('内文字体还是小'), { previous: { body: 15, title: 28 }, request: '内文字体还是小' }).typography).toEqual({ body: { size: 19 } });
    expect(relativeTypography({}, asks('字体大点'), { request: '字体大点' }).typography.body.size).toBeGreaterThan(12);
  });
  it('用户说了具体字号的不动', () => {
    expect(relativeTypography({ body: { size: 16 } }, asks('标题字大点'), { previous: { body: 12, title: 22 }, request: '标题字大点' }).typography).toEqual({ body: { size: 16 }, title: { size: 28 } });
  });
  it('单页告示已按页面取最大：“大点”不再放大，“小点”缩一档', () => {
    expect(relativeTypography({}, asks('字体大点'), { kind: 'poster', request: '字体大点' })).toEqual({ typography: {}, scale: 0 });
    expect(relativeTypography({}, asks('字小一点'), { kind: 'poster', request: '字小一点' }).scale).toBe(0.85);
  });
  it('换算出的字号真的写进 Word', async () => {
    const { typography } = relativeTypography({}, asks('字体大点'), { previous: { body: 12, title: 22 }, request: '字体大点' });
    const r = await generate('docx', { title: '说明', content: '# 说明\n\n## 一、背景\n\n正文内容写在这里。', kind: 'general', typography });
    expect((await measureDocx(r.blob)).body).toBe(15);
  });
});

describe('“不要横线”', () => {
  it('普通文档默认有装饰横线；说了不要就一条都没有', async () => {
    const md = '# 工作说明\n\n## 一、背景\n\n正文内容。\n\n---\n\n## 二、安排\n\n正文内容。';
    const before = await measureDocx((await generate('docx', { title: '工作说明', content: md, kind: 'report' })).blob);
    const after = await measureDocx((await generate('docx', { title: '工作说明', content: md, kind: 'report', noRules: true })).blob);
    expect(before.rules).toBeGreaterThan(0);
    expect(after.rules).toBe(0);
  });
});

describe('保存的字号偏好不能挡住“大点 / 小点”（第一轮 30 题实测：偏好 14 磅让“正文字大点”变成 16→14）', () => {
  it('偏好只当起点；有上一版就按上一版放大', () => {
    const asks = styleRequests('正文字大点，标题下面不要横线');
    const pref = { body: { size: 14 } };
    const r = relativeTypography(pref, asks, { previous: { body: 16, title: 22 }, request: '正文字大点，标题下面不要横线', explicit: {} });
    expect(r.typography.body.size).toBe(20);
    expect(r.typography.title).toBeUndefined(); // 只说了正文，标题不动
  });
  it('没有上一版时从偏好起步', () => {
    const r = relativeTypography({ body: { size: 14 } }, styleRequests('字体大点'), { request: '字体大点', explicit: {} });
    expect(r.typography.body.size).toBe(18);
  });
  it('这次原话里说了具体字号的仍然照用户的', () => {
    const r = relativeTypography({ body: { size: 14 } }, styleRequests('正文四号，字体大点'), { previous: { body: 16, title: 22 }, request: '正文四号，字体大点', explicit: { body: { size: 14 } } });
    expect(r.typography.body.size).toBe(14);
    expect(r.typography.title.size).toBe(28);
  });
});
