import { describe, it, expect } from 'vitest';
import { selectPictureLayout, picturePlacement, PICTURE_PAGE, pictureRequestSize } from '../src/agent/pptImageLayout.js';
import { generate, parseFile } from '../src/agent/docs.js';
import { inspectPresentation } from '../src/agent/presentationReceipt.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
describe('图片美学版式', () => {
  it('短文横图先定全幅主图，面积不小于60%', () => {
    const p = selectPictureLayout({ items: 3, chars: 80, ratios: [16 / 9] });
    expect(p.name).toBe('hero');
    expect(p.pictures[0].areaRatio).toBeGreaterThanOrEqual(0.6);
    expect(pictureRequestSize(p)).toBe('1536x864');
  });
  it('中等正文分栏，方图和竖图均不硬塞横幅', () => {
    for (const ratio of [1, 0.7]) expect(selectPictureLayout({ items: 5, chars: 180, ratios: [ratio] }).name).toBe('split');
    expect(selectPictureLayout({ items: 1, chars: 15, ratios: [0.65] }).name).toBe('split');
  });
  it('六条、长文或结构化内容扩大文字区', () => {
    for (const metrics of [{ items: 6 }, { chars: 221 }, { structured: true }]) {
      const p = selectPictureLayout({ ...metrics, ratios: [0.8] });
      expect(p.name).toBe('split-wide');
      expect(p.areas[0].w).toBeGreaterThan(4);
      expect(p.text.w).toBeGreaterThan(p.areas[0].w);
    }
  });
  it('连续分栏左右交替，非分栏之后重新从右图开始', () => {
    const first = selectPictureLayout({ items: 5 });
    const second = selectPictureLayout({ items: 5, previous: first });
    const third = selectPictureLayout({ items: 6, previous: second });
    expect([first.imageSide, second.imageSide, third.imageSide]).toEqual(['right', 'left', 'right']);
    expect(selectPictureLayout({ items: 5, previous: { name: 'hero' } }).imageSide).toBe('right');
  });
  it.each([2, 3, 4])('%i张横图坐标不交叠、不越界，大小不低于下限', (count) => {
    const p = selectPictureLayout({ count, ratios: Array(count).fill(16 / 9) });
    expect(p.needsSplit).toBe(false);
    for (const a of p.pictures) {
      expect(a.areaRatio).toBeGreaterThanOrEqual(1 / 8);
      expect(Math.min(a.w, a.h)).toBeGreaterThanOrEqual(1.8);
      expect(a.x + a.w).toBeLessThanOrEqual(PICTURE_PAGE.w);
      expect(a.y + a.h).toBeLessThanOrEqual(PICTURE_PAGE.h);
    }
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++) {
        const a = p.pictures[i],
          b = p.pictures[j];
        expect(a.x + a.w <= b.x + 1e-8 || b.x + b.w <= a.x + 1e-8 || a.y + a.h <= b.y + 1e-8 || b.y + b.h <= a.y + 1e-8).toBe(true);
      }
  });
  it('裁掉超过25%改完整容纳，四张竖图放不下要求拆页', () => {
    const fit = picturePlacement({ x: 1, y: 1, w: 4, h: 5 }, 3);
    expect(fit.sizing).toBe('contain');
    expect(fit.cropRatio).toBe(0);
    expect(fit.avoidedCropRatio).toBeGreaterThan(0.25);
    expect(selectPictureLayout({ count: 4, ratios: [0.6, 0.6, 0.6, 0.6] }).needsSplit).toBe(true);
  });
  it('新制作接口表格和图片均保留，字号不小于14，真实回执有版式/面积/裁切', async () => {
    const out = await generate('pptx', {
      title: '样例',
      forbidCover: true,
      pictureLayout: 'aesthetic',
      content: '## 项目清单\n\n| 事项 | 负责人 |\n|--|--|\n|样本核对|甲组|\n|资料归档|乙组|\n\n![配图](a.png)',
      loadImage: async () => bytes
    });
    expect(out.info.layouts).toEqual(['table']);
    expect(out.info.imageLayouts[0].name).toBe('split-wide');
    const r = await inspectPresentation(await openOfficePackage(out.blob));
    expect(r.pages[0].tables).toBe(1);
    expect(r.pages[0].minTableFont).toBeGreaterThanOrEqual(14);
    expect(r.pages[0].imageAreaRatio).toBeGreaterThan(0.08);
    expect(r.pages[0].maxCropRatio).toBeLessThanOrEqual(0.25);
    expect(r.pages[0].imageLayout).toBe('split-wide');
    expect((await parseFile(out.blob, 'sample.pptx')).text).toContain('资料归档');
  });
  it('文字放不下拆续页、不删正文，不压到14以下；明确页数冲突拒绝', async () => {
    const content =
      '## 完整内容\n' +
      Array.from({ length: 12 }, (_, i) => `- 第${i + 1}项要求：${'完整保留原始内容并逐项核验。'.repeat(3)}`).join('\n') +
      '\n\n![配图](a.png)';
    const out = await generate('pptx', { title: '长文', content, forbidCover: true, pictureLayout: 'aesthetic', loadImage: async () => bytes });
    expect(out.info.slides).toBeGreaterThan(1);
    const r = await inspectPresentation(await openOfficePackage(out.blob));
    for (const p of r.pages) expect(p.minBodyFont).toBeGreaterThanOrEqual(14);
    const text = (await parseFile(out.blob, 'sample.pptx')).text;
    for (let i = 1; i <= 12; i++) expect(text).toContain(`第${i}项要求`);
    await expect(
      generate('pptx', { title: '长文', content, forbidCover: true, expectedSlides: 1, pictureLayout: 'aesthetic', loadImage: async () => bytes })
    ).rejects.toMatchObject({ code: 'DOCUMENT_SLIDE_COUNT' });
  });
});

