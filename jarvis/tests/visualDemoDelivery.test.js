import { it, expect, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import * as ws from '../src/agent/workspace.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { composePoster } from '../src/agent/posterComposition.js';
import { posterDesignBlob } from '../src/agent/posterDesignSource.js';
import { loadVisualDesign } from '../src/agent/visualDesignSource.js';

// 真实有效PNG容器，只验证交付逻辑；中文实际像素另由visual-demo e2e验证。
function png(width, height, color = 0) {
  const crc = bytes => {
    let c = 0xffffffff;
    for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc(body), out.length - 4); return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(width); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, color);
  for (let at = 0; at < height; at++) rows[at * (width * 3 + 1)] = 0;
  return new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}
const renderer = () => vi.fn(async () => ({ blob: png(960, 540), fontCheck: { status: 'passed' } }));

it('同一设计交付四格式及小型源稿，回执不冒称视觉/交互实测', async () => {
  const checkpoint = vi.fn(), onFileChanged = vi.fn();
  const result = JSON.parse(await createVisualDemoTool({ renderVisualScene: renderer(), onFileChanged }).run({ title: '气象交付', width: 960, height: 540, path: '视觉测试/交付.html' }, { checkpoint }));
  expect(result).toMatchObject({ status: 'complete', width: 960, height: 540, visual: 'not_checked', interaction: 'not_checked', fontCheck: 'passed', dataMode: 'demo' });
  expect(result.files.map(file => file.format)).toEqual(['svg', 'png', 'html', 'zip']);
  expect(result.files.every(file => file.readback === 'passed')).toBe(true);
  expect(onFileChanged).toHaveBeenCalledTimes(5);
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ validation: expect.objectContaining({ visual: 'not_checked' }) }));
  const archive = await JSZip.loadAsync(await (await ws.readBlob(result.files.find(file => file.format === 'zip').path)).arrayBuffer());
  for (const file of result.files.filter(file => file.format !== 'zip')) expect(await archive.file(`design.${file.format}`).async('uint8array')).toEqual(new Uint8Array(await (await ws.readBlob(file.path)).arrayBuffer()));
  expect((await ws.readBlob(result.designPath)).size).toBeLessThan(80000);
});

it('错误尺寸或缺失字体回执只交源文件，HTML不嵌入假4K图片', async () => {
  for (const rendered of [{ blob: png(512, 512), fontCheck: { status: 'passed' } }, { blob: png(960, 540) }]) {
    const result = JSON.parse(await createVisualDemoTool({ renderVisualScene: async () => rendered }).run({ width: 960, height: 540 }));
    expect(result.status).toBe('partial');
    expect(result.files.map(file => file.format)).toEqual(['svg', 'html', 'zip']);
    expect(result.fontCheck).toBe('not_checked');
    const html = await ws.readText(result.files.find(file => file.format === 'html').path);
    expect(html).not.toContain('data:image/png;base64,');
    const archive = await JSZip.loadAsync(await (await ws.readBlob(result.files.find(file => file.format === 'zip').path)).arrayBuffer());
    expect(await archive.file('README.txt').async('string')).toContain('PNG未通过检查，未交付');
  }
});

it('修改设计另存，旧稿与底图保持原字节，底图换过不能假复用', async () => {
  const background = png(320, 180, 30);
  await ws.write('视觉测试/bg.png', background);
  const tool = createVisualDemoTool({ renderVisualScene: renderer() });
  const old = JSON.parse(await tool.run({ title: '旧标题', width: 960, height: 540, background_path: '视觉测试/bg.png' }));
  const before = await ws.readText(old.designPath);
  const revised = JSON.parse(await tool.run({ source_path: old.designPath, title: '新标题' }));
  expect(revised.status).toBe('complete'); expect(revised.designPath).not.toBe(old.designPath);
  expect(await ws.readText(old.designPath)).toBe(before);
  expect(await ws.readText(revised.files.find(file => file.format === 'svg').path)).toContain('新标题');
  expect(revised.background).toMatchObject({ width: 320, height: 180, upscaled: true });
  expect(revised.background.scale).toBeCloseTo(Math.max(revised.background.placement.width / 320, revised.background.placement.height / 180), 3);
  await ws.write('视觉测试/bg.png', png(320, 180, 80));
  await expect(tool.run({ source_path: old.designPath })).rejects.toMatchObject({ code: 'VISUAL_BACKGROUND_CHANGED' });
  await expect(tool.run({ source_path: old.designPath, background_path: './视觉测试/bg.png' })).rejects.toMatchObject({ code: 'VISUAL_BACKGROUND_CHANGED' });
});

