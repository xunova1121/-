import { it, expect, vi } from 'vitest';
import * as workspace from '../src/agent/workspace.js';
import { validateSvg } from '../src/agent/svgPreview.js';
import { imageFormat, assertImageExtension } from '../src/agent/imageFormat.js';
import { createRenderDiagramTool, reviewDiagram } from '../src/agent/diagramReview.js';
import { createInspectImageTool } from '../src/agent/inspectImage.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramRoutes } from '../src/agent/diagramRoutes.js';
import { diagramSvg } from '../src/agent/diagramSvg.js';
import { createTools } from '../src/agent/tools.js';
import { cropImageRegion as cropOnServer } from '../server/imageRegion.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#123456"/></svg>';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mQAAAAASUVORK5CYII=';
const png = () => new Blob([Uint8Array.from(atob(PNG), (letter) => letter.charCodeAt(0))], { type: 'image/png' });

it('按内容识别伪JPG中的SVG，阻止写出和改出伪位图', async () => {
  const svg = new Blob([SVG], { type: 'image/jpeg' });
  expect(await imageFormat(svg)).toEqual({ ext: 'svg', mime: 'image/svg+xml' });
  expect(await imageFormat(new Blob(['<!DOCTYPE svg>' + SVG]))).toMatchObject({ ext: 'svg' });
  await expect(assertImageExtension('伪图.jpg', svg)).rejects.toMatchObject({ code: 'IMAGE_FORMAT_MISMATCH' });
  const write = createTools({}).find((tool) => tool.name === 'write_file');
  await expect(write.run({ path: '格式错误.jpg', content: SVG })).rejects.toMatchObject({ code: 'IMAGE_FORMAT_MISMATCH' });
  expect(await workspace.exists('格式错误.jpg')).toBe(false);
  await expect(write.run({ path: '文本冒充.png', content: PNG })).rejects.toMatchObject({ code: 'IMAGE_BINARY_WRITE' });
  await workspace.write('原有伪图.jpg', SVG);
  const edit = createTools({}).find((tool) => tool.name === 'edit_file');
  await expect(edit.run({ path: '原有伪图.jpg', edits: [{ old_text: '#123456', new_text: '#ffffff' }] })).rejects.toThrow('不是文本文件');
  expect(await workspace.readText('原有伪图.jpg')).toBe(SVG);
});

it('SVG安全子集拒绝外链、脚本、实体、动画及超大画布', () => {
  for (const addition of [
    '<script/>',
    '<image href="https://outside.example/x"/>',
    '<g onclick="alert(1)"/>',
    '<animate/>',
    '<g style="fill:url(https://outside.example/x)"/>',
    '<g style="fill:red"/>',
    String.raw`<g fill="u\72l(file:///etc/passwd)"/>`,
    '<g xml:base="https://outside.example/"/>',
    '<text>&#65;</text>'
  ]) {
    expect(() => validateSvg(SVG.replace('</svg>', addition + '</svg>'))).toThrow();
  }
  expect(() => validateSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + SVG)).toThrow();
  expect(() => validateSvg(SVG.replace('width="400"', 'width="12001"'))).toThrow();
  const checked = validateSvg(SVG);
  expect(checked).toMatchObject({ width: 600, height: 300 });
  expect(checked.svg).toContain('viewBox="0 0 400 200"');
});

