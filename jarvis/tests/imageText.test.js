import { describe, it, expect, vi } from 'vitest';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { normalizeCanvasDesign, canvasEntries } from '../src/agent/imageTextInput.js';
import { createImageTextEngine } from '../src/agent/imageTextEngine.js';
import { pixelTextRegions, locateImageText } from '../src/agent/imageTextRegions.js';
import { loadCanvasText, claimCanvasName } from '../src/agent/imageTextSource.js';
import { serverCanvasRenderer } from '../server/canvasImageText.mjs';
import { canvasFontFiles, fontCollectionFace } from '../server/canvasFontFile.mjs';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { posterReceipt, textPosterRequest, canvasTextRequest } from '../src/agent/posterRouting.js';
import { visualSceneReceipt } from '../src/agent/visualSceneRouting.js';
import { taskContract } from '../src/agent/taskContract.js';
import { mediaRequirement } from '../src/agent/actionDelivery.js';
import { reviewCanvasText } from '../src/agent/imageTextReview.js';
import { createImageTextEditor } from '../src/agent/imageTextEditor.js';
import * as ws from '../src/agent/workspace.js';
import { canvasFixture, canvasCopy } from '../e2e/fixtures/canvas-text.mjs';

const fixture = canvasFixture({ width: 600, height: 900 });
const frame = fixture.frame,
  detected = pixelTextRegions(frame, 7);
const base = () =>
  normalizeCanvasDesign({
    kind: 'canvas-image-text',
    version: 1,
    title: '七卡槽验收',
    image: { path: '填字测试/base.png', hash: 'a'.repeat(64), width: 600, height: 900 },
    width: 600,
    height: 900,
    entries: canvasEntries({ entries: canvasCopy }),
    regions: detected.regions,
    protected: fixture.protections,
    detection: { method: 'pixels', confidence: 0.84 }
  });
const engine = createImageTextEngine();

