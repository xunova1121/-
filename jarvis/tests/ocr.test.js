/** 文字识别（智谱 GLM-OCR）：截图、扫描件、表格照片里的字原样抄出来；全部用假接口 */
import { describe, it, expect, vi } from 'vitest';
import { ocrLine, recognizeText } from '../src/llm/ocr.js';
import { abilityLines } from '../src/llm/abilities.js';
import { createOcrTool } from '../src/agent/ocrTool.js';
import { createImageSight, WANTS_TEXT } from '../src/agent/imageSight.js';
import * as ws from '../src/agent/workspace.js';

const USER = { provider: 'deepseek', models: { deepseek: 'deepseek-v4-pro' }, keys: { deepseek: 'sk-d', zhipu: 'zp' }, baseURLs: {} };
const IMG = { mime: 'image/png', data: 'iVBORw0KGgo=' };

describe('用谁识别', () => {
  it('填了智谱：能力表“文字识别”自动用 glm-ocr；没填就没有', () => {
    expect(abilityLines(USER, 'ocr').main).toEqual({ provider: 'zhipu', model: 'glm-ocr' });
    expect(ocrLine(USER)).toEqual({ provider: 'zhipu', model: 'glm-ocr' });
    expect(ocrLine({ provider: 'deepseek', models: {}, keys: { deepseek: 'k' } })).toBeNull();
  });
});

describe('调智谱的文档解析接口', () => {
  it('发到 layout_parsing，带 glm-ocr 和 base64 文件，读回 md_results', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ md_results: '| 品名 | 单价 |\n| --- | --- |\n| 苹果 | 5 |' }));
    };
    const r = await recognizeText(USER, IMG, { fetchImpl });
    expect(r).toEqual({ text: '| 品名 | 单价 |\n| --- | --- |\n| 苹果 | 5 |', model: 'glm-ocr' });
    expect(calls[0]).toEqual({ url: 'https://open.bigmodel.cn/api/paas/v4/layout_parsing', auth: 'Bearer zp', body: { model: 'glm-ocr', file: 'data:image/png;base64,iVBORw0KGgo=' } });
  });
  it('出错、没有内容、没配智谱：说清楚', async () => {
    await expect(recognizeText(USER, IMG, { fetchImpl: async () => new Response(JSON.stringify({ error: { message: '文件格式不支持' } }), { status: 400 }) })).rejects.toThrow('文件格式不支持');
    await expect(recognizeText(USER, IMG, { fetchImpl: async () => new Response(JSON.stringify({ md_results: '' })) })).rejects.toThrow('没有返回内容');
    await expect(recognizeText({ provider: 'deepseek', models: {}, keys: { deepseek: 'k' } }, IMG)).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
  });
});

describe('工具：识别工作区里的图片', () => {
  it('读出文件交给文字识别；没有文字识别时如实说', async () => {
    await ws.write('uploads/报价单.png', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
    const ocr = vi.fn(async () => ({ text: '报价单：苹果 5 元', model: 'glm-ocr' }));
    const out = await createOcrTool({ ocr }).run({ path: 'uploads/报价单.png' });
    expect(out).toContain('报价单：苹果 5 元');
    expect(ocr.mock.calls[0][0].mime).toBe('image/png');
    await expect(createOcrTool({}).run({ path: 'uploads/报价单.png' })).rejects.toThrow('智谱');
    await expect(createOcrTool({ ocr }).run({ path: 'a.docx' })).rejects.toThrow('只能识别');
  });
});

describe('发图要提取文字：先抄字再回答', () => {
  it('要的是字：附上识别结果；只问画面不识别；历史里的图不重复识别', async () => {
    expect(WANTS_TEXT.test('把这张图里的表格整理成 Excel')).toBe(true);
    expect(WANTS_TEXT.test('这张图的场景描述一下')).toBe(false);
    const readText = vi.fn(async () => ({ text: '苹果 5 元', model: 'glm-ocr' }));
    const describe = vi.fn(async () => '一张报价单照片');
    const see = createImageSight({ model: 'deepseek-v4-pro', describe, readText });
    const now = { role: 'user', content: '把这张图里的表格整理成 Excel', images: [IMG] };
    await see(now, { hint: now.content, ocr: true });
    expect(now.content).toContain('苹果 5 元');
    expect(now.content).toContain('一张报价单照片');
    const old = { role: 'user', content: '之前的图', images: [IMG] };
    await see(old, { hint: '把这张图里的表格整理成 Excel', ocr: false });
    expect(readText).toHaveBeenCalledTimes(1);
    const scene = { role: 'user', content: '描述一下', images: [IMG] };
    await see(scene, { hint: '这张图的场景描述一下', ocr: true });
    expect(readText).toHaveBeenCalledTimes(1);
  });
  it('主模型自己能看图：也附上识别出的字（读字更准），图片保留', async () => {
    const see = createImageSight({ model: 'gpt-6-luna', readText: async () => ({ text: '合计 1,200 元', model: 'glm-ocr' }) });
    const m = { role: 'user', content: '提取图里的文字', images: [IMG] };
    await see(m, { hint: m.content, ocr: true });
    expect(m.content).toContain('合计 1,200 元');
    expect(m.images).toEqual([IMG]);
  });
});
