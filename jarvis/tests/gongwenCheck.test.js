/** 公文体检（智能体专业化第 1 批）：按文种规则确定性检查；生成 Word 时自动体检并把问题交回模型 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { checkGongwen, detectGongwenKind, gongwenIssueNote, createGongwenCheckTool } from '../src/agent/gongwenCheck.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { CORE } from '../src/agent/toolLoader.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';

const rules = (text, o) => checkGongwen(text, o).issues.map((x) => x.rule);
const GOOD_ASK = `关于举办春节书画展的请示\n\n区文旅局：\n\n为丰富群众节日文化生活，我馆拟于2027年2月举办春节书画展，需经费5万元。\n\n一、活动时间\n二、经费预算\n\n妥否，请批示。\n\n东湖区文化馆\n2026年11月5日`;

it('认文种：从标题末尾认出请示 / 批复 / 纪要等', () => {
  expect(detectGongwenKind(GOOD_ASK)).toBe('请示');
  expect(detectGongwenKind('# 关于同意拨付经费的批复\n\n正文')).toBe('批复');
  expect(detectGongwenKind('周例会纪要')).toBe('纪要');
  expect(detectGongwenKind('2026 年度工作总结')).toBe('');
});

it('合格的请示不报错', () => {
  expect(checkGongwen(GOOD_ASK).issues).toEqual([]);
});

it('请示：缺结语、多个主送机关都要指出', () => {
  const bad = GOOD_ASK.replace('妥否，请批示。', '以上。').replace('区文旅局：', '区文旅局、区财政局：');
  expect(rules(bad)).toEqual(expect.arrayContaining(['结语', '主送']));
});

it('报告夹带请示；批复不引来文、没有“此复”', () => {
  expect(rules('关于上半年安全生产工作的报告\n\n上半年……\n\n妥否，请批示。')).toContain('报告夹带请示');
  const reply = rules('关于同意拨付经费的批复\n\n同意拨付4万元。\n\n区文旅局\n2026年11月5日');
  expect(reply).toEqual(expect.arrayContaining(['引来文', '结语']));
  expect(checkGongwen('关于同意拨付经费的批复\n\n你馆《关于举办春节书画展的请示》收悉。经研究，同意拨付4万元。\n\n此复。\n\n区文旅局\n2026年11月5日').issues).toEqual([]);
});

it('层级编号跳号、成文日期写法、标题标点', () => {
  const t = '关于开展安全检查的通知。\n\n一、检查范围\n三、检查时间\n（一）第一阶段\n（三）第二阶段\n\n二〇二六年十一月五日';
  expect(rules(t)).toEqual(expect.arrayContaining(['层级编号', '成文日期', '标题']));
  expect(rules('关于开展安全检查的通知\n\n正文\n\n2026-11-05')).toContain('成文日期');
});

it('发文字号：本轮材料里没有就提醒，不能编；材料里有就不报', () => {
  const t = '关于开展安全检查的通知\n\n东政办发〔2026〕12号\n\n正文\n\n2026年11月5日';
  expect(rules(t, { sourceText: '帮我写通知' })).toContain('发文字号');
  expect(rules(t, { sourceText: '文号是东政办发〔2026〕12号' })).not.toContain('发文字号');
});

it('口语和网络用语、空附件、纪要用语', () => {
  expect(rules('关于开展活动的通知\n\n这次活动超级给力，大家一定要搞定！！\n\n附件：')).toEqual(expect.arrayContaining(['用语', '附件']));
  expect(rules('周例会纪要\n\n大家讨论了预算。')).toContain('纪要用语');
  expect(rules('周例会纪要\n\n会议议定：财务科下周完成预算初稿。')).not.toContain('纪要用语');
});

it('给模型的说明和工具：问题逐条列出；工具进核心目录和公文写作智能体', async () => {
  expect(gongwenIssueNote(checkGongwen('关于经费的报告\n\n请批准。'))).toMatch(/公文体检（报告）发现 \d+ 处问题/);
  expect(gongwenIssueNote({ issues: [] })).toBe('');
  const out = JSON.parse(await createGongwenCheckTool().run({ text: GOOD_ASK }));
  expect(out).toMatchObject({ kind: 'gongwen_check', doc_kind: '请示', issues: [] });
  expect(CORE).toContain('check_gongwen');
  expect(BUILTIN_AGENTS.find((p) => p.id === 'gongwen-writer').tools).toContain('check_gongwen');
});

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwen-check-')); useBackend(createFileStore(dir)); });
afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

it('生成公文 Word 时自动体检：有问题写进回执交回模型；普通文档不体检', async () => {
  const tool = createDocumentGenerateTool({});
  const bad = await tool.run({ format: 'docx', path: '请示.docx', title: '关于举办春节书画展的请示', theme: 'gongwen', content: '区文旅局、区财政局：\n\n我馆拟举办春节书画展，需经费5万元。\n\n东湖区文化馆\n2026年11月5日' }, { rawRequestText: '写一份请示' });
  expect(String(bad)).toMatch(/公文体检（请示）发现/);
  expect(String(bad)).toMatch(/主送/);
  const ok = await tool.run({ format: 'docx', path: '请示2.docx', title: '关于举办春节书画展的请示', theme: 'gongwen', content: GOOD_ASK.split('\n').slice(1).join('\n') }, { rawRequestText: '写一份请示' });
  expect(String(ok)).toMatch(/公文体检（请示）：文种、结语、编号、日期没发现问题/);
  const plain = await tool.run({ format: 'docx', path: '总结.docx', title: '年度工作总结', content: '## 一、主要工作\n\n完成了很多事。' }, { rawRequestText: '写总结' });
  expect(String(plain)).not.toMatch(/公文体检/);
});
