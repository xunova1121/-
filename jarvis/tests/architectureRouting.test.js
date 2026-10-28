import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { strictArchitecture } from '../src/agent/diagramPlanning.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { parseFile } from '../src/agent/docs.js';

// 用户 2026-10-26～29 让未央画长江禁捕总体架构图，严格流水线连续五六次一张图都没出：
// 平时直接 create_diagram 出图，只有明说“逐条核对需求原文 / 严格审查”才走 build_architecture
describe('架构图走哪条路', () => {
  it('只有明确要逐条核对 / 严格审查才算严格模式', () => {
    for (const t of ['根据招标文件制作总体架构图，逐条核对需求原文', '画架构图，每个模块对应需求原文核对', '严格审查后出总体架构图']) expect(strictArchitecture(t), t).toBe(true);
    for (const t of ['做那个长江禁捕项目的架构图', '根据上传/招标文件.docx制作总体架构图。遇到失败保留真实错误阶段和已有文件。', '重新做这个架构图']) expect(strictArchitecture(t), t).toBe(false);
  });

  it('普通架构图请求：create_diagram 不再要求先走架构底稿；严格请求照旧要求', async () => {
    const tool = createDiagramTool({}, { requireArchitecture: 'strict' });
    const input = { path: '图/总体架构.svg', title: '总体架构', layers: [{ title: '应用层', nodes: [{ id: 'a', title: '业务应用' }] }] };
    const ordinary = await tool.run(input, { rawRequestText: '做那个长江禁捕项目的架构图' }).catch((e) => e);
    expect(ordinary?.code).not.toBe('ARCHITECTURE_PLAN_REQUIRED');
    await expect(tool.run(input, { rawRequestText: '制作总体架构图，逐条核对需求原文' })).rejects.toMatchObject({ code: 'ARCHITECTURE_PLAN_REQUIRED' });
  });
});

describe('后缀是 .doc 的 Word 文件', () => {
  it('其实是新版 Word（PK 开头）：按内容读出来；真正的老版 .doc 报清楚怎么另存', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第四章 采购需求：建设综合管理平台</w:t></w:r></w:p></w:body></w:document>');
    const blob = new Blob([await zip.generateAsync({ type: 'uint8array' })]);
    expect((await parseFile(blob, '上传/招标文件.doc')).text).toContain('建设综合管理平台');
    const ole = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]);
    await expect(parseFile(ole, '老文件.doc')).rejects.toThrow(/另存为.*docx/);
  });
});
