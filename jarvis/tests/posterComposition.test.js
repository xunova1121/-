/** 中文海报：源文字不删不改；SVG/PPTX共用有界版式与真实图片数据。 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { composePoster, composePosterLayout } from '../src/agent/posterComposition.js';
import { normalizePosterInput, normalizePosterBackground, POSTER_LIMITS } from '../src/agent/posterCompositionInput.js';

const bytes = (value) => Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
const PNG = bytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
const WEBP = bytes('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=');
const JPEG = bytes('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==');
const parse = (source) => new DOMParser().parseFromString(source, 'application/xml');
const elements = (document, tag) => Array.from(document.getElementsByTagName(tag));

async function posterXml(output) {
  const zip = await JSZip.loadAsync(await output.pptx.arrayBuffer());
  const source = await zip.file('ppt/slides/slide1.xml').async('string');
  return { zip, source, slide: parse(source), presentation: parse(await zip.file('ppt/presentation.xml').async('string')) };
}

describe('中文海报的尺寸与共同版式', () => {
  it('1024×1536下三分之一，秋季养生汤精确五字；文字为可编辑对象', async () => {
    const out = await composePoster({ title: '秋季养生汤', width: 1024, height: 1536, text_position: 'bottom', text_fraction: 1 / 3 });
    const svg = parse(out.svg);
    expect(svg.documentElement.getAttribute('width')).toBe('1024');
    expect(svg.documentElement.getAttribute('height')).toBe('1536');
    expect(svg.documentElement.getAttribute('viewBox')).toBe('0 0 1024 1536');
    expect(out.layout.panel).toEqual({ x: 0, y: 1024, w: 1024, h: 512 });
    const svgText = elements(svg, 'text').map((node) => node.textContent).join('');
    expect(svgText).toBe('秋季养生汤');
    expect([...svgText]).toHaveLength(5);
    expect(out.texts[0]).toBe(svgText);
    expect(out.fonts).toEqual(['Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Droid Sans Fallback']);
    const { presentation, slide, source } = await posterXml(out);
    const size = elements(presentation, 'p:sldSz')[0];
    expect(Number(size.getAttribute('cx'))).toBe(1024 * 9525);
    expect(Number(size.getAttribute('cy'))).toBe(1536 * 9525);
    expect(elements(slide, 'a:t').map((node) => node.textContent).join('')).toBe(svgText);
    expect(source).toContain('poster-title-0-0');
    expect(source).toContain('<a:ea typeface="Noto Sans CJK SC"');
    expect(source).toContain('wrap="none"');
    expect(source).not.toMatch(/<a:(?:normAutofit|spAutoFit)/);
  });

  it.each([
    ['top', { x: 0, y: 0, w: 1200, h: 300 }],
    ['bottom', { x: 0, y: 600, w: 1200, h: 300 }],
    ['left', { x: 0, y: 0, w: 400, h: 900 }],
    ['right', { x: 800, y: 0, w: 400, h: 900 }],
    ['center', { x: 0, y: 300, w: 1200, h: 300 }]
  ])('%s方向按用户比例分配文字区', (position, expected) => {
    const layout = composePosterLayout({ title: '春日记', width: 1200, height: 900, text_position: position, text_fraction: 1 / 3 });
    expect(layout.panel).toEqual(expected);
    for (const block of layout.blocks) {
      expect(block.x).toBeGreaterThanOrEqual(expected.x + layout.margin);
      expect(block.y).toBeGreaterThanOrEqual(expected.y + layout.margin);
      expect(block.x + block.w).toBeLessThanOrEqual(expected.x + expected.w - layout.margin + 0.001);
      expect(block.y + block.h).toBeLessThanOrEqual(expected.y + expected.h - layout.margin + 0.001);
    }
  });

  it('长段落完整换行，SVG和PPTX逐行文字、位置与字号一致', async () => {
    const title = '春日城市文化与生活主题展';
    const lines = ['记录城市的每一种色彩，留下自然与人的相遇。'.repeat(8), '活动时间：周六下午两点\n地点：中央文化广场\n\n欢迎所有朋友参加。'];
    const out = await composePoster({ title, subtitle: '让每一次相遇都被认真记住', lines, footer: '主办单位：城市文化中心', width: 1024, height: 1536, text_fraction: 0.8 });
    const svgRows = elements(parse(out.svg), 'text');
    const { slide } = await posterXml(out);
    const pptRows = elements(slide, 'p:sp').filter((shape) => elements(shape, 'p:cNvPr')[0]?.getAttribute('name').startsWith('poster-'));
    const rows = out.layout.blocks.flatMap((block) => block.rows.map((row) => ({ ...row, fontSize: block.fontSize })));
    expect(svgRows).toHaveLength(rows.length);
    expect(pptRows).toHaveLength(rows.length);
    for (const block of out.layout.blocks) expect(block.rows.map((row) => row.text).join('')).toBe(block.text.replace(/\n/g, ''));
    rows.forEach((row, index) => {
      expect(svgRows[index].textContent).toBe(row.text);
      expect(elements(pptRows[index], 'a:t').map((node) => node.textContent).join('')).toBe(row.text);
      const offset = elements(pptRows[index], 'a:off')[0];
      const extent = elements(pptRows[index], 'a:ext')[0];
      expect(Math.abs(Number(offset.getAttribute('x')) - row.x * 9525)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(offset.getAttribute('y')) - row.y * 9525)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(extent.getAttribute('cx')) - row.w * 9525)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(extent.getAttribute('cy')) - row.h * 9525)).toBeLessThanOrEqual(1);
      expect(Number(svgRows[index].getAttribute('y'))).toBe(row.baseline);
      if (row.text) expect(Number(elements(pptRows[index], 'a:rPr')[0].getAttribute('sz'))).toBe(Math.round(row.fontSize * 75));
    });
    expect(out.texts).toContain(lines[0]);
    expect(out.texts).toContain(lines[1]);
  });

  it('放不下就带结构化信息失败，不给省略号或成功文件', async () => {
    await expect(composePoster({ title: '全部保留', width: 256, height: 256, text_fraction: 1 / 3, lines: ['春'.repeat(500)] })).rejects.toMatchObject({
      name: 'ValidationError', code: 'POSTER_TEXT_OVERFLOW', kind: 'input', details: { width: 256, height: 256, characters: 504 }
    });
    const layout = composePosterLayout({ title: '全部保留', width: 1024, height: 1536, text_fraction: 1, lines: ['春'.repeat(500)] });
    expect(layout.blocks.find((block) => block.role === 'lines').rows.map((row) => row.text).join('')).toBe('春'.repeat(500));
  });
});

describe('图片、字体与输入安全', () => {
  it('底图作为data URI嵌入，两格式用同一真实图片，PPT按原图比例居中裁切', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const out = await composePoster({ title: '中文标题', width: 1024, height: 1536, background: { bytes: PNG, mime: 'image/png' } });
      const picture = elements(parse(out.svg), 'image')[0];
      expect(picture.getAttribute('href')).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
      expect(picture.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');
      const { zip, slide, source } = await posterXml(out);
      const imageEntry = Object.keys(zip.files).find((entry) => entry.startsWith('ppt/media/') && entry.endsWith('.png'));
      expect(await zip.file(imageEntry).async('uint8array')).toEqual(PNG);
      const crop = elements(slide, 'a:srcRect')[0];
      expect(crop.getAttribute('l')).toBe('16667');
      expect(crop.getAttribute('r')).toBe('16667');
      expect(crop.getAttribute('t')).toBe('0');
      expect(source).not.toContain('r:link=');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('真实WebP可内嵌，错误MIME和外部URL均拒绝', () => {
    expect(normalizePosterBackground({ bytes: WEBP, mime: 'image/webp' })).toMatchObject({ width: 1, height: 1, mime: 'image/webp' });
    expect(() => normalizePosterBackground({ bytes: PNG, mime: 'image/jpeg' })).toThrow(/字节不符/);
    expect(() => normalizePosterBackground({ url: 'https://example.com/photo.png' })).toThrow(/真实图片字节/);
    expect(() => normalizePosterBackground({ bytes: new TextEncoder().encode('<svg onload="alert(1)"/>'), mime: 'image/png' })).toThrow(/字节不符/);
    expect(() => normalizePosterBackground({ bytes: new Uint8Array(POSTER_LIMITS.maxImageBytes + 1), mime: 'image/png' })).toThrow(/10MB/);
    const hugeImage = PNG.slice();
    new DataView(hugeImage.buffer).setUint32(16, 6000);
    new DataView(hugeImage.buffer).setUint32(20, 6000);
    expect(() => normalizePosterBackground({ bytes: hugeImage, mime: 'image/png' })).toThrow(/2500万像素/);
  });

  it.each([['image/jpeg', JPEG, '.jpeg'], ['image/webp', WEBP, '.webp']])('%s真实字节按实际MIME写入SVG和PPTX', async (mime, content, extension) => {
    const out = await composePoster({ title: '中文原文', background: { bytes: content, mime } });
    expect(elements(parse(out.svg), 'image')[0].getAttribute('href')).toMatch(`data:${mime};base64,`);
    const { zip } = await posterXml(out);
    const path = Object.keys(zip.files).find((entry) => entry.startsWith('ppt/media/') && entry.endsWith(extension));
    expect(await zip.file(path).async('uint8array')).toEqual(content);
  });

  it('伪造PNG头、缺失结尾、APNG动画与WebP残缺块均不能当真实底图交付', () => {
    const headerOnly = new Uint8Array(24);
    headerOnly.set(PNG.subarray(0, 8));
    new DataView(headerOnly.buffer).setUint32(16, 100);
    new DataView(headerOnly.buffer).setUint32(20, 100);
    const apng = PNG.slice();
    apng.set(new TextEncoder().encode('acTL'), 37);
    const truncatedWebp = WEBP.slice(0, -2);
    new DataView(truncatedWebp.buffer).setUint32(4, truncatedWebp.length - 8, true);
    for (const invalid of [headerOnly, PNG.slice(0, -4), apng]) {
      expect(() => normalizePosterBackground({ bytes: invalid, mime: 'image/png' })).toThrow(/字节不符/);
    }
    expect(() => normalizePosterBackground({ bytes: truncatedWebp, mime: 'image/webp' })).toThrow(/字节不符/);
  });

  it('只指定黑字自动配浅底；低对比配色明确报错，普通正文用更严格阈值', async () => {
    const out = await composePoster({ title: '秋季养生汤', text_color: '#111111' });
    const rectangles = elements(parse(out.svg), 'rect');
    expect(rectangles.at(-1).getAttribute('fill')).toBe('#FFF8EC');
    expect(rectangles.at(-1).getAttribute('fill-opacity')).toBe('1');
    expect(elements(parse(out.svg), 'text')[0].getAttribute('fill')).toBe('#111111');
    expect(() => normalizePosterInput({ title: '看不清', text_color: '#111111', panel_color: '#132039' })).toThrow(/对比不足/);
    expect(normalizePosterInput({ title: '大标题', text_color: '#888888', panel_color: '#FFFFFF' }).panelColor).toBe('#FFFFFF');
    expect(() => normalizePosterInput({ title: '大标题', subtitle: '正文', text_color: '#888888', panel_color: '#FFFFFF' })).toThrow(/对比不足/);
  });

  it('已知的两倍/三倍破折号按保守宽度换行，不按1em压出画布', () => {
    const title = '⸻'.repeat(10);
    const layout = composePosterLayout({ title });
    expect(layout.blocks[0].rows.map((row) => row.text).join('')).toBe(title);
    expect(layout.blocks[0].rows.every((row) => [...row.text].length * 3.3 * layout.blocks[0].fontSize <= row.w)).toBe(true);
  });

  it.each(['क्ष', `a${'\u0301'.repeat(30)}`])('不能保证尺寸的复杂字形明确拒绝，不默认为1em后裁字：%s', (title) => {
    expect(() => composePosterLayout({ title })).toThrow(/不能保证完整排版/);
    try {
      composePosterLayout({ title });
    } catch (error) {
      expect(error).toMatchObject({ code: 'POSTER_UNSUPPORTED_TEXT', kind: 'input' });
    }
  });

  it('宋体候选、精确配色和XML转义落到两个成品，没有活动元素', async () => {
    const title = '秋<&>"\'汤';
    const out = await composePoster({ title, font_family: 'serif', text_color: '#123456', panel_color: '#ABCDEF', background_color: 'FFEEDD' });
    const svg = parse(out.svg);
    expect(elements(svg, 'text').map((node) => node.textContent).join('')).toBe(title);
    expect(elements(svg, 'text')[0].getAttribute('font-family')).toBe('Noto Serif CJK SC, SimSun, Songti SC, Noto Serif SC, Source Han Serif SC, serif');
    expect(elements(svg, 'text')[0].getAttribute('fill')).toBe('#123456');
    expect(elements(svg, 'rect')[0].getAttribute('fill')).toBe('#FFEEDD');
    expect(elements(svg, 'rect').at(-1).getAttribute('fill')).toBe('#ABCDEF');
    expect(out.svg).toContain('秋&lt;&amp;&gt;&quot;&apos;汤');
    expect(out.svg).not.toMatch(/<script|<foreignObject|\bstyle=|<!DOCTYPE|url\(/i);
    const { slide, source } = await posterXml(out);
    expect(elements(slide, 'a:t').map((node) => node.textContent).join('')).toBe(title);
    expect(source).toContain('typeface="Noto Serif CJK SC"');
    expect(source).toContain('val="123456"');
    expect(source).toContain('val="ABCDEF"');
  });

  it.each([
    { width: 0 }, { width: 256.5 }, { height: 4097 }, { width: 4096, height: 4096 },
    { text_fraction: 0 }, { text_fraction: Number.NaN }, { text_position: 'outside' },
    { font_family: 'serif" onload="alert(1)' }, { text_color: 'url(https://example.com)' },
    { title: 'a\u0000b' }, { title: '\ud800' }, { title: ' '.repeat(5) },
    { title: '字'.repeat(6001) }, { lines: Array(33).fill('') }, { lines: [42] },
    { subtitle: '春'.repeat(4000), footer: '秋'.repeat(4000) }
  ])('拒绝不合法或超过预算的参数 %#', (options) => {
    expect(() => normalizePosterInput({ title: '原样文字', ...options })).toThrow();
  });

  it('换行、空格和代理对原文保留，不把特殊字形拆成损坏的字符', () => {
    const title = '  春日🏡展  ';
    const input = normalizePosterInput({ title, lines: ['首行\r\n\r\n第三行'] });
    expect(input.title).toBe(title);
    expect(input.lines[0]).toBe('首行\n\n第三行');
    const layout = composePosterLayout({ title: '春日', lines: ['家庭👨‍👩‍👧‍👦与四季e\u0301'.repeat(8)], text_position: 'right', text_fraction: 0.35 });
    expect(layout.blocks[1].rows.map((row) => row.text).join('')).toBe('家庭👨‍👩‍👧‍👦与四季e\u0301'.repeat(8));
    expect(layout.blocks[1].rows.every((row) => !row.text.startsWith('\u200d') && !row.text.endsWith('\u200d'))).toBe(true);
  });

  it('日常海报中点、货币、温度、运算符可完整排版', () => {
    const text = '莲藕 · 山药 · 红枣，¥20，25℃ ± 2°，1024×1536，版权所有©';
    const layout = composePosterLayout({ title: '秋季养生汤', lines: [text], footer: '原创合成底图 · 中文由程序排版' });
    expect(layout.blocks[1].rows.map((row) => row.text).join('')).toBe(text);
  });
});