describe('真实像素定位和原图坐标协议', () => {
  it('从像素找到七个实际卡槽，排除图标，不把固定七个坐标写死', () => {
    expect(detected.regions).toHaveLength(7);
    for (const [i, r] of detected.regions.entries()) {
      expect(r.x).toBeGreaterThan(0.14);
      expect(r.y).toBeCloseTo(0.47 + i * 0.066, 2);
    }
    const moved = canvasFixture({ width: 600, height: 900, count: 6, shift: -0.05, left: 0.23 });
    const actual = pixelTextRegions(moved.frame, 6);
    expect(actual.regions).toHaveLength(6);
    expect(actual.regions[0].x).toBeGreaterThan(0.22);
    expect(actual.regions[0].y).toBeCloseTo(0.42, 2);
    expect(pixelTextRegions(moved.frame, 7).regions).toEqual([]);
    expect(pixelTextRegions(frame, 6).regions).toEqual([]);
  });
  it('坐标不舍入原值，拒绝拉伸、越界、重复对应、错误字体和远端原图', () => {
    const d = base(),
      original = 0.123456789;
    d.regions[0].x = original;
    expect(normalizeCanvasDesign(d).regions[0].x).toBe(original);
    for (const change of [{ width: 900 }, { fontFamily: 'unknown' }, { reading: 'tiny' }, { bodySize: 8 }])
      expect(() => normalizeCanvasDesign({ ...d, ...change })).toThrow();
    expect(() => normalizeCanvasDesign({ ...d, image: { ...d.image, path: 'https://example.com/a.png' } })).toThrow(
      /原图/
    );
    d.regions[0].w = 1;
    expect(() => normalizeCanvasDesign(d)).toThrow(/越界/);
    expect(() => canvasEntries({ entries: [{ title: '不能截字'.repeat(500) }] })).toThrow();
  });
  it('已明确卡槽无额外模型调用，缺标题时最多一次真实图片定位且先扣预算', async () => {
    const order = [],
      visionLlm = vi.fn(async (request) => {
        order.push('request');
        expect(request.images[0].data.length).toBeGreaterThan(100);
        expect(request.maxWebSearches).toBe(0);
        return JSON.stringify({
          regions: [{ id: 'header', role: 'header', x: 0.04, y: 0.08, w: 0.5, h: 0.18 }],
          protected: [],
          confidence: 0.92
        });
      });
    const blob = new Blob([fixture.bytes], { type: 'image/png' });
    await locateImageText({ spec: {}, entries: base().entries, blob, frame, ctx: { visionLlm } });
    expect(visionLlm).not.toHaveBeenCalled();
    const r = await locateImageText({
      spec: {},
      entries: canvasEntries({ entries: canvasCopy, header: { title: '今日观察' } }),
      blob,
      frame,
      ctx: { visionLlm },
      retrieval: { consume: (kind) => order.push(kind) }
    });
    expect(order).toEqual(['model', 'request']);
    expect(visionLlm).toHaveBeenCalledTimes(1);
    expect(r.regions.filter((r) => r.role === 'slot')).toEqual(detected.regions);
    expect(r.regions.some((r) => r.role === 'header')).toBe(true);
  });
  it('不确定定位保留待排版状态；取消与预算必须往上抛', async () => {
    const input = {
      spec: {},
      entries: canvasEntries({ entries: canvasCopy, header: { title: '标题' } }),
      blob: new Blob([fixture.bytes]),
      frame
    };
    const value = await locateImageText({
      ...input,
      ctx: { visionLlm: async () => '{"regions":[],"protected":[],"confidence":0.3}' }
    });
    expect(value.detection.method).toBe('needs_layout');
    const error = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
    await expect(
      locateImageText({
        ...input,
        ctx: { visionLlm: vi.fn() },
        retrieval: {
          consume: () => {
            throw error;
          }
        }
      })
    ).rejects.toBe(error);
    const control = new AbortController();
    control.abort();
    await expect(
      locateImageText({ ...input, ctx: { visionLlm: vi.fn() }, signal: control.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Canvas全文排字而非遮挡', () => {
  it('真实字体实际测量，七条全文不丢、保护图标且只改变文字像素', async () => {
    for (const font of await canvasFontFiles('Noto Sans CJK SC')) GlobalFonts.register(font);
    expect(GlobalFonts.has('Noto Sans CJK SC')).toBe(true);
    const d = base(),
      ctx = createCanvas(d.width, d.height).getContext('2d');
    ctx.drawImage(await loadImage(fixture.bytes), 0, 0);
    const before = ctx.getImageData(0, 0, d.width, d.height).data;
    const layout = engine.colorRows(ctx, d, engine.plan(ctx, d, 'Noto Sans CJK SC'), before);
    expect(layout.errors).toEqual([]);
    expect(layout.status).toBe('passed');
    expect(layout.minimumBodyPixels).toBeGreaterThanOrEqual(12);
    for (const e of d.entries)
      for (const role of ['title', 'body'])
        expect(
          layout.rows
            .filter((r) => r.entryId === e.id && r.role === role)
            .map((r) => r.text)
            .join('')
        ).toBe(e[role]);
    expect(engine.paint(ctx, layout, 'Noto Sans CJK SC')).toBe(true);
    const difference = engine.verifyBackground(before, ctx.getImageData(0, 0, d.width, d.height).data, d, layout);
    expect(difference).toMatchObject({ status: 'passed', changedOutsideText: 0, changedInProtected: 0 });
    expect(difference.changedPixels).toBeGreaterThan(0);
  });
  it('长文装不下、文字交叠或进入人物/图标保护区均拦住，不截字、不缩小正文', () => {
    const ctx = createCanvas(600, 900).getContext('2d');
    const d = base();
    d.entries[0].body = '完整保留的长文'.repeat(150);
    let layout = engine.plan(ctx, d, 'Noto Sans CJK SC');
    expect(layout.status).toBe('needs_layout');
    expect(engine.paint(ctx, layout, 'Noto Sans CJK SC')).toBe(false);
    const overlap = base();
    overlap.regions[1] = { ...overlap.regions[0], id: 'slot-2', entryId: overlap.entries[1].id };
    expect(engine.plan(ctx, overlap, 'Noto Sans CJK SC').errors.some((e) => e.code === 'CANVAS_TEXT_OVERLAP')).toBe(
      true
    );
    const blocked = base();
    blocked.protected.push({ id: 'blocked', role: 'protected', ...blocked.regions[0] });
    expect(
      engine.plan(ctx, blocked, 'Noto Sans CJK SC').errors.some((e) => e.code === 'CANVAS_PROTECTED_OVERLAP')
    ).toBe(true);
  });
  it('真实底图对比不足不会用遮罩偷过，能被像素保护检测发现的覆盖不得通过', () => {
    const d = base(),
      ctx = createCanvas(600, 900).getContext('2d');
    ctx.fillStyle = '#103B65';
    ctx.fillRect(0, 0, 600, 900);
    d.textColor = '#103B65';
    expect(engine.colorRows(ctx, d, engine.plan(ctx, d, 'Noto Sans CJK SC')).status).toBe('needs_layout');
    const before = ctx.getImageData(0, 0, 600, 900).data;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 600, 300);
    expect(engine.verifyBackground(before, ctx.getImageData(0, 0, 600, 900).data, d, { rows: [] }).status).toBe(
      'failed'
    );
  });
  it('TTC选简中而非集合首个JP字面，坏字体范围明确拒绝', () => {
    expect(() => fontCollectionFace(new Uint8Array(4), 0)).toThrow();
    const bad = Buffer.alloc(16);
    bad.write('ttcf');
    bad.writeUInt32BE(1000, 8);
    expect(() => fontCollectionFace(bad, 0)).toThrow();
  });
  it('渲染进程并发有界，用户取消后容量恢复，连续使用不共享原生字体状态', async () => {
    const blob = new Blob([fixture.bytes], { type: 'image/png' });
    const a = serverCanvasRenderer.inspect(blob),
      b = serverCanvasRenderer.inspect(blob);
    await expect(serverCanvasRenderer.inspect(blob)).rejects.toMatchObject({ code: 'CANVAS_BUSY' });
    expect((await Promise.all([a, b])).every((value) => value.width === 600 && value.frame.data.length > 0)).toBe(true);
    const abort = new AbortController();
    abort.abort();
    await expect(serverCanvasRenderer.inspect(blob, { signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
    const active = new AbortController(),
      pending = serverCanvasRenderer.inspect(blob, { signal: active.signal });
    active.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await serverCanvasRenderer.inspect(blob)).height).toBe(900);
  }, 15000);
  it('最终核验最多一次，发送实际原图/成品/缩图且先扣模型预算，不重画', async () => {
    const blob = new Blob([fixture.bytes], { type: 'image/png' }),
      order = [];
    const visionLlm = vi.fn(async (request) => {
      order.push('request');
      expect(request.images).toHaveLength(3);
      expect(request.maxWebSearches).toBe(0);
      expect(request.maxTransientRetries).toBe(0);
      return JSON.stringify({
        copyMatches: true,
        readable: true,
        noOverlap: true,
        backgroundPreserved: false,
        issues: ['不能通过']
      });
    });
    const result = await reviewCanvasText({ visionLlm }, base(), blob, blob, blob, {
      retrieval: { consume: (kind) => order.push(kind) }
    });
    expect(order).toEqual(['model', 'request']);
    expect(visionLlm).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect((await reviewCanvasText({}, base(), blob, blob, blob)).status).toBe('not_checked');
    const error = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
    await expect(
      reviewCanvasText({ visionLlm }, base(), blob, blob, blob, {
        retrieval: {
          consume: () => {
            throw error;
          }
        }
      })
    ).rejects.toBe(error);
  });
  it('离线编辑器文案只是数据，script结束串不逃逸；不含SVG元素', () => {
    const d = base();
    d.entries[0].title = '</script><img src=x onerror=alert(1)>';
    const html = createImageTextEditor(d, 'data:image/png;base64,AA==');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg');
    expect(html).toContain('\\u003c/script');
  });
});

describe('真实交付、另存、复用与路由', () => {
  const ctx = {
    canvasRenderer: serverCanvasRenderer,
    renderPoster: () => {
      throw new Error('不能走SVG');
    },
    imageGen: () => {
      throw new Error('不能重新生图');
    }
  };
  it('实际PNG/可编辑PPTX/HTML/ZIP读回，原图hash绑定，改字和Demo不重识别/不覆盖', async () => {
    await ws.write('填字测试/base.png', new Blob([fixture.bytes], { type: 'image/png' }));
    const r = JSON.parse(
      await createPosterTool(ctx).run({
        title: '七卡槽验收',
        background_path: '填字测试/base.png',
        canvas: { entries: canvasCopy, protected: fixture.protections },
        path: '填字测试/交付.png'
      })
    );
    expect(r.status).toBe('complete');
    expect(r.errors).toEqual([]);
    expect(posterReceipt(true, JSON.stringify(r)).state).toBe('completed');
    const before = await ws.readText(r.designPath),
      source = JSON.parse(before);
    expect(r.files.map((f) => f.format)).toEqual(['html', 'png', 'pptx', 'zip']);
    const pptx = await JSZip.loadAsync(
      await (await ws.readBlob(r.files.find((f) => f.format === 'pptx').path)).arrayBuffer()
    );
    const xml = await pptx.file('ppt/slides/slide1.xml').async('string');
    expect((xml.match(/<a:t>/g) || []).length).toBeGreaterThanOrEqual(14);
    for (const e of canvasCopy) expect(xml).toContain(e.title);
    expect(Object.keys(pptx.files).some((p) => /\.svg$/.test(p))).toBe(false);
    const zip = await JSZip.loadAsync(
      await (await ws.readBlob(r.files.find((f) => f.format === 'zip').path)).arrayBuffer()
    );
    expect(await zip.file('assets/original.png').async('uint8array')).toEqual(new Uint8Array(fixture.bytes));
    expect(await zip.file('design.html').async('string')).not.toContain('<svg');
    const noDetect = {
      ...ctx,
      canvasRenderer: {
        ...serverCanvasRenderer,
        inspect: vi.fn(() => {
          throw new Error('不重复定位');
        })
      }
    };
    const updated = JSON.parse(
      await createVisualDemoTool(noDetect).run({
        source_path: r.designPath,
        canvas: { entries: canvasCopy.map((e, i) => (i ? e : { ...e, title: '改字沿用原槽' })) },
        path: '填字测试/同稿.html'
      })
    );
    expect(updated.status).toBe('complete');
    expect(visualSceneReceipt(true, JSON.stringify(updated)).state).toBe('completed');
    const saved = JSON.parse(await ws.readText(updated.designPath));
    expect(saved.regions).toEqual(source.regions);
    expect(saved.image).toEqual(source.image);
    expect(await ws.readText(r.designPath)).toBe(before);
    await ws.write(
      '填字测试/base.png',
      new Blob([canvasFixture({ width: 600, height: 900, left: 0.2 }).bytes], { type: 'image/png' })
    );
    await expect(loadCanvasText({ source_path: r.designPath }, {}, serverCanvasRenderer)).rejects.toMatchObject({
      code: 'CANVAS_IMAGE_CHANGED'
    });
  }, 30000);
  it('文字溢出仍有可编辑源稿/HTML，但没有最终PNG，也不能以去掉SVG假装通过', async () => {
    await ws.write('填字测试/长文.png', new Blob([fixture.bytes], { type: 'image/png' }));
    const r = JSON.parse(
      await createPosterTool(ctx).run({
        background_path: '填字测试/长文.png',
        canvas: { entries: canvasCopy.map((e, i) => (i ? e : { ...e, body: '全文不能隐藏'.repeat(200) })) }
      })
    );
    expect(r.status).toBe('partial');
    expect(r.designPath).toMatch(/canvas.json$/);
    expect(r.files.some((f) => f.format === 'html')).toBe(true);
    expect(r.files.some((f) => f.format === 'png')).toBe(false);
    expect(posterReceipt(true, JSON.stringify(r)).state).not.toBe('completed');
  }, 20000);
  it('同名导出互斥且不覆盖原图、当前稿与另一产物组', async () => {
    const d = base(),
      input = { path: '填字测试/并行.png' };
    const [a, b] = await Promise.all([claimCanvasName(input, d), claimCanvasName(input, d)]);
    expect(a.base).not.toBe(b.base);
    a.release();
    b.release();
    await expect(claimCanvasName({ path: d.image.path }, d)).rejects.toThrow(/覆盖/);
    await expect(
      claimCanvasName({ source_path: '填字测试/current.canvas.json', path: '填字测试/current.png' }, d)
    ).rejects.toThrow(/覆盖/);
  });
  it('明确原图填字走Canvas，原海报SVG回执、一般修图和方法问题保留原路线', () => {
    for (const q of [
      '把文字填入底图卡槽',
      '这张底图直接加字，保留全图',
      '不用SVG给海报加中文',
      '不用SVG直接在底图填字',
      '用稿.canvas.json补同稿Demo'
    ])
      expect(canvasTextRequest(q), q).toBe(true);
    for (const q of [
      '怎么在原图填字',
      '先不要在原图填字',
      '不用在底图填字',
      '原图填字怎么做',
      '底图填字需要视觉大模型吗',
      '请解释底图填字原理',
      '开发原图填字功能',
      '把人像自然美颜',
      '用GPT 2.6直接画整张带字海报'
    ])
      expect(canvasTextRequest(q), q).toBe(false);
    expect(textPosterRequest('把文字填入底图卡槽')).toBe(true);
    expect(mediaRequirement('把文字填入底图卡槽')).toMatchObject({ renderer: 'canvas', tool: 'make_poster' });
    const contract = taskContract('把文字填入底图卡槽');
    expect(contract.criteria.join('')).not.toContain('自包含可编辑SVG');
    expect(taskContract('制作一张海报').criteria.join('')).toContain('自包含可编辑SVG');
    expect(
      posterReceipt(
        true,
        JSON.stringify({
          kind: 'poster',
          status: 'complete',
          width: 600,
          height: 900,
          textRendering: 'program',
          fontCheck: 'passed',
          files: ['png', 'pptx'].map((format) => ({
            format,
            path: 'a.' + format,
            readback: 'passed',
            structure: 'passed',
            render: 'passed'
          })),
          errors: []
        })
      ).state
    ).not.toBe('completed');
  });
});
