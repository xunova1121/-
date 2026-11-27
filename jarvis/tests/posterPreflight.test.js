import { beforeEach, expect, it, vi } from 'vitest';
import { useBackend, collection } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { prepareFreeLayerDesign } from '../src/agent/layeredDesignPreflight.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { fitDesignText, normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { checkDesignPresentation } from '../src/agent/layeredDesignPresentation.js';
import { checkLayerOverlap } from '../src/agent/layeredDesignQuality.js';
import { loadLayerDesign } from '../src/agent/layeredDesignSource.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { compactPosterModelReceipt } from '../src/agent/posterModelReceipt.js';
import { createTurnArchive } from '../src/agent/turnContext.js';
import { projectLookupMessages } from '../src/agent/requestContext.js';
import { composePosterLayout, wrapParagraphs } from '../src/agent/posterComposition.js';
import { samples as originalPosterSamples } from '../e2e/fixtures/poster-composition.mjs';

const text = (id, copy, y, changes = {}) => ({ id, type: 'text', x: 64, y, w: 900, h: 40, text: copy, fontSize: 40, minFontSize: 40, role: 'body', ...changes });
const draft = () => ({ width: 1080, height: 3860, design: { layout: 'free', reading: 'phone', layers: [
  text('title', 'Claude Fable 5.1 提示词结构观察', 100, { h: 150, fontSize: 72, minFontSize: 72, role: 'heading' }),
  text('chip', 'legal_and_financial_advice', 800, { w: 380, h: 35, fontSize: 34, minFontSize: 34 }),
  text('number', '128.3456789', 1400, { h: 35, fontSize: 48, minFontSize: 48 }),
  text('footer', '来源：第三方材料，真实性尚未获官方证实。\n仅作设计方法观察，不作为产品规则。\n检查保留全部原文，不删除或编造来源。', 3500, { h: 140 })
] } });
beforeEach(async () => {
  useBackend(null);
  for (const name of ['files', 'kv', 'sessions']) await collection(name).clear();
});