it('已有源图确切路径进入渲染、真实PNG读回及视觉检查，不选最新图', async () => {
  await workspace.write('图形旧版.svg', SVG);
  await workspace.write('图形新版.svg', SVG.replace('#123456', '#ffffff'));
  const renderSvg = vi.fn(async (source) => {
    expect(source).toBe(SVG);
    return png();
  });
  const visionLlm = vi.fn(async ({ images }) => {
    expect(images[0]).toEqual({ mime: 'image/png', data: PNG });
    return '{"passed":true,"issues":[]}';
  });
  const retrieval = { consume: vi.fn() };
  const result = await createRenderDiagramTool({ renderSvg, visionLlm }).run({ path: '图形旧版.svg' }, { rawRequestText: '请检查图形旧版.svg', retrieval });
  expect(result).toContain('图形旧版-预览.png');
  expect(result).toContain('"visual":"passed"');
  expect(await imageFormat(await workspace.readBlob('图形旧版-预览.png'))).toMatchObject({ ext: 'png' });
  expect(await workspace.readText('图形旧版.svg')).toBe(SVG);
  expect(renderSvg).toHaveBeenCalledTimes(1);
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(retrieval.consume).toHaveBeenCalledWith('model');
  expect(retrieval.consume.mock.invocationCallOrder[0]).toBeLessThan(visionLlm.mock.invocationCallOrder[0]);
  await expect(createRenderDiagramTool({ renderSvg }).run({ path: '图形新版.svg' }, { rawRequestText: '请查看 [旧版](图形旧版.svg)' })).rejects.toMatchObject({
    code: 'DIAGRAM_TARGET_MISMATCH'
  });
  expect(renderSvg).toHaveBeenCalledTimes(1);
});

it('误标JPG的SVG能在复核入口真正渲染，视觉与OCR读的是PNG', async () => {
  await workspace.write('错误后缀图.jpg', SVG);
  const renderSvg = vi.fn(async () => png());
  const visionLlm = vi.fn(async ({ images }) => {
    expect(images[0].data).toBe(PNG);
    return '图中文字可读，未核实业务真实性';
  });
  const ocr = vi.fn(async ({ blob }) => {
    expect((await imageFormat(blob)).ext).toBe('png');
    return { text: '架构图', model: 'fixture' };
  });
  const result = await createInspectImageTool({ renderSvg, visionLlm, ocr }).run({ path: '错误后缀图.jpg', question: '检查实际布局' });
  expect(result).toContain('实际渲染为PNG');
  expect(renderSvg).toHaveBeenCalledTimes(1);
  expect(await workspace.readText('错误后缀图.jpg')).toBe(SVG);
  const read = createTools({ renderSvg }).find((tool) => tool.name === 'read_file');
  const readback = await read.run({ path: '错误后缀图.jpg' });
  expect(readback.images[0]).toMatchObject({ mime: 'image/png', data: PNG });
});

it('渲染失败或伪PNG不发视觉请求；视觉格式异常不算通过', async () => {
  await workspace.write('复核失败.svg', SVG);
  const visionLlm = vi.fn(async () => '没问题');
  const tool = createRenderDiagramTool({ renderSvg: async () => new Blob([SVG], { type: 'image/png' }), visionLlm });
  await expect(tool.run({ path: '复核失败.svg' })).rejects.toMatchObject({ code: 'SVG_RENDER_INVALID' });
  expect(visionLlm).not.toHaveBeenCalled();
  expect(await workspace.exists('复核失败-预览.png')).toBe(false);
  const result = await reviewDiagram({ renderSvg: async () => png(), visionLlm }, { path: '复核失败.svg', svg: SVG });
  expect(result).toMatchObject({ render: 'passed', visual: 'not_checked' });
  expect(result.note).toContain('格式无效');
});

