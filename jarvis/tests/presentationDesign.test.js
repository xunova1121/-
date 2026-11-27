import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presentationRequest, presentationDesign } from '../src/agent/presentationDesign.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { createProfessionalDocumentTools } from '../src/agent/professionalDocumentTools.js';
import { createTools } from '../src/agent/tools.js';
import { createDocumentStyles } from '../src/agent/documentStyles.js';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import * as ws from '../src/agent/workspace.js';
import { inspectDocument } from '../src/agent/documentQuality.js';

let folder;
const content = '## 先整理，再协作\n\n把分散事项收进同一张清单。\n\n## 分工明确才好推进\n\n- 受理：登记需求\n- 分派：确认负责人\n- 复核：留下处理记录';
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-style-')); useBackend(createFileStore(folder)); });
afterEach(() => { useBackend(null); fs.rmSync(folder, { recursive: true, force: true }); });

it('否定与改口只作用于相应风格，正文出现风格名不改要求', async () => {
  expect(presentationRequest('不要简约，要商务风')).toEqual({ style: 'business', excluded: ['minimal'] });
  expect(presentationRequest('不要做成商务风，用电影感；改成极简\n# 材料\n国风文化')).toEqual({ style: 'minimal', excluded: ['business'] });
  expect(presentationRequest('不要极简，还是极简吧')).toEqual({ style: 'minimal', excluded: [] });
  expect(presentationRequest('不要商务风、国风，用极简')).toEqual({ style: 'minimal', excluded: ['business', 'story'] });
  const result = await presentationDesign({}, '不要简约', { format: 'pptx', style: 'minimal', title: '新品' });
  expect(result.style).not.toBe('minimal');
  await expect(presentationDesign({}, '不要商务风，不要极简，不要国风，不要数据风', { format: 'pptx' })).rejects.toMatchObject({ code: 'DOCUMENT_DESIGN' });
});
it('当前原话覆盖调用风格，PPT专用历史优先all，其他文种不污染且停止透传', async () => {
  const ctx = { documentStylePreferences: async () => '- all · 商务风\n- pptx · 国风\n- docx · 极简' };
  expect((await presentationDesign(ctx, '', { format: 'pptx' })).style).toBe('story');
  expect((await presentationDesign(ctx, '改成数据风', { format: 'pptx', style: 'minimal' })).style).toBe('data');
  expect((await presentationDesign(ctx, '不要国风', { format: 'pptx' })).style).not.toBe('story');
  expect((await presentationDesign({ documentStylePreferences: async () => '- all · 简洁一些' }, '', { format: 'pptx', title: '仙侠剧情' })).style).toBe('story');
  const controller = new AbortController(); controller.abort();
  await expect(presentationDesign(ctx, '', { format: 'pptx' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
it('真实工具从原话选风格，历史改变缓存失效；不指定页数也不偷加封面', async () => {
  let history = '- pptx · 数据风';
  const tool = createDocumentGenerateTool({ documentStylePreferences: async () => history });
  const args = { format: 'pptx', path: '样例.pptx', content, requirements: '制作PPT，不要封面', theme: 'business' };
  const first = await tool.run(args);
  expect(first).toContain('设计：数据报告');
  expect((await inspectDocument(await ws.readBlob(args.path), args.path)).slides).toBe(2);
  history = '- pptx · 国风';
  const second = await tool.run(args);
  expect(second).toContain('设计：叙事氛围'); expect(second).not.toContain('没有重新生成');
  const current = await tool.run({ ...args, style: 'story' }, { rawRequestText: '不要国风，这次用极简，不要封面' });
  expect(current).toContain('设计：简洁留白');
});
it('长期PPT构图偏好可保存并删除，不把Word简洁写作当PPT风格', async () => {
  const values = new Map();
  const prefs = createDocumentStyles({ store: { all: async () => [...values.values()], get: async id => values.get(id), put: async item => values.set(item.id, item), delete: async id => values.delete(id) } });
  await prefs.learn(['以后Word写得简洁一些', '以后PPT不要简约，用商务风']);
  expect(values.get('docstyle_pptx_presentation').content).toContain('用商务风');
  expect(values.has('docstyle_docx_presentation')).toBe(false);
  const ctx = { documentStylePreferences: prefs.context };
  expect((await presentationDesign(ctx, '', { format: 'pptx', title: '仙侠剧情' })).style).toBe('business');
  await prefs.remove('docstyle_pptx_presentation');
  expect((await presentationDesign(ctx, '', { format: 'pptx', title: '仙侠剧情' })).style).toBe('story');
});
it('专业文档保存并恢复PPT风格，不重复调用模型；公文主题冲突如实报告实际风格', async () => {
  let calls = 0;
  const tool = createProfessionalDocumentTools({ llm: async () => { calls++; return content; } }).find(item => item.name === 'write_professional_document');
  expect(tool.input_schema.properties.style.enum).toContain('story');
  const result = await tool.run({ task: '做两页PPT，不要封面', format: 'pptx', style: 'story', theme: 'business', path: '专业.pptx', depth: 'simple', research: false }, { sessionId: 'ppt-style' });
  expect(result).toContain('设计：叙事氛围');
  const check = JSON.parse(await ws.readText('文档检查/专业-pptx.json'));
  const stateFile = check.contentReview.workflowFile;
  expect(JSON.parse(await ws.readText(stateFile)).input.style).toBe('story');
  const resumed = await tool.run({ state_file: stateFile, path: '恢复.pptx', theme: 'business' }, { sessionId: 'ppt-style' });
  expect(resumed).toContain('设计：叙事氛围'); expect(calls).toBe(1);
  const official = await createDocumentGenerateTool({}).run({ format: 'pptx', path: '公文.pptx', theme: 'gongwen', style: 'story', content, requirements: '做两页PPT，不要封面' });
  expect(official).toContain('设计：稳重商务'); expect(official).toContain('未按请求风格生成');
  const officialCheck = JSON.parse(await ws.readText('文档检查/公文-pptx.json'));
  expect(officialCheck.design).toEqual({ requested: 'story', effective: 'business', state: 'conflict' });
  expect(officialCheck.errors).toBeGreaterThan(0);
  expect(official).not.toContain('直接告诉用户文件在哪');
});
it('自动设计的提醒缓存不能绕过后来明确风格的冲突验收', async () => {
  const tool = createDocumentGenerateTool({});
  const args = { format: 'pptx', path: '约束.pptx', title: '仙侠剧情', theme: 'gongwen', content, requirements: '做两页PPT，不要封面' };
  await tool.run(args);
  expect(JSON.parse(await ws.readText('文档检查/约束-pptx.json')).errors).toBe(0);
  const explicit = await tool.run({ ...args, style: 'story' });
  expect(explicit).not.toContain('没有重新生成');
  expect(JSON.parse(await ws.readText('文档检查/约束-pptx.json')).errors).toBeGreaterThan(0);
});
it('实际恢复收到“继续”或换风格仍保留原页数/不要封面，明确改口再加封面', async () => {
  let calls = 0;
  const tool = createTools({ llm: async () => { calls++; return content; } }).find(t => t.name === 'write_professional_document');
  await tool.run({ task: '做两页PPT，不要封面', format: 'pptx', style: 'story', path: '初稿.pptx', depth: 'simple', research: false }, { sessionId: 'ppt-resume' });
  const stateFile = JSON.parse(await ws.readText('文档检查/初稿-pptx.json')).contentReview.workflowFile;
  for (const request of ['继续', '改用极简']) {
    await tool.run({ state_file: stateFile, path: '再生成.pptx' }, { sessionId: 'ppt-resume', rawRequestText: request });
    const report = JSON.parse(await ws.readText('文档检查/再生成-pptx.json'));
    expect(report.slides).toBe(2); expect(report.expectedSlides).toBe(2);
    if (request === '改用极简') expect(report.design.effective).toBe('minimal');
  }
  await tool.run({ state_file: stateFile, path: '带封面.pptx' }, { sessionId: 'ppt-resume', rawRequestText: '这次加一页封面，总共3页' });
  const covered = JSON.parse(await ws.readText('文档检查/带封面-pptx.json'));
  expect(covered.slides).toBe(3); expect(covered.expectedSlides).toBe(3); expect(calls).toBe(1);
});