it('同一请求补齐唯一标题并适配长英文/数字/三行页脚，无需四轮模型猜高度', () => {
  const input = draft(), original = structuredClone(input);
  const result = prepareFreeLayerDesign(input);
  expect(result.design.title).toBe(input.design.layers[0].text);
  expect(result.preflight.status).toBe('passed');
  expect(result.preflight.adjustments.map(n => n.id)).toEqual(['title', 'chip', 'number', 'footer']);
  expect(checkDesignPresentation(result.design).status).toBe('passed');
  expect(checkLayerOverlap(result.design).status).toBe('passed');
  expect([result.design.width, result.design.height]).toEqual([1080, 3860]);
  for (const node of result.design.layers) {
    const before = input.design.layers.find(n => n.id === node.id);
    expect([node.x, node.y, node.w, node.text]).toEqual([before.x, before.y, before.w, before.text]);
    expect(fitDesignText(node).rows.join('')).toBe(before.text.replace(/\n/g, ''));
  }
  expect(input).toEqual(original);
});
it('结构出错仍一次给出其它文字框问题，不先改圆角再逐项暴露溢出', () => {
  const input = draft();
  input.design.layers[0].id = 'main';
  input.design.layers.push({ id: 'card', type: 'shape', x: 500, y: 1700, w: 200, h: 100, radius: 100 });
  let failure;
  try { prepareFreeLayerDesign(input); } catch (error) { failure = error; }
  expect(failure.issues.some(issue => issue.field === 'title')).toBe(true);
  for (const id of ['chip', 'number', 'footer', 'card']) expect(failure.issues.some(issue => issue.id === id)).toBe(true);
  expect(failure.issues.find(issue => issue.id === 'footer').minimumHeight).toBeGreaterThan(140);
});
it('小字号不靠原框硬缩，按同一手机阅读标准调大', () => {
  const input = draft();
  input.design.layers[1] = text('section-heading', '清晰的栏目标题', 800, { fontSize: 41, minFontSize: 32, role: 'heading' });
  const result = prepareFreeLayerDesign(input);
  expect(fitDesignText(result.design.layers[1]).fontSize * 390 / 1080).toBeGreaterThanOrEqual(18);
});
it.each(['shape', 'image', 'chart', 'text', 'icon'])('文字增高不跨入下方%s，即使它只是装饰元素', type => {
  const input = draft();
  input.design.layers.push({ id: 'blocker', type, x: 64, y: 1436, w: 900, h: 200, fill: '#FFFFFF', text: '其它内容', fontSize: 40,
    asset: 'photo', icon: 'star', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], decorative: true });
  expect(() => prepareFreeLayerDesign(input)).toThrow(/number/);
});
it('在底图上的原文字框不扩张到未知主体，卡片承载框不允许越界', () => {
  for (const type of ['image', 'shape']) {
    const input = draft();
    input.design.layers.unshift({ id: 'background', type, x: 50, y: 1390, w: 950, h: type === 'image' ? 300 : 50, asset: 'photo', decorative: true });
    expect(() => prepareFreeLayerDesign(input)).toThrow(/number/);
  }
});
it('strict与旧源稿的changes不偷偷移动其它内容，完整重新构图才使用安全适配', async () => {
  const input = draft();
  expect(() => prepareFreeLayerDesign({ ...input, design: { ...input.design, text_fit: 'strict' } })).toThrow();
  const source = prepareFreeLayerDesign(input).design;
  const path = '测试/已有.design.json';
  await ws.write(path, JSON.stringify(source));
  const saved = await ws.readText(path);
  const unchanged = await loadLayerDesign({ source_path: path });
  expect(unchanged.design).toEqual(source);
  await expect(loadLayerDesign({ source_path: path, changes: [{ id: 'footer', text: '不允许删掉的完整长文。'.repeat(50) }] })).rejects.toHaveProperty('code', 'DESIGN_TEXT_OVERFLOW');
  const reflow = await loadLayerDesign({ source_path: path, design: input.design });
  expect(reflow.preflight.status).toBe('passed');
  expect(await ws.readText(path)).toBe(saved);
});
it('失败回执保留全部可操作字段与具体最小值，通过实际2000字符发送投影', async () => {
  const input = draft();
  input.design.layers[0].id = 'main';
  const renderVisualScene = vi.fn(), visionLlm = vi.fn();
  const value = JSON.parse(await createPosterTool({ renderVisualScene, visionLlm }).run(input, { executionScope: {} }));
  expect(value.delivery).toMatchObject({ attempts: 0, corrections: 1, retryAllowed: true });
  expect(value.preflight.issues.length).toBeGreaterThanOrEqual(4);
  const message = { role: 'tool', name: 'make_poster', toolCallId: 'first', content: JSON.stringify(value) };
  const archive = createTurnArchive();
  const compact = compactPosterModelReceipt(message, archive);
  expect(compact.length).toBeLessThanOrEqual(2000);
  const receipt = JSON.parse(compact);
  expect(receipt.preflight.omitted).toBe(0);
  expect(receipt.preflight.issues.find(issue => issue.id === 'footer').minimumHeight).toBeGreaterThan(140);
  const projected = projectLookupMessages([message], { enabled: true, archive });
  expect(JSON.parse(projected.messages[0].content).preflight.issues).toEqual(receipt.preflight.issues);
  expect(JSON.parse((await archive.tool.run({ result_id: receipt.receiptId, max_chars: 12000 }))).text).toBe(message.content);
  expect(renderVisualScene).not.toHaveBeenCalled();
  expect(visionLlm).not.toHaveBeenCalled();
  expect(await ws.list()).toEqual([]);
});
it('大量错误仍有界且明确标记未展开项，不能把残缺清单伪称全部', () => {
  const input = { title: '全部检查', width: 1080, height: 3860, design: { layout: 'free', text_fit: 'strict', layers: Array.from({ length: 100 }, (_, i) => text('problem-' + i, '完整原文'.repeat(8), 20 * i, { w: 60, h: 20 })) } };
  let error;
  try { planLayerDesign(input); } catch (caught) { error = caught; }
  expect(error.issueCount).toBe(100);
  expect(error.issues).toHaveLength(100);
  const compact = compactPosterModelReceipt({ name: 'make_poster', content: JSON.stringify({ kind: 'poster', status: 'partial', files: [], errors: [], preflight: { status: 'failed', issueCount: error.issueCount, issues: error.issues } }) });
  expect(compact.length).toBeLessThanOrEqual(2000);
  const receipt = JSON.parse(compact);
  expect(receipt.preflight.omitted + receipt.preflight.issues.length).toBe(100);
  expect(receipt.guidance).toContain('完整清单');
});
it('规范化不改变原稿严格校验，坏尺寸/复杂字形/非法字号仍拒绝', () => {
  const input = draft();
  for (const change of [{ x: -1 }, { h: 9999 }, { fontSize: 0 }, { text: '复杂\u093f' }]) {
    input.design.layers[1] = { ...draft().design.layers[1], ...change };
    expect(() => prepareFreeLayerDesign(input)).toThrow();
  }
  expect(() => normalizeLayerDesign({ ...prepareFreeLayerDesign(draft()).design, title: '' })).toThrow(/标题/);
});
it.each(['identity_and_style', 'tools_and_delivery', 'uncertainty_handling', 'legal_and_financial_advice'])('长英文在词边界折行，不能把单词剁成碎片：%s', copy => {
  const rows = wrapParagraphs(copy, 34, 416, { wordWrap: true });
  expect(rows.join('')).toBe(copy);
  let offset = 0;
  for (const row of rows.slice(0, -1)) {
    offset += row.length;
    expect(copy[offset - 1] === '_' || copy[offset] === '_').toBe(true);
  }
});
it('中文尾行不会只剩“骤，”；数字/单位仍原样成组保留', () => {
  const copy = '把复杂任务拆成清楚的步骤，';
  const rows = wrapParagraphs(copy, 34, 440, { wordWrap: true });
  expect(rows.join('')).toBe(copy);
  expect(rows.at(-1)).not.toMatch(/^.{1,3}$/u);
  expect(wrapParagraphs('比例1/5，风速6.8m/s，数值128.3456789。', 34, 440, { wordWrap: true }).join('')).toBe('比例1/5，风速6.8m/s，数值128.3456789。');
});
it('分层稿的按词折行不重排原宋体海报，既有文字位置和字号不回退', () => {
  const layout = composePosterLayout(originalPosterSamples.find(sample => sample.id === 'square-long-serif'));
  expect(layout.blocks[0].rowTexts).toEqual(['秋季养生汤：把一整个秋', '天的温润与暖意盛进碗里']);
  expect(layout.blocks[0].fontSize).toBe(87.271);
  expect(layout.blocks[1].y).toBe(813.07);
});
