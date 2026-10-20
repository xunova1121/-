import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DOCUMENT_TEMPLATES } from '../src/agent/documentTemplates.js';
import { planDocument } from '../src/agent/documentPlan.js';
import { generate, parseFile } from '../src/agent/docs.js';
import { inspectDocument, inspectWorkbook } from '../src/agent/documentQuality.js';
import { editOffice } from '../src/agent/officeEdit.js';
import { editSpreadsheet } from '../src/agent/spreadsheetEdit.js';
import { orderedSlidePaths, openOfficePackage } from '../src/agent/officePackage.js';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

let directory;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-document-quality-'));
  useBackend(createFileStore(directory));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(directory, { recursive: true, force: true });
});
const tool = (toolName, context = {}) => createTools(context).find(item => item.name === toolName);
const deck = '## 第一页\n同样的名称用于核对。\n\n## 第二页\n同样的名称用于核对。';
const table = '## 明细\n| 项目 | 金额 |\n|--|--|\n| 甲 | 10 |\n| 乙 | 20 |\n| 合计 | =SUM(B2:B3) |';

describe('制作方案与模板', () => {
  it('12套不同用途配方都有骨架、规则；主题不是模板数量', () => {
    expect(DOCUMENT_TEMPLATES).toHaveLength(12);
    expect(new Set(DOCUMENT_TEMPLATES.map(item => item.id)).size).toBe(12);
    for (const item of DOCUMENT_TEMPLATES) {
      expect(item.starter).toContain('## ');
      expect(item.rules.length).toBeGreaterThan(1);
    }
  });
  it('按场景选择，明确来源索引不等于核实', () => {
    expect(planDocument({format:'pptx',task:'冷链经营业绩汇报'}).templateId).toBe('ppt-business');
    expect(planDocument({format:'docx',task:'项目建议书'}).templateId).toBe('word-proposal');
    const plan = planDocument({format:'xlsx',task:'月度绩效考核'});
    expect(plan.templateId).toBe('excel-assessment');
    expect(plan.limits.join('')).toContain('不代表已读取');
  });
  it('显式模板跨格式不允许，来源和目标长度有界', () => {
    expect(() => planDocument({format:'xlsx',template_id:'ppt-product'})).toThrow(/不匹配/);
    const plan = planDocument({format:'docx',task:'a'.repeat(9000),sources:Array(30).fill('x'.repeat(1000))});
    expect(plan.objective).toHaveLength(2000);
    expect(plan.sources).toHaveLength(12);
    expect(plan.sources[0]).toHaveLength(300);
  });
  it('显式配方真实应用主题；用户显式主题仍优先', async () => {
    const result = await tool('create_document').run({format:'pptx',path:'技术',title:'技术方案',content:deck,template_id:'ppt-product'});
    expect(result).toContain('科技创新');
    expect(result).toContain('产品与技术方案');
    const report = JSON.parse(await (await ws.readBlob('技术.pptx.检查.json')).text());
    expect(report.templateId).toBe('ppt-product');
    expect(report.visual).toBe('not_checked');
    expect(report.render).toBe('not_checked');
  });
});

describe('真实产物检查与半成品', () => {
  it('读回工作簿公式，指出错误而非仅判断文件存在', async () => {
    const out = await generate('xlsx',{content:table.replace('SUM(', 'SUMM(')});
    const report = await inspectDocument(out.blob,'表.xlsx');
    expect(report.errors).toBeGreaterThan(0);
    expect(report.formulaCheck).toBe('static_checked_not_recalculated');
    expect(report.facts).toBe('not_verified');
  });
  it('缺图不能被标为无错误', async () => {
    const out = await generate('docx',{content:'# 报告\n\n正文用于文件检查。\n\n![证据图](missing.png)'});
    const report = await inspectDocument(out.blob,'报告.docx',{info:out.info});
    expect(report.errors).toBeGreaterThan(0);
  });
  it('格式损坏与过大包有类型，不返回成功', async () => {
    await expect(inspectDocument(new Blob(['bad']),'损坏.docx')).rejects.toMatchObject({code:'DOCUMENT_PACKAGE'});
    await expect(openOfficePackage({byteLength:21e6})).rejects.toMatchObject({code:'DOCUMENT_SIZE'});
  });
  it('渲染出错仍保留文件与报告，真实转换状态标失败', async () => {
    const result = await tool('create_document',{officeRender:async () => {throw Object.assign(new Error('转换失败'),{code:'RENDER_FAILED'});}}).run({format:'docx',path:'保留',content:'# 报告\n\n已经完成的内容要保留。'});
    expect(await ws.exists('保留.docx')).toBe(true);
    const report = JSON.parse(await (await ws.readBlob('保留.docx.检查.json')).text());
    expect(report.render).toBe('failed');
    expect(result).toContain('转换失败');
  });
  it('渲染阶段取消立即上抛；保存的产物先有短回执且不含正文', async () => {
    const controller = new AbortController();
    const receipts=[];
    const run = tool('create_document',{officeRender:async () => {controller.abort();throw new DOMException('stop','AbortError');}}).run({format:'docx',path:'中断',content:'# 报告\n\n秘密正文不进入检查点。'}, {signal:controller.signal,checkpoint:async event => receipts.push(event)});
    await expect(run).rejects.toMatchObject({name:'AbortError'});
    expect(await ws.exists('中断.docx')).toBe(true);
    expect(receipts[0].validation.readback).toBe('passed');
    expect(JSON.stringify(receipts)).not.toContain('秘密正文');
  });
  it('预算信号不被可选渲染吞掉', async () => {
    await expect(tool('create_document',{officeRender:async () => {throw Object.assign(new Error('budget'),{code:'RETRIEVAL_BUDGET'});}}).run({format:'docx',path:'预算',content:'# 报告\n\n预算停止仍上抛控制信号。'})).rejects.toMatchObject({code:'RETRIEVAL_BUDGET'});
  });
  it('独立重新检查不修改原文件、不创建副本', async () => {
    const out = await generate('docx',{content:'# 报告\n\n需要保留原文件的有效正文。'});
    await ws.write('原件.docx',out.blob);
    const result = JSON.parse(await tool('check_document').run({path:'原件.docx',required_text:['有效正文','不存在的文字']}));
    expect(result.issues.some(item=>item.text.includes('不存在的文字'))).toBe(true);
    expect((await ws.list()).map(item=>item.path)).toEqual(['原件.docx']);
  });
});

