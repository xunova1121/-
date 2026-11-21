import { expect, it } from 'vitest';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { DOMParser } from '@xmldom/xmldom';
import { applyPosterGradient } from '../src/agent/posterGradientPptx.js';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const parse = source => new DOMParser().parseFromString(source, 'application/xml');
const elements = (node, tag) => Array.from(node.getElementsByTagName(tag));

async function poster({ targets = 1, pages = 1 } = {}) {
  const pptx = new PptxGenJS();
  for (let page = 0; page < pages; page++) {
    const slide = pptx.addSlide();
    slide.addImage({ data: IMAGE, x: 0, y: 0, w: 10, h: 5.625, objectName: 'poster-background' });
    for (let index = 0; index < targets; index++) slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 3.65625, w: 10, h: 1.96875, fill: { color: '132039' },
      line: { color: 'ABCDEF', transparency: 100 }, objectName: 'poster-text-gradient'
    });
    slide.addText('秋季养生汤 · 保留全部中文', { x: 1, y: 4, w: 8, h: 0.8, color: 'FFFFFF', objectName: 'poster-title-0' });
  }
  return pptx.write({ outputType: 'blob' });
}

it('海报原生渐变有真正透明端点和90度方向，中文与其他部件保持原字节', async () => {
  const input = await poster();
  const output = await applyPosterGradient(input, { color: '#132039', opacity: 0.85 });
  const before = await JSZip.loadAsync(await input.arrayBuffer());
  const after = await JSZip.loadAsync(await output.arrayBuffer());
  expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
  for (const [path, entry] of Object.entries(before.files)) {
    if (entry.dir || path === 'ppt/slides/slide1.xml') continue;
    expect(await after.file(path).async('uint8array')).toEqual(await entry.async('uint8array'));
  }
  const source = await before.file('ppt/slides/slide1.xml').async('string');
  const changed = await after.file('ppt/slides/slide1.xml').async('string');
  const xml = parse(changed);
  const gradients = elements(xml, 'a:gradFill');
  expect(gradients).toHaveLength(1);
  const stops = elements(gradients[0], 'a:gs');
  expect(stops.map(node => node.getAttribute('pos'))).toEqual(['0', '100000']);
  expect(stops.map(node => elements(node, 'a:srgbClr')[0].getAttribute('val'))).toEqual(['132039', '132039']);
  expect(stops.map(node => elements(node, 'a:alpha')[0].getAttribute('val'))).toEqual(['0', '85000']);
  expect(elements(gradients[0], 'a:lin')[0].getAttribute('ang')).toBe('5400000');
  expect(elements(xml, 'a:t').map(node => node.textContent)).toEqual(['秋季养生汤 · 保留全部中文']);
  const textShape = value => value.match(/<p:sp>[\s\S]*?<\/p:sp>/g).find(shape => shape.includes('name="poster-title-0"'));
  expect(textShape(changed)).toBe(textShape(source));
  expect(changed).toContain('<a:srgbClr val="ABCDEF">');
  expect(output.type).toBe(input.type);
});

it('缺少、重复固定对象或多页PPT必须失败，不把纯色占位块当成功结果', async () => {
  for (const options of [{ targets: 0 }, { targets: 2 }, { pages: 2 }]) {
    await expect(applyPosterGradient(await poster(options), { color: '132039', opacity: 0.85 })).rejects.toMatchObject({ code: 'POSTER_GRADIENT_INVALID' });
  }
});

it('颜色与透明度先校验，损坏包和已修补包均不能静默放过', async () => {
  const input = await poster();
  for (const options of [{ color: 'bad' }, { color: '#132039', opacity: -0.1 }, { color: '132039', opacity: 1.01 }, { color: '132039', opacity: NaN }, { color: '132039', opacity: '0.85' }]) {
    await expect(applyPosterGradient(input, options)).rejects.toMatchObject({ code: 'POSTER_GRADIENT_INVALID' });
  }
  await expect(applyPosterGradient(new Blob(['not a package']), { color: '132039' })).rejects.toMatchObject({ code: 'POSTER_GRADIENT_INVALID' });
  const output = await applyPosterGradient(input, { color: '132039' });
  await expect(applyPosterGradient(output, { color: '132039' })).rejects.toMatchObject({ code: 'POSTER_GRADIENT_INVALID' });
});

it('直接形状填充与嵌套线条填充区分，不能改错对象', async () => {
  const input = await poster();
  const zip = await JSZip.loadAsync(await input.arrayBuffer());
  let source = await zip.file('ppt/slides/slide1.xml').async('string');
  source = source.replace(/(<p:sp>[\s\S]*?name="poster-text-gradient"[\s\S]*?<p:spPr>)([\s\S]*?)(<\/p:spPr>)/, (_all, head, properties, tail) => {
    const line = properties.match(/<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/)[0];
    return head + line + properties.replace(line, '') + tail;
  });
  zip.file('ppt/slides/slide1.xml', source);
  const changed = await applyPosterGradient(new Blob([await zip.generateAsync({ type: 'uint8array' })]), { color: '132039', opacity: 0.6 });
  const readback = await JSZip.loadAsync(await changed.arrayBuffer());
  const text = await readback.file('ppt/slides/slide1.xml').async('string');
  expect(text).toContain('<a:alpha val="60000"/>');
  expect(text).toContain('<a:srgbClr val="ABCDEF">');
  expect(text.match(/<a:gradFill\b/g)).toHaveLength(1);
});
