import { describe, it, expect } from 'vitest';
import { generate, parseFile, splitSlides, parseSheets, markdownToHtml, htmlToText } from '../src/agent/docs.js';

const MD = '# 季度报告\n\n本季度**收入**增长。\n\n## 明细\n\n| 项目 | 金额 |\n| --- | --- |\n| 产品 | 120 |\n| 服务 | 80 |\n\n- 要点一\n- 要点二';

describe('文档生成与读取（往返）', () => {
  it('Word：生成后能读回文字与表格内容', async () => {
    const { blob, ext } = await generate('docx', { title: '季度报告', content: MD });
    expect(ext).toBe('docx');
    const { text } = await parseFile(blob, 'r.docx');
    for (const w of ['季度报告', '收入', '明细', '产品', '120', '要点二']) expect(text).toContain(w);
  });

  it('PPT：按标题分页，读回每页内容', async () => {
    const { blob } = await generate('pptx', { title: '方案', content: '# 背景\n- 市场扩大\n# 目标\n- 增长 30%' });
    const { text } = await parseFile(blob, 'p.pptx');
    expect(text).toContain('第 1 页幻灯片');
    expect(text).toContain('方案');
    expect(text).toContain('市场扩大');
    expect(text).toContain('增长 30%');
  });

  it('Excel：多工作表、数字列为数值', async () => {
    const { blob } = await generate('xlsx', { content: '## 收入\n月份,金额\n1月,100\n2月,"1,200"\n## 成本\n| 月份 | 金额 |\n| -- | -- |\n| 1月 | 60 |' });
    const { text } = await parseFile(blob, 's.xlsx');
    expect(text).toContain('工作表：收入');
    expect(text).toContain('2月,"1,200"');
    expect(text).toContain('工作表：成本');
    expect(parseSheets('a,b\n1,2')[0].rows[1]).toEqual([1, 2]);
  });

  it('PDF：生成可打印 HTML，并附说明', async () => {
    const r = await generate('pdf', { title: '报告', content: MD });
    expect(r.ext).toBe('html');
    expect(r.note).toContain('导出 PDF');
    const html = await r.blob.text();
    expect(html).toContain('@page');
    expect(html).toContain('<table>');
  });

  it('HTML 里的模型输出被转义', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toContain('&lt;script&gt;');
    expect(htmlToText('<p>a</p><script>x</script><p>b&amp;c</p>')).toBe('a\nb&c');
  });

  it('幻灯片拆分：无标题的开头归入首页，--- 分页', () => {
    const s = splitSlides('总标题', '开场白\n---\n# 第二页\n1. 甲\n2. 乙');
    expect(s).toEqual([{ title: '总标题', lines: ['开场白'] }, { title: '第二页', lines: ['甲', '乙'] }]);
  });

  it('不支持的格式给出明确错误', async () => {
    await expect(parseFile(new Blob(['x']), 'a.exe')).rejects.toThrow('暂不支持');
  });
});