describe('PPT按实际页码修改', () => {
  it('重新排序后只修改指定的真实页，其他部件逐字保留', async () => {
    const out = await generate('pptx',{title:'测试',content:deck});
    const zip = await openOfficePackage(out.blob);
    const xml = await zip.file('ppt/presentation.xml').async('string');
    const ids = [...xml.matchAll(/<p:sldId\b[^>]*\/?\s*>/g)].map(match=>match[0]);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    zip.file('ppt/presentation.xml',xml.replace(ids.join(''),[...ids].reverse().join('')));
    const reordered = new Blob([await zip.generateAsync({type:'uint8array'})]);
    const before = await openOfficePackage(reordered);
    const paths = await orderedSlidePaths(before);
    const edited = await editOffice(reordered,'pptx',{slides:[1],replacements:[{find:'同样的名称',replace:'限定修改'}],expectedCount:1});
    const after = await openOfficePackage(edited.blob);
    expect(await after.file(paths[0]).async('string')).toContain('限定修改');
    for (const entry of Object.values(before.files).filter(item=>!item.dir && item.name!==paths[0])) {
      expect(await after.file(entry.name).async('uint8array')).toEqual(await entry.async('uint8array'));
    }
  });
  it('页码错误、匹配次数冲突不保存', async () => {
    const out = await generate('pptx',{content:deck});
    await expect(editOffice(out.blob,'pptx',{slides:[999],replacements:[]})).rejects.toMatchObject({code:'DOCUMENT_SCOPE'});
    await expect(editOffice(out.blob,'pptx',{replacements:[{find:'同样的名称',replace:'错改'}],expectedCount:1})).rejects.toMatchObject({code:'DOCUMENT_CONFLICT'});
  });
});

describe('Excel精确修改', () => {
  it('改指定格保留样式与其他部件；清除公式缓存并要求重算', async () => {
    const out = await generate('xlsx',{content:table});
    const before = await openOfficePackage(out.blob);
    const edited = await editSpreadsheet(out.blob,[{sheet:'明细',cell:'B2',expected:10,value:30}]);
    const parsed = await inspectWorkbook(edited.blob);
    expect(parsed.book.Sheets['明细'].B2.v).toBe(30);
    expect(parsed.book.Sheets['明细'].B3.v).toBe(20);
    expect(parsed.book.Sheets['明细'].B4.f).toBe('SUM(B2:B3)');
    const after = await openOfficePackage(edited.blob);
    expect(await after.file('xl/styles.xml').async('string')).toBe(await before.file('xl/styles.xml').async('string'));
    expect(await after.file('xl/workbook.xml').async('string')).toContain('fullCalcOnLoad="1"');
  });
  it('旧值冲突整批失败，原Blob没有变化', async () => {
    const out = await generate('xlsx',{content:table});
    await expect(editSpreadsheet(out.blob,[{sheet:'明细',cell:'B2',value:30},{sheet:'明细',cell:'B3',expected:999,value:40}])).rejects.toMatchObject({code:'DOCUMENT_CONFLICT'});
    expect((await inspectWorkbook(out.blob)).book.Sheets['明细'].B2.v).toBe(10);
  });
  it('不把等号文字当公式，非法和外部访问公式被拒绝', async () => {
    const out = await generate('xlsx',{content:table});
    const edited = await editSpreadsheet(out.blob,[{sheet:'明细',cell:'A2',value:'=不是公式'}]);
    expect((await inspectWorkbook(edited.blob)).book.Sheets['明细'].A2).toMatchObject({v:'=不是公式',t:'s'});
    for (const formula of ['SUMM(B2:B3)','B4+1','WEBSERVICE("https://example.com")']) {
      await expect(editSpreadsheet(out.blob,[{sheet:'明细',cell:'B4',formula}])).rejects.toMatchObject({code:'DOCUMENT_FORMULA'});
    }
  });
  it('工具实际写盘后重新读回，并留备份', async () => {
    const out = await generate('xlsx',{content:table});
    await ws.write('表.xlsx',out.blob);
    const result = await tool('edit_spreadsheet').run({path:'表.xlsx',edits:[{sheet:'明细',cell:'B2',expected:10,value:50}]});
    expect(result).toContain('已修改1个单元格');
    expect((await parseFile(await ws.readBlob('表.xlsx'),'表.xlsx')).text).toContain('50');
    expect(await ws.exists('表.xlsx.检查.json')).toBe(true);
  });
  it('开始前取消不解包、不修改', async () => {
    const controller = new AbortController();controller.abort();
    await expect(editSpreadsheet(new Blob(['invalid']),[{sheet:'a',cell:'B2',value:1}],{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
  });
});