it('明确24磅按24磅拆页，不能测量14磅后又套回24；小于14磅明确报冲突', async () => {
  const content = '## 正文\n' + Array.from({ length: 10 }, (_, i) => `- 要求${i}：${'每项内容都完整保留。'.repeat(3)}`).join('\n') + '\n\n![图](x.png)';
  const options = { title: '字体保护', content, forbidCover: true, pictureLayout: 'aesthetic', loadImage: async () => bytes };
  const out = await generate('pptx', { ...options, typography: { body: { size: 24 } } });
  expect(out.info.slides).toBeGreaterThan(1);
  expect(out.info.layoutIssues.filter((i) => i.level === 'error')).toEqual([]);
  const r = await inspectPresentation(await openOfficePackage(out.blob));
  for (const page of r.pages) expect(page.minBodyFont).toBe(24);
  await expect(generate('pptx', { ...options, typography: { body: { size: 12 } } })).rejects.toMatchObject({ code: 'PPT_IMAGE_FONT' });
});
it('图表配图保留原生图表与数值，不栅格化或缩进20%窄栏', async () => {
  const out = await generate('pptx', {
    title: '业务数据',
    content: '## 分组对比\n\n| 团队 | 完成数 |\n|--|--|\n|甲|20|\n|乙|30|\n|丙|25|\n\n![图](x.png)',
    forbidCover: true,
    pictureLayout: 'aesthetic',
    loadImage: async () => bytes
  });
  const zip = await openOfficePackage(out.blob);
  expect(Object.keys(zip.files).filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p))).toHaveLength(1);
  expect(out.info.preview[0].items.some((i) => i.kind === 'chart')).toBe(true);
  expect(out.info.imageLayouts[0].name).toBe('split-wide');
});
it('第5张图片仍明确报告，四张竖图不缩成邮票，拆页保留所有引用', async () => {
  const content = '## 图片册\n' + Array.from({ length: 5 }, (_, i) => `\n![第${i}张](img${i}.png)`).join('\n');
  const out = await generate('pptx', { title: '图片册', content, forbidCover: true, pictureLayout: 'aesthetic', loadImage: async () => bytes });
  expect(out.info.missingImages).toContain('img4.png（本页最多4图，未放入）');
  const r = await inspectPresentation(await openOfficePackage(out.blob));
  expect(r.pages.reduce((n, p) => n + p.contentImages, 0)).toBe(4);
  for (const page of r.pages) for (const pic of page.images) expect(pic.areaRatio).toBeGreaterThanOrEqual(0.125);
});
it('只有生成器明确标识的覆字背景允许重叠，普通内容图继续拦截压字', async () => {
  const { layoutIssues } = await import('../src/agent/slidePreview.js');
  const slide = {
    n: 1,
    items: [
      { kind: 'text', text: '正文', x: 1, y: 2, w: 3, h: 1, o: { fontSize: 20, margin: 0 } },
      { kind: 'image', x: 1, y: 2, w: 3, h: 3, role: 'wy-content-1' }
    ]
  };
  expect(layoutIssues([slide]).some((i) => i.level === 'error')).toBe(true);
  slide.items[1].role = 'wy-content-background';
  expect(layoutIssues([slide])).toEqual([]);
});
it('真实面积小于8%按缺图处理，过量裁切报警，重叠图片不重复累计面积', async () => {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const { inspectDocument } = await import('../src/agent/documentQuality.js');
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  const tiny = ppt.addSlide();
  tiny.addImage({ data: 'image/png;base64,' + Buffer.from(bytes).toString('base64'), x: 1, y: 2, w: 2, h: 2, objectName: 'wy-content-1' });
  tiny.addImage({ data: 'image/png;base64,' + Buffer.from(bytes).toString('base64'), x: 1, y: 2, w: 2, h: 2, objectName: 'wy-content-2' });
  const cut = ppt.addSlide();
  cut.addImage({
    data: 'image/png;base64,' + Buffer.from(bytes).toString('base64'),
    x: 1,
    y: 2,
    w: 8,
    h: 8,
    sizing: { type: 'cover', w: 8, h: 3 },
    objectName: 'wy-content-1'
  });
  const report = await inspectDocument(new Blob([await ppt.write({ outputType: 'arraybuffer' })]), 'check.pptx', { requirements: '每页配图' });
  expect(report.presentation.pages[0].imageAreaRatio).toBeCloseTo(0.04, 3);
  expect(report.presentation.missingImagePages).toEqual([1]);
  expect(report.errors).toBeGreaterThan(0);
  expect(report.issues.some((i) => i.level === 'warn' && i.text.includes('超过25%'))).toBe(true);
});
it('封面按真实明暗选遮罩，竖封面contain保留全图，控制信号不吞', async () => {
  const { pictureContrast } = await import('../src/agent/pptPictureRender.js');
  const { rasterizeSvg } = await import('../server/svgRaster.mjs');
  const make = async (color) =>
    new Uint8Array(
      await (
        await rasterizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="200"><rect width="120" height="200" fill="${color}"/></svg>`)
      ).arrayBuffer()
    );
  const light = await make('#ffffff'),
    dark = await make('#101010');
  const a = await pictureContrast({ bytes: light }),
    b = await pictureContrast({ bytes: dark });
  expect(a.brightnessMeasured).toBe(true);
  expect(b.brightnessMeasured).toBe(true);
  expect(a.opacity).toBeGreaterThan(b.opacity);
  const out = await generate('pptx', {
    title: '亮图封面',
    content: '# 亮图封面\n\n![竖图](x.png)\n\n## 正文\n说明',
    pictureLayout: 'aesthetic',
    loadImage: async () => light
  });
  expect(out.info.imageLayouts[0]).toMatchObject({ name: 'cover', contrast: { brightnessMeasured: true } });
  expect(out.info.imageLayouts[0].pictures[0].cropRatio).toBe(0);
  expect(out.info.layoutIssues.filter((i) => i.level === 'error')).toEqual([]);
  const r = await inspectPresentation(await openOfficePackage(out.blob));
  expect(r.pages[0].imageLayout).toBe('cover');
  expect(r.pages[0].maxCropRatio).toBe(0);
  await expect(
    generate('pptx', {
      title: '停止',
      content: '## 正文\n![图](x.png)',
      pictureLayout: 'aesthetic',
      loadImage: async () => {
        throw Object.assign(new Error('stop'), { name: 'AbortError' });
      }
    })
  ).rejects.toMatchObject({ name: 'AbortError' });
});
it('大数字与流程在新文字区域重排，保留原生数字卡和箭头', async () => {
  for (const content of ['## 数据\n\n- 20 场：尚未开赛\n- 7 场：正在进行', '## 办理流程\n\n受理 → 分派 → 处理 → 归档']) {
    const out = await generate('pptx', {
      title: '结构保护',
      content: content + '\n\n![图](x.png)',
      forbidCover: true,
      pictureLayout: 'aesthetic',
      loadImage: async () => bytes
    });
    expect(out.info.imageLayouts[0].name).toBe('split-wide');
    expect(out.info.layoutIssues.filter((i) => i.level === 'error')).toEqual([]);
    const xml = await (await openOfficePackage(out.blob)).file('ppt/slides/slide1.xml').async('string');
    if (content.includes('20 场')) expect(xml).toContain('wy-stat-number');
    else expect(xml).toContain('downArrow');
  }
});
it('配图不把指定折线/饼图改成柱图，图表旁说明仍完整保留', async () => {
  for (const [wish, tag] of [
    ['折线图', 'lineChart'],
    ['饼图', 'doughnutChart']
  ]) {
    const out = await generate('pptx', {
      title: '图型保护',
      content: `## 季度指标\n版式：${wish}\n\n| 类别 | 数值 |\n|--|--|\n|甲|20|\n|乙|30|\n|丙|25|\n\n说明：合成样本，全部保留。\n\n![图](x.png)`,
      forbidCover: true,
      pictureLayout: 'aesthetic',
      loadImage: async () => bytes
    });
    const zip = await openOfficePackage(out.blob);
    const chartFile = Object.keys(zip.files).find((path) => /^ppt\/charts\/chart\d+\.xml$/.test(path));
    expect(chartFile).toBeDefined();
    expect(await zip.file(chartFile).async('string')).toContain(tag);
    expect((await parseFile(out.blob, 'sample.pptx')).text).toContain('合成样本');
  }
});
