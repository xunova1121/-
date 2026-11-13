/** 海报（程序排版文字、可编辑 PPTX）和图片处理（抠图、证件照、修复、清晰化：原图保留，没有编辑能力明确报错） */
import { it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import * as workspace from '../src/agent/workspace.js';
import { posterLayout, fitFont, makePoster, createPosterTool, POSTER_SIZES } from '../src/agent/posterTool.js';
import { imageTaskPrompt, createImageTaskTool, ID_PHOTO } from '../src/agent/imageTasks.js';
import { createTools } from '../src/agent/tools.js';
import { CORE } from '../src/agent/toolLoader.js';

// 1×1 透明 PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const raster = async () => ({ mime: 'image/png', data: btoa(String.fromCharCode(...PNG)) });

it('排版：主标题最大、在安全边距内；字多就缩小字号；文字太多提示拥挤', () => {
  const l = posterLayout({ size: '竖版', title: '秋季音乐节', subtitle: '城市草坪专场', lines: ['11月8日 19:00', '城市公园'], footer: '主办：文旅局' });
  const [title, sub, lines, footer] = l.blocks;
  expect(title.role).toBe('title');
  expect(title.pt).toBeGreaterThan(sub.pt);
  expect(sub.pt).toBeGreaterThan(lines.pt - 1);
  expect(footer.role).toBe('footer');
  for (const b of l.blocks) { expect(b.x).toBeGreaterThanOrEqual(l.margin - 1e-9); expect(b.x + b.w).toBeLessThanOrEqual(l.size.w - l.margin + 1e-9); }
  expect(fitFont('一二三四五六七八九十一二三四五六七八九十', 6, 66)).toBeLessThan(fitFont('音乐节', 6, 66));
  expect(fitFont('abc', 6, 66)).toBe(66);
  const crowded = posterLayout({ size: '横版', title: '一个特别特别长的海报主标题文字', subtitle: '副标题也很长很长很长', lines: Array(6).fill('这是一条很长的要点说明文字') });
  expect(crowded.overflow).toBe(true);
  expect(Object.keys(POSTER_SIZES)).toEqual(['竖版', '横版', '方形', '朋友圈封面']);
});

it('生成可编辑 PPTX：文字是文本对象（不在图里），没底图用原创插画', async () => {
  const rasterizeSvg = vi.fn(raster);
  const out = await makePoster({ title: '秋季音乐节', subtitle: '城市草坪专场', lines: ['11月8日'], rasterizeSvg });
  expect(rasterizeSvg).toHaveBeenCalledTimes(1);
  const zip = await JSZip.loadAsync(await out.pptx.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  expect(xml).toContain('秋季音乐节');
  expect(xml).toContain('poster-title');
  expect(xml).toContain('poster-lines');
  expect(Object.keys(zip.files).some((f) => f.startsWith('ppt/media/'))).toBe(true);
});

it('make_poster 工具：要有主标题；底图只收 PNG / JPEG；保存到 海报/ 目录', async () => {
  const tool = createPosterTool({ rasterizeSvg: raster });
  await expect(tool.run({ title: '  ' })).rejects.toMatchObject({ code: 'INVALID_POSTER' });
  await expect(tool.run({ title: '展览', background_path: 'a.gif' })).rejects.toMatchObject({ code: 'INVALID_POSTER' });
  await workspace.write('底图.png', new Blob([PNG], { type: 'image/png' }));
  const msg = await tool.run({ title: '城市摄影展', background_path: '底图.png', size: '方形' });
  expect(msg).toContain('海报/城市摄影展.pptx');
  expect(msg).toContain('底图：底图.png');
  expect((await workspace.readBlob('海报/城市摄影展.pptx')).size).toBeGreaterThan(1000);
  expect(CORE).toContain('make_poster');
  expect(createTools({}).some((t) => t.name === 'make_poster')).toBe(true);
});

it('图片处理要求：抠图透明 PNG、证件照规格和底色、修复不改相貌', () => {
  expect(imageTaskPrompt('remove_background')).toMatchObject({ background: 'transparent', outputFormat: 'png' });
  expect(imageTaskPrompt('id_photo', { color: '蓝', spec: '二寸' }).prompt).toMatch(/二寸[\s\S]*蓝色[\s\S]*413:579/);
  expect(imageTaskPrompt('restore').prompt).toContain('不添加不存在的细节');
  expect(imageTaskPrompt('upscale').quality).toBe('high');
  expect(() => imageTaskPrompt('beautify')).toThrow(/不支持/);
  expect(ID_PHOTO['一寸']).toEqual([295, 413]);
});

it('process_image：没有编辑能力明确报错；有编辑能力时原图不动、结果另存', async () => {
  await workspace.write('证件照原图.png', new Blob([PNG], { type: 'image/png' }));
  await expect(createImageTaskTool({}).run({ task: 'id_photo', path: '证件照原图.png' })).rejects.toMatchObject({ code: 'IMAGE_EDIT_UNAVAILABLE' });
  await expect(createImageTaskTool({ imageEdit: vi.fn() }).run({ task: 'restore', path: 'a.gif' })).rejects.toMatchObject({ code: 'IMAGE_EDIT_INPUT' });
  const imageEdit = vi.fn(async ({ images, prompt }) => { expect(images[0].size).toBe(PNG.length); expect(prompt).toContain('证件照'); return { blob: new Blob([PNG], { type: 'image/png' }), model: 'fixture' }; });
  const changed = vi.fn();
  const tool = createTools({ imageEdit, onFileChanged: changed }).find((t) => t.name === 'process_image');
  const msg = await tool.run({ task: 'id_photo', path: '证件照原图.png', color: '红', spec: '小二寸' });
  expect(imageEdit).toHaveBeenCalledTimes(1);
  expect(msg).toMatch(/原图 证件照原图\.png 未改动/);
  const saved = /另存为 (\S+?\.png)/.exec(msg)[1];
  expect(saved).toMatch(/^images\/证件照原图-证件照-小二寸红底-/);
  expect(changed).toHaveBeenCalledWith(saved);
  expect((await workspace.readBlob('证件照原图.png')).size).toBe(PNG.length);
  expect(CORE).toContain('process_image');
});
