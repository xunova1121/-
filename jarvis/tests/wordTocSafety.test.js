import { it, expect } from 'vitest';
import { generate } from '../src/agent/docs.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { refreshWordToc } from '../src/agent/wordTableOfContents.js';
import { inspectEditableDocument, applyStructuredEdits } from '../src/agent/structuredDocumentEdit.js';
import { parseXml, wordText, descendants, serialize, element, NS, children } from '../src/agent/documentXml.js';
const source = async () =>
  (await generate('docx', { title: '合成目录', content: '# 第一章\n\n正文甲。\n\n# 第二章\n\n正文乙。\n\n# 第三章\n\n正文丙。', toc: true })).blob;
it('新增Word属性遵循OOXML顺序，分节和修订仍在末尾', () => {
  const doc = parseXml(`<w:pPr xmlns:w="${NS.w}"><w:jc w:val="both"/><w:sectPr/></w:pPr>`);
  element(doc.documentElement, 'w', 'spacing');
  element(doc.documentElement, 'w', 'keepNext');
  expect(children(doc.documentElement).map((n) => n.localName)).toEqual(['keepNext', 'spacing', 'jc', 'sectPr']);
});
it('目录容器夹带正文不能整块替换', async () => {
  const zip = await openOfficePackage(await source());
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace('</w:sdtContent>', '<w:p><w:r><w:t>必须保留的额外正文</w:t></w:r></w:p></w:sdtContent>');
  zip.file('word/document.xml', xml);
  const blob = new Blob([await zip.generateAsync({ type: 'uint8array' })]);
  await expect(
    refreshWordToc(
      {
        officeRender: () => {
          throw new Error('不应调用渲染');
        }
      },
      blob
    )
  ).rejects.toThrow('目录域外还有正文');
});
it('自定义目录域不静默改为默认规则', async () => {
  const zip = await openOfficePackage(await source());
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('TOC ', 'TOC \\n '));
  await expect(
    refreshWordToc(
      {
        officeRender: () => {
          throw new Error('不应调用渲染');
        }
      },
      new Blob([await zip.generateAsync({ type: 'uint8array' })])
    )
  ).rejects.toThrow('自定义域规则');
});
it('纯正文格式编辑不改变目录缓存的XML', async () => {
  const b = await source(),
    s = await inspectEditableDocument(b, 'docx');
  const r = await applyStructuredEdits(b, 'docx', [{ action: 'format', target: { role: 'body' }, properties: { font_size: 18 } }], {
    expectedDigest: s.sha256
  });
  const toc = async (blob) => serialize(descendants(parseXml(await (await openOfficePackage(blob)).file('word/document.xml').async('string')), 'w', 'sdt')[0]);
  expect(await toc(r.blob)).toBe(await toc(b));
});
it('无标题文档可通过明确选择建立标题层级而不改文字', async () => {
  const b = (await generate('docx', { title: '样例', content: '第一部分\n\n需要保留的内容。', toc: false })).blob,
    s = await inspectEditableDocument(b, 'docx');
  const r = await applyStructuredEdits(b, 'docx', [{ action: 'format', target: { text: '第一部分' }, properties: { heading_level: 1 } }], {
    expectedDigest: s.sha256
  });
  const next = await inspectEditableDocument(r.blob, 'docx');
  expect(next.objects.find((o) => o.text === '第一部分')).toMatchObject({ role: 'heading', level: 1 });
});
it('正文批量改字号保留空白分页和分节控制段落', async () => {
  const b = await source();
  const s = await inspectEditableDocument(b, 'docx');
  const controls = async (blob) =>
    descendants(parseXml(await (await openOfficePackage(blob)).file('word/document.xml').async('string')), 'w', 'p')
      .filter((p) => !wordText(p).trim())
      .map(serialize);
  const before = await controls(b);
  expect(before.length).toBeGreaterThan(0);
  const r = await applyStructuredEdits(b, 'docx', [{ action: 'format', target: { role: 'body' }, properties: { font_size: 20, line_spacing: 1.5 } }], {
    expectedDigest: s.sha256
  });
  expect(await controls(r.blob)).toEqual(before);
});
