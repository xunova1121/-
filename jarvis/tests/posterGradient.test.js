import { expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { composePoster, composePosterLayout } from '../src/agent/posterComposition.js';
import { normalizePosterInput } from '../src/agent/posterCompositionInput.js';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';
import { validatePosterSvg } from '../src/agent/posterSvg.js';
import { validateVisualSceneSvg } from '../src/agent/visualSceneSvg.js';
import { mergePosterDesignOptions, posterDesignInput } from '../src/agent/posterDesignSource.js';
import { loadVisualDesign, visualDesignBlob } from '../src/agent/visualDesignSource.js';
import * as ws from '../src/agent/workspace.js';

const parse = source => new DOMParser().parseFromString(source, 'application/xml');
const elements = (doc, tag) => Array.from(doc.getElementsByTagName(tag));
const background = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), mime: 'image/png' };

function png(width, height) {
  const crc = data => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, data) => {
    const payload = Buffer.concat([Buffer.from(kind), data]), out = Buffer.alloc(payload.length + 8);
    out.writeUInt32BE(data.length); payload.copy(out, 4); out.writeUInt32BE(crc(payload), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}

it('默认旧实色与居中旧位置保持，渐变默认下方35%、居中及0.85透明终点', () => {
  expect(normalizePosterInput({ title: '旧面板' })).toMatchObject({ text_style: 'panel', text_fraction: 0.48, text_align: 'left' });
  expect(composePosterLayout({ title: '旧居中', text_position: 'center' }).blocks[0].align).toBe('center');
  expect(normalizePosterInput({ title: '沉浸渐变', text_style: 'gradient' })).toMatchObject({ text_position: 'bottom', text_fraction: 0.35, text_align: 'center', gradient_opacity: 0.85 });
  expect(composePosterLayout({ title: '明确靠左', text_style: 'gradient', text_align: 'left' }).blocks[0].align).toBe('left');
  expect(composePosterLayout({ title: '实色居中', text_align: 'center' }).blocks[0].align).toBe('center');
});

it('SVG是真正透明线性渐变，底图上没有硬边实色文字块，旧SVG白名单仍拒绝渐变', async () => {
  const out = await composePoster({ title: '秋季养生汤', subtitle: '温润一盅，滋养四季', width: 1080, height: 1440, text_style: 'gradient', background });
  const doc = parse(out.svg);
  expect(out.layout.panel).toMatchObject({ x: 0, y: 936, w: 1080 });
  expect(out.layout.panel.h).toBeCloseTo(504, 9);
  expect(elements(doc, 'linearGradient')).toHaveLength(1);
  const gradient = elements(doc, 'linearGradient')[0];
  expect(['x1', 'y1', 'x2', 'y2'].map(key => gradient.getAttribute(key))).toEqual(['0', '0', '0', '1']);
  expect(elements(gradient, 'stop').map(node => [node.getAttribute('offset'), node.getAttribute('stop-opacity')])).toEqual([['0', '0'], ['1', '0.85']]);
  const rectangles = elements(doc, 'rect');
  expect(rectangles).toHaveLength(2);
  expect(rectangles[1].getAttribute('fill')).toBe('url(#poster-text-gradient)');
  expect(rectangles[1].getAttribute('y')).toBe('936');
  expect(rectangles[1].getAttribute('height')).toBe('504');
  expect(elements(doc, 'image')[0].getAttribute('href')).toBe('data:image/png;base64,' + Buffer.from(background.bytes).toString('base64'));
  expect(elements(doc, 'text').every(node => node.getAttribute('text-anchor') === 'middle' && node.getAttribute('x') === '540')).toBe(true);
  expect(() => validatePosterSvg(out.svg)).toThrow();
  expect(validateVisualSceneSvg(out.svg).text).toBe('秋季养生汤温润一盅，滋养四季');
  const old = await composePoster({ title: '旧实色', width: 1080, height: 1440, background });
  expect(old.svg).not.toContain('linearGradient');
  expect(validatePosterSvg(old.svg).text).toBe('旧实色');
});

it('SVG与PPTX采用同一渐变区域，透明度端点一致，中文每一行仍是原生可编辑文本', async () => {
  const out = await composePoster({ title: '秋季养生汤', subtitle: '温润一盅，滋养四季', footer: '慢享暖意', width: 1080, height: 1440, text_style: 'gradient', gradient_opacity: 0.72, background });
  const svg = parse(out.svg), zip = await JSZip.loadAsync(await out.pptx.arrayBuffer());
  const slide = parse(await zip.file('ppt/slides/slide1.xml').async('string'));
  const shape = elements(slide, 'p:sp').find(node => elements(node, 'p:cNvPr')[0].getAttribute('name') === 'poster-text-gradient');
  const transform = elements(shape, 'a:xfrm')[0];
  expect(elements(transform, 'a:off')[0].getAttribute('y')).toBe(String(936 * 9525));
  expect(elements(transform, 'a:ext')[0].getAttribute('cy')).toBe(String(504 * 9525));
  expect(elements(shape, 'a:gs').map(node => [node.getAttribute('pos'), elements(node, 'a:alpha')[0].getAttribute('val')])).toEqual([['0', '0'], ['100000', '72000']]);
  expect(elements(shape, 'a:lin')[0].getAttribute('ang')).toBe('5400000');
  const svgText = elements(svg, 'text').map(node => node.textContent);
  expect(elements(slide, 'a:t').map(node => node.textContent)).toEqual(svgText);
  const textShapes = elements(slide, 'p:sp').filter(node => elements(node, 'a:t').length);
  expect(textShapes).toHaveLength(svgText.length);
  expect(textShapes.every(node => elements(node, 'a:pPr')[0].getAttribute('algn') === 'ctr')).toBe(true);
  expect(elements(slide, 'p:pic')).toHaveLength(1);
});

it.each([{ text_style: 'custom' }, { text_align: 'justify' }, { text_style: 'gradient', text_position: 'top' }, { gradient_opacity: -0.01 }, { gradient_opacity: 1.01 }, { gradient_opacity: NaN }, { gradient_opacity: '0.8' }])('渐变参数只接受受控样式与有限透明度：%j', options => {
  expect(() => normalizePosterInput({ title: '不可插入任意SVG', ...options })).toThrow();
});

it('渐变经专用渲染器，原稿保存样式、对齐、透明度；改字复用同底图和同渐变', async () => {
  const source = png(512, 768);
  await ws.write('渐变回归/原底图.png', source);
  const renderVisualScene = vi.fn(async svg => {
    expect(validateVisualSceneSvg(svg).text).toBeTruthy();
    return { blob: png(512, 768), fontCheck: { status: 'passed' } };
  });
  const renderPoster = vi.fn(), imageGen = vi.fn();
  const tool = createPosterDeliveryTool({ renderVisualScene, renderPoster, imageGen });
  const first = JSON.parse(await tool.run({ title: '秋季养生汤', width: 512, height: 768, text_style: 'gradient', text_align: 'center', gradient_opacity: 0.72, background_path: '渐变回归/原底图.png', path: '渐变回归/初稿.png' }));
  // 2026-11-12 复审：渲染器给出真实像素时按实测判定对比度，结论带每块文字的数值；整体视觉仍未验收
  expect(first).toMatchObject({ status: 'complete', textStyle: 'gradient', textAlign: 'center', visual: 'not_checked', gradient: { opacity: 0.72, fraction: 0.35 } });
  expect(['passed', 'failed']).toContain(first.gradient.contrast);
  expect(first.gradient.measured.length).toBeGreaterThan(0);
  expect(first.notes.join('')).toContain('按底图真实像素');
  const stored = JSON.parse(await ws.readText(first.designPath));
  expect(stored.options).toMatchObject({ text_style: 'gradient', text_align: 'center', gradient_opacity: 0.72, text_fraction: 0.35 });
  const second = JSON.parse(await tool.run({ source_path: first.designPath, title: '冬日暖心汤' }));
  expect(second).toMatchObject({ status: 'complete', textStyle: 'gradient', gradient: { opacity: 0.72, fraction: 0.35 } });
  const svg = await ws.readText(first.files.find(file => file.format === 'svg').path);
  const revised = await ws.readText(second.files.find(file => file.format === 'svg').path);
  // 2026-11-12 复审：渐变海报先渲一份无字版量真实像素对比度，渲染调用变多；成品仍须与保存的SVG逐字相同
  const finals = renderVisualScene.mock.calls.map(call => call[0]).filter(value => !value.includes('<g opacity="0"><text'));
  expect(finals).toHaveLength(2);
  expect(svg).toBe(finals[0]);
  expect(revised).toBe(finals[1]);
  expect(revised).toBe(svg.replace('秋季养生汤', '冬日暖心汤'));
  expect(await (await ws.readBlob('渐变回归/原底图.png')).arrayBuffer()).toEqual(await source.arrayBuffer());
  expect(renderPoster).not.toHaveBeenCalled();
  expect(imageGen).not.toHaveBeenCalled();
});

it('旧实色源稿只改gradient时采用底部35%居中，避免继承旧48%左对齐或顶部位置', async () => {
  for (const text_style of [undefined, 'panel']) {
    const options = { title: '旧稿换渐变', width: 1080, height: 1440, ...(text_style && { text_style }), text_position: 'top', text_fraction: 0.48, text_align: 'left' };
    const path = `渐变回归/切换-${text_style || '旧版'}.poster.json`;
    await ws.write(path, JSON.stringify({ kind: 'poster-design', version: 1, options, backgroundHash: null }));
    const merged = await posterDesignInput({ source_path: path, text_style: 'gradient' });
    expect(normalizePosterInput(merged)).toMatchObject({ text_style: 'gradient', text_position: 'bottom', text_fraction: 0.35, text_align: 'center' });
    expect(JSON.parse(await ws.readText(path)).options).toEqual(options);
  }
});

it('切换渐变时本轮显式版式优先，已有渐变稿改字不丢自定义比例和对齐', () => {
  const previous = { title: '旧稿', text_style: 'panel', text_position: 'top', text_fraction: 0.48, text_align: 'left' };
  expect(mergePosterDesignOptions(previous, { text_style: 'gradient', text_position: 'bottom', text_fraction: 0.42, text_align: 'left' })).toMatchObject({ text_position: 'bottom', text_fraction: 0.42, text_align: 'left' });
  expect(mergePosterDesignOptions(previous, { text_style: 'gradient', text_position: 'top' }).text_position).toBe('top');
  const gradient = { ...previous, text_style: 'gradient', text_position: 'bottom', text_fraction: 0.42 };
  expect(mergePosterDesignOptions(gradient, { title: '仅改文字', text_style: 'gradient' })).toMatchObject({ title: '仅改文字', text_position: 'bottom', text_fraction: 0.42, text_align: 'left' });
  expect(mergePosterDesignOptions(previous, { title: '实色仅改字' })).toMatchObject({ text_style: 'panel', text_position: 'top', text_fraction: 0.48, text_align: 'left' });
});

it('海报Demo源稿同样应用样式切换默认，保存后再复用不丢显式渐变版式', async () => {
  const posterOptions = { title: '海报Demo旧稿', width: 1080, height: 1440, text_style: 'panel', text_position: 'top', text_fraction: 0.48, text_align: 'left' };
  await ws.write('渐变回归/Demo切换.visual.json', JSON.stringify({ kind: 'visual-design', version: 1, options: { title: posterOptions.title }, posterOptions, backgroundPath: null, backgroundHash: null }));
  const inherited = await loadVisualDesign({ source_path: '渐变回归/Demo切换.visual.json', text_style: 'gradient' });
  expect(normalizePosterInput(inherited.posterOptions)).toMatchObject({ text_style: 'gradient', text_position: 'bottom', text_fraction: 0.35, text_align: 'center' });
  const explicit = await loadVisualDesign({ source_path: '渐变回归/Demo切换.visual.json', text_style: 'gradient', text_position: 'bottom', text_fraction: 0.42, text_align: 'left', gradient_opacity: 0.65 });
  await ws.write('渐变回归/Demo渐变续稿.visual.json', visualDesignBlob(explicit));
  const reused = await loadVisualDesign({ source_path: '渐变回归/Demo渐变续稿.visual.json', title: '只改Demo标题' });
  expect(normalizePosterInput(reused.posterOptions)).toMatchObject({ title: '只改Demo标题', text_style: 'gradient', text_position: 'bottom', text_fraction: 0.42, text_align: 'left', gradient_opacity: 0.65 });
});
