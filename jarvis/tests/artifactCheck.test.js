import {describe,it,expect,beforeAll} from 'vitest';
import {generate} from '../src/agent/docs.js';
import {checkArtifact} from '../src/agent/artifactCheck.js';
import {DOCUMENT_TEMPLATES,documentTemplate} from '../src/agent/documentTemplates.js';
beforeAll(()=>Promise.all([import('exceljs'),import('xlsx'),import('pptxgenjs')]),60000);
describe('模板与真实文件读回',()=>{
 it('PPT/Word/Excel都有模板、结构和可追溯检查要求',()=>{
  for(const format of ['pptx','docx','xlsx'])expect(DOCUMENT_TEMPLATES.some(t=>t.format===format)).toBe(true);
  for(const t of DOCUMENT_TEMPLATES){const data=JSON.parse(documentTemplate(t.id));expect(data.outline.length).toBeGreaterThan(3);expect(data.rules.length).toBeGreaterThan(1);}
  expect(()=>documentTemplate('unknown')).toThrow();
 });
 it.each(['docx','pptx','xlsx'])('%s检查生成的实际ZIP和正文，不冒称实际渲染',async format=>{
  const content=format==='xlsx'?'## 明细\n项目,金额\n产品,100\n服务,200':'# 季度报告\n\n## 核心结论\n收入增长，资料来自实际台账。';
  const out=await generate(format,{title:'验收报告',content});const check=await checkArtifact(out.blob,'验收.'+out.ext);
  expect(check.structure).toBe('passed');expect(check.readback).toBe('passed');expect(check.render).toBe('not_checked');
 });
 it('空文件、伪PDF和伪Office不能通过',async()=>{
  await expect(checkArtifact(new Blob([]),'a.docx')).rejects.toThrow('为空');
  await expect(checkArtifact(new Blob(['not pdf']),'a.pdf')).rejects.toThrow('PDF');
  await expect(checkArtifact(new Blob(['not zip']),'a.docx')).rejects.toThrow();
 });
});