it('已有海报复用相同SVG排字和底图，海报Demo源稿可再次修改', async () => {
  const input = { title: '春日计划', subtitle: '保留每一个汉字', width: 960, height: 540, text_position: 'left', text_fraction: 0.5 };
  await ws.write('视觉测试/海报.poster.json', await posterDesignBlob(input, { width: 960, height: 540, background: null }));
  const tool = createVisualDemoTool({ renderVisualScene: renderer() });
  const result = JSON.parse(await tool.run({ source_path: '视觉测试/海报.poster.json' }));
  expect(result.status).toBe('complete');
  expect(await ws.readText(result.files.find(file => file.format === 'svg').path)).toBe((await composePoster(input)).svg);
  const modified = JSON.parse(await tool.run({ source_path: result.designPath, title: '夏日计划' }));
  expect(modified.status).toBe('complete');
  expect(await ws.readText(modified.files.find(file => file.format === 'svg').path)).toContain('夏日计划');
  expect(await ws.readText(result.files.find(file => file.format === 'svg').path)).toContain('春日计划');
});

it('不允许覆盖源稿、路径越界、畸形源稿，真正取消原样传播', async () => {
  const tool = createVisualDemoTool({ renderVisualScene: renderer() });
  const result = JSON.parse(await tool.run({ width: 960, height: 540, path: '视觉测试/源稿.html' }));
  await expect(tool.run({ source_path: result.designPath, path: '视觉测试/源稿.png' })).rejects.toThrow(/覆盖/);
  await expect(tool.run({ path: '../外部.html' })).rejects.toThrow(/路径/);
  await ws.write('视觉测试/坏.visual.json', JSON.stringify({ kind: 'visual-design', version: 1, options: [] }));
  await expect(loadVisualDesign({ source_path: '视觉测试/坏.visual.json' })).rejects.toThrow(/设计文件/);
  const controller = new AbortController(); controller.abort();
  await expect(tool.run({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  const cancelled = createVisualDemoTool({ renderVisualScene: async () => { throw new DOMException('停止', 'AbortError'); } });
  await expect(cancelled.run({ width: 960, height: 540 })).rejects.toMatchObject({ name: 'AbortError' });
});

it('渲染原始失败详情不泄露，真实来源模式缺数据不会填入演示读数', async () => {
  const result = JSON.parse(await createVisualDemoTool({ renderVisualScene: async () => { throw new Error('secret-internal-url'); } }).run({ title: '未测站点', dataMode: 'provided', source: '用户测试表', width: 960, height: 540 }));
  expect(result.status).toBe('partial'); expect(JSON.stringify(result)).not.toContain('secret-internal-url');
  const design = JSON.parse(await ws.readText(result.designPath));
  expect(design.options.metrics).toEqual([]); expect(design.options.markers).toEqual([]);
});

it('将旧演示稿改为来源数据时不能继承未替换的示例值', async () => {
  const tool = createVisualDemoTool({ renderVisualScene: renderer() });
  const old = JSON.parse(await tool.run({ width: 960, height: 540 }));
  const loaded = await loadVisualDesign({ source_path: old.designPath, dataMode: 'provided', source: '用户新表', metrics: [{ label: '气温', value: 18, unit: '℃' }] });
  expect(loaded.design.metrics).toHaveLength(1);
  expect(loaded.design.series).toEqual([]); expect(loaded.design.alerts).toEqual([]); expect(loaded.design.markers).toEqual([]);
  expect(loaded.design.asOf).not.toContain('演示');
});

it('海报主题配色在Demo复用时保持一致', async () => {
  const input = { title: '森林主题', width: 960, height: 540, theme: 'forest-canopy' };
  await ws.write('视觉测试/主题.poster.json', await posterDesignBlob(input, { width: 960, height: 540, background: null }));
  const result = JSON.parse(await createVisualDemoTool({ renderVisualScene: renderer() }).run({ source_path: '视觉测试/主题.poster.json' }));
  expect(await ws.readText(result.files.find(file => file.format === 'svg').path)).toBe((await composePoster({ ...input, background_color: '#2D4A2B', panel_color: '#2D4A2B' })).svg);
});
