import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { preparePresentationImages } from '../src/agent/presentationImagePlan.js';
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
let directory;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aesthetic-plan-'));
  useBackend(createFileStore(directory));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(directory, { recursive: true, force: true });
});
it('短句先选hero再按横幅比例画图；密集内容生成文字区对应竖图', async () => {
  const imageGen = vi.fn(async () => ({ blob: new Blob([bytes], { type: 'image/png' }) }));
  const out = await preparePresentationImages({ imageGen }, '## 愿景\n让协作更清楚。\n\n## 服务\n- 受理：整理需求\n- 分工：确认负责人\n- 复核：留下记录', {
    title: '公司介绍',
    requirements: '每页配图',
    forbidCover: true
  });
  expect(out.issues).toEqual([]);
  expect(out.plan.map((p) => p.layout)).toEqual(['hero', 'split-wide']);
  expect(imageGen.mock.calls[0][0].size).toBe('1536x864');
  expect(imageGen.mock.calls[1][0].size).toBe(out.plan[1].size);
  const [w, h] = out.plan[1].size.split('x').map(Number);
  expect(w / h).toBeCloseTo(out.plan[1].requiredRatio, 1);
});
it('图库也拿到先定的版式与比例；已有图片按真实比例选版式且不重画', async () => {
  const imageGen = vi.fn();
  const stockImageForSlide = vi.fn(async () => ({ path: 'images/stock.png' }));
  const options = { title: '说明', requirements: '每页配图', forbidCover: true };
  const out = await preparePresentationImages({ imageGen, stockImageForSlide }, '## 内容\n一句话。', options);
  expect(stockImageForSlide.mock.calls[0][0]).toMatchObject({ layout: 'hero', size: '1536x864', aspectRatio: out.plan[0].requiredRatio });
  const existing = await preparePresentationImages({ imageGen }, '## 内容\n一句话。\n\n![用户图](uploads/own.png)', {
    ...options,
    loadImage: async () => bytes
  });
  expect(existing.plan[0]).toMatchObject({ existing: true, layout: 'split' });
  expect(imageGen).not.toHaveBeenCalled();
});
it('用户只用上传图或禁止AI，缺来源明确失败不擅自画图', async () => {
  const imageGen = vi.fn();
  for (const requirement of ['每页配图，只用上传图片', '每页配图，不要AI']) {
    const result = await preparePresentationImages({ imageGen }, '## 内容\n一句话。', { title: '说明', requirements: requirement, forbidCover: true });
    expect(result.issues.some((i) => i.level === 'error')).toBe(true);
  }
  expect(imageGen).not.toHaveBeenCalled();
});
it('明确原生正文角色不被32磅/顶部位置误判成标题', async () => {
  const { applyPresentationTypography } = await import('../src/agent/officeTypography.js');
  const slide = { addText: vi.fn(), addTable: vi.fn() };
  const add = slide.addText;
  applyPresentationTypography(slide, { title: { size: 40 }, body: { size: 32 } }, '标题');
  slide.addText('正文', { objectName: 'wy-body', y: 1.4, fontSize: 32 });
  expect(add.mock.calls[0][1].fontSize).toBe(32);
});
it('服务器图库挑图拿到最终区域比例和下载图片的真实尺寸', async () => {
  const { createStockImages } = await import('../server/stockImages.mjs');
  const photo = {
    id: 1,
    src: { large: 'https://images.pexels.com/photos/1/example.png' },
    url: 'https://www.pexels.com/photo/1',
    photographer: 'Author',
    photographer_url: 'https://www.pexels.com/@author'
  };
  const visionLlm = vi.fn(async () => '{"index":0}');
  const api = createStockImages({
    getConfig: () => ({ pexelsKey: 'test-key', stockVerified: { pexels: { ok: true } } }),
    health: { get: async () => ({}), record: async () => {} },
    fetchImpl: async (url) => (url.startsWith('https://api.pexels.com') ? new Response(JSON.stringify({ photos: [photo] })) : new Response(bytes))
  });
  const out = await api.forSlide({ query: 'football', aspectRatio: 0.82, layout: 'split-wide', visionLlm });
  expect(out.path).toMatch(/^images\/stock\//);
  expect(visionLlm.mock.calls[0][0].prompt).toContain('目标宽高比0.820');
  expect(visionLlm.mock.calls[0][0].prompt).toContain('0: 1×1');
});