it('渲染停止与视觉预算错误上抛，结构文件和已完成预览保留', async () => {
  const input = { path: '半成品图.svg', title: '架构', layers: [{ title: '设备层', nodes: [{ id: 'a', title: '雷达' }] }] };
  const budget = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
  const controller = new AbortController();
  const cancelled = createDiagramTool({
    renderSvg: async () => {
      controller.abort();
      throw controller.signal.reason;
    }
  });
  await expect(cancelled.run(input, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await workspace.exists(input.path)).toBe(true);
  const visionLlm = vi.fn();
  await expect(
    createDiagramTool({ renderSvg: async () => png(), visionLlm }).run(
      { ...input, path: '预算图.svg' },
      {
        retrieval: {
          consume: () => {
            throw budget;
          }
        }
      }
    )
  ).rejects.toBe(budget);
  expect(visionLlm).not.toHaveBeenCalled();
  expect(await workspace.exists('预算图-预览.png')).toBe(true);
});

it('布局紧凑且没有左侧共线，跨层关系去重并避开中间节点', () => {
  const model = layoutDiagram({
    title: '布局检查',
    layers: Array.from({ length: 4 }, (_, row) => ({
      title: '层级' + row,
      nodes: Array.from({ length: 4 }, (_, col) => ({ id: `${row}-${col}`, title: '节点', detail: '明确职责与输入输出' }))
    })),
    edges: [
      { from: '0-0', to: '3-2' },
      { from: '0-0', to: '3-2' },
      { from: '0-1', to: '1-2' }
    ]
  });
  expect(model.height).toBeLessThan(900);
  expect(model.edges).toHaveLength(2);
  for (const edge of diagramRoutes(model)) {
    for (let index = 1; index < edge.points.length; index++) {
      const a = edge.points[index - 1];
      const b = edge.points[index];
      expect(a.x === b.x || a.y === b.y).toBe(true);
      for (const node of model.nodes.filter((node) => node.id !== edge.from && node.id !== edge.to)) {
        const through =
          a.x === b.x
            ? a.x > node.x && a.x < node.x + node.width && Math.max(a.y, b.y) > node.y && Math.min(a.y, b.y) < node.y + node.height
            : a.y > node.y && a.y < node.y + node.height && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < node.x + node.width;
        expect(through, `${edge.from}→${edge.to}穿过${node.id}`).toBe(false);
      }
    }
  }
  expect(diagramSvg(model)).not.toContain('H44');
});

it('检查期间原图发生变化不能把旧预览当新版验收', async () => {
  await workspace.write('检查中变更.svg', SVG);
  const result = await reviewDiagram(
    {
      renderSvg: async () => png(),
      visionLlm: async () => {
        await workspace.write('检查中变更.svg', SVG.replace('#123456', '#ffffff'));
        return '{"passed":true,"issues":[]}';
      }
    },
    { path: '检查中变更.svg', svg: SVG }
  );
  expect(result).toMatchObject({ render: 'passed', visual: 'not_checked', sourceChanged: true });
});

it('服务器解码器之前拒绝未知格式和带实体声明的伪图片', async () => {
  const region = { x: 0, y: 0, width: 1, height: 1 };
  await expect(cropOnServer(new Blob(['not-an-image']), region)).rejects.toMatchObject({ code: 'IMAGE_FORMAT' });
  await expect(cropOnServer(new Blob(['<!DOCTYPE svg>' + SVG]), region)).rejects.toMatchObject({ code: 'SVG_UNSAFE' });
});

it('模型画的海报 / 信息卡 SVG：阴影滤镜、蒙版这类静态效果放行；外部资源、脚本、样式表和行内 style 照样拦，报错提醒不要改原文件', async () => {
    const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><defs><filter id="s"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity="0.3"/></filter></defs><rect width="600" height="800" fill="#0b2545"/><g filter="url(#s)"><rect x="40" y="120" width="520" height="160" rx="16" fill="#fff" opacity="0.95"/></g><text x="300" y="80" text-anchor="middle" font-size="36" fill="#fff">今日新闻速览</text></svg>';
    expect(validateSvg(poster)).toMatchObject({ width: 900, height: 1200 });
    expect(() => validateSvg(poster.replace('<defs>', '<defs><style>rect{fill:red}</style>'))).toThrow(/不要为了转换修改原文件/);
    expect(() => validateSvg(poster.replace('opacity="0.95"', 'fill="url(https://x.example/a.png)"'))).toThrow(/外部资源/);
    expect(() => validateSvg(poster.replace('opacity="0.95"', 'style="opacity:0.95"'))).toThrow(/直接写成属性/);
    expect(() => validateSvg(poster.replace('<rect width', '<script>alert(1)</script><rect width'))).toThrow();
  });
