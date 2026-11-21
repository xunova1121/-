import { it, expect, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createPosterTool } from '../src/agent/posterTool.js';
import { assertPosterPng } from '../src/agent/posterDeliveryTool.js';
import * as ws from '../src/agent/workspace.js';

// 独立编码有效PNG夹具，只测试交付协议；真实中文像素由poster-composition e2e验收。
function png(width, height) {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(payload.length + 8);
    out.writeUInt32BE(data.length); payload.copy(out, 4); out.writeUInt32BE(crc(payload), out.length - 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  return new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}

it('4K成品单独说明底图实际尺寸与2.5倍放大，不冒称原生细节通过', async () => {
  const source = png(1536, 864);
  await ws.write('海报回归/低于4K底图.png', source);
  const renderPoster = vi.fn(async () => ({ blob: png(3840, 2160), fontCheck: { status: 'passed' } }));
  const receipt = JSON.parse(await createPosterTool({ renderPoster }).run({ title: '气象演示海报', width: 3840, height: 2160, background_path: '海报回归/低于4K底图.png', path: '海报回归/4K导出.png' }));
  expect(receipt).toMatchObject({ status: 'complete', width: 3840, height: 2160, background: { width: 1536, height: 864, dimensions: 'verified', scale: 2.5, upscaled: true, cropped: false, detail: 'not_checked' } });
  expect(receipt.notes.join('')).toContain('不证明底图具有同等细节');
  expect(await (await ws.readBlob('海报回归/低于4K底图.png')).arrayBuffer()).toEqual(await source.arrayBuffer());
  expect(renderPoster).toHaveBeenCalledTimes(1);
});

it('最终PNG和可编辑两份源文件同尺寸保存并读回，渲染通过不能冒充视觉已核对', async () => {
  const changed = vi.fn(), checkpoint = vi.fn();
  const renderPoster = vi.fn(async () => ({ blob: png(512, 768), fontCheck: { status: 'passed' } }));
  const receipt = JSON.parse(await createPosterTool({ renderPoster, onFileChanged: changed }).run({ title: '秋季养生汤', width: 512, height: 768, text_fraction: 1 / 3, text_color: '#111111', panel_color: '#FFF8EC', path: '海报回归/完整.png' }, { checkpoint }));
  expect(receipt).toMatchObject({ kind: 'poster', status: 'complete', width: 512, height: 768, visual: 'not_checked', fontCheck: 'passed', textRendering: 'program', errors: [] });
  expect(receipt.files.map(file => file.format)).toEqual(['png', 'svg', 'pptx']);
  for (const file of receipt.files) {
    expect(file.readback).toBe('passed');
    expect((await ws.readBlob(file.path)).size).toBeGreaterThan(0);
  }
  expect(changed).toHaveBeenCalledTimes(4);
  expect(receipt.designPath).toBe('海报回归/完整.poster.json');
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact_validation', validation: expect.objectContaining({ kind: 'poster', render: 'passed', visual: 'not_checked', errors: 0 }) }));
  expect(renderPoster.mock.calls[0][0]).toContain('秋季养生汤');
});

it('渲染失败保留已读回的SVG/PPTX，回执只报部分交付，不泄露原始错误', async () => {
  const renderPoster = async () => { throw Object.assign(new Error('内部路径和响应不应外泄'), { code: 'PRIVATE_DETAIL' }); };
  const receipt = JSON.parse(await createPosterTool({ renderPoster }).run({ title: '未完成回执', width: 512, height: 768, path: '海报回归/失败.pptx' }));
  expect(receipt.status).toBe('partial');
  expect(receipt.files.map(file => file.format)).toEqual(['svg', 'pptx']);
  expect(receipt.errors).toEqual([expect.objectContaining({ code: 'POSTER_RENDER_FAILED' })]);
  expect(JSON.stringify(receipt)).not.toContain('内部路径');
});

it('旧预览缩放尺寸不能作为用户要求的成品，源文件仍可交付', async () => {
  const tool = createPosterTool({ renderPoster: async () => ({ blob: png(256, 256) }) });
  const receipt = JSON.parse(await tool.run({ title: '尺寸回执', width: 512, height: 768 }));
  expect(receipt.status).toBe('partial');
  expect(receipt.files.some(file => file.format === 'png')).toBe(false);
  expect(receipt.errors[0].code).toBe('POSTER_RENDER_DIMENSIONS');
});

it('已有底图在工作区直接复用，不覆盖原图，也不接受伪图片', async () => {
  const original = png(256, 256);
  await ws.write('海报回归/原图.png', original);
  const renderer = vi.fn(async () => ({ blob: png(512, 768), fontCheck: { status: 'passed' } }));
  const tool = createPosterTool({ renderPoster: renderer });
  const receipt = JSON.parse(await tool.run({ title: '底图复用', background_path: '海报回归/原图.png', width: 512, height: 768 }));
  expect(receipt.status).toBe('complete');
  expect(renderer.mock.calls[0][0]).toContain('data:image/png;base64,');
  expect(await (await ws.readBlob('海报回归/原图.png')).arrayBuffer()).toEqual(await original.arrayBuffer());
  await expect(tool.run({ title: '不能覆盖', background_path: '海报回归/原图.png', path: '海报回归/原图.png' })).rejects.toMatchObject({ code: 'INVALID_POSTER' });
  await ws.write('海报回归/伪图.png', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>']));
  await expect(tool.run({ title: '不能冒充', background_path: '海报回归/伪图.png' })).rejects.toMatchObject({ code: 'IMAGE_FORMAT_MISMATCH' });
});

it('用户停止和预算耗尽照常抛出，不能被降级成部分成功', async () => {
  for (const error of [new DOMException('停止', 'AbortError'), Object.assign(new Error('预算耗尽'), { code: 'RETRIEVAL_BUDGET' })]) {
    const tool = createPosterTool({ renderPoster: async () => { throw error; } });
    await expect(tool.run({ title: '停止检查', width: 512, height: 768 })).rejects.toBe(error);
  }
  const controller = new AbortController(); controller.abort();
  const renderer = vi.fn();
  await expect(createPosterTool({ renderPoster: renderer }).run({ title: '事前停止' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(renderer).not.toHaveBeenCalled();
});

it('拒绝不完整尺寸、无效尺寸名、非PNG渲染结果', async () => {
  const tool = createPosterTool();
  await expect(tool.run({ title: '尺寸', width: 512 })).rejects.toMatchObject({ code: 'INVALID_POSTER' });
  await expect(tool.run({ title: '尺寸', size: '随便' })).rejects.toMatchObject({ code: 'INVALID_POSTER' });
  await expect(assertPosterPng(new Blob(['不是png']), 512, 768)).rejects.toMatchObject({ code: 'POSTER_RENDER_INVALID' });
  await expect(assertPosterPng(png(512, 768).slice(0, 33), 512, 768)).rejects.toMatchObject({ code: 'POSTER_RENDER_INVALID' });
  await expect(tool.run(null)).rejects.toMatchObject({ code: 'INVALID_POSTER' });
});

it('兼容渲染路径没有真实字体回执时不标全部完成', async () => {
  const receipt = JSON.parse(await createPosterTool({ renderPoster: async () => png(512, 768) }).run({ title: '字体未核', width: 512, height: 768 }));
  expect(receipt).toMatchObject({ status: 'partial', fontCheck: 'not_checked' });
  expect(receipt.errors).toContainEqual(expect.objectContaining({ code: 'POSTER_FONT_CHECK_UNAVAILABLE' }));
});

it('改标题复用保存的设计和原底图，保留尺寸与原文件，不需要再次生成底图', async () => {
  const background = png(256, 256);
  await ws.write('海报回归/编辑底图.png', background);
  const tool = createPosterTool({ renderPoster: async () => ({ blob: png(512, 768), fontCheck: { status: 'passed' } }) });
  const first = JSON.parse(await tool.run({ title: '秋季养生汤', background_path: '海报回归/编辑底图.png', width: 512, height: 768, text_color: '#111111', panel_color: '#FFF8EC', path: '海报回归/初稿.png' }));
  const second = JSON.parse(await tool.run({ source_path: first.designPath, title: '冬日暖心汤' }));
  expect(second).toMatchObject({ status: 'complete', width: 512, height: 768 });
  const firstSvg = await ws.readText(first.files.find(file => file.format === 'svg').path);
  const secondSvg = await ws.readText(second.files.find(file => file.format === 'svg').path);
  expect(firstSvg).toContain('秋季养生汤');
  expect(secondSvg).toContain('冬日暖心汤');
  expect(secondSvg.match(/href="([^"]+)"/)[1]).toBe(firstSvg.match(/href="([^"]+)"/)[1]);
  expect(second.designPath).not.toBe(first.designPath);
  expect((await ws.readBlob(first.designPath)).size).toBeLessThan(40000);
  await ws.write('海报回归/编辑底图.png', png(257, 256));
  await expect(tool.run({ source_path: first.designPath, title: '不得偷偷换底图' })).rejects.toMatchObject({ code: 'POSTER_BACKGROUND_CHANGED' });
});
