/** 第 1 批：Word 排版、主题、网页 / PDF、图片、create_document 新参数 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { IDBFactory } from 'fake-indexeddb';
import { parseDoc, headings } from '../src/agent/docModel.js';
import { pickTheme, findTheme, resolveTheme, THEMES, THEME_IDS } from '../src/agent/themes.js';
import { imageInfo } from '../src/agent/imageInfo.js';
import { generate, parseFile, htmlDocument } from '../src/agent/docs.js';
import { STABLE_PROMPT } from '../src/agent/agent.js';

const PNG_1x1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const unzip = async (blob) => {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = (f) => zip.file(f)?.async('string') ?? Promise.resolve('');
  const footers = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/footer\d*\.xml$/.test(f)).map(read));
  return { zip, doc: await read('word/document.xml'), styles: await read('word/styles.xml'), numbering: await read('word/numbering.xml'), rels: await read('word/_rels/document.xml.rels'), footers: footers.join('\n'), settings: await read('word/settings.xml') };
};

const REPORT = `# 2026 年第三季度工作总结

## 一、基本情况

本季度完成**主要目标**，*同比*增长 18%。详见[公司官网](https://example.com)。

## 二、主要成绩

1. 销售额 1200 万元
   - 华东 600 万
   - 华南 400 万
     - 深圳 250 万
2. 新客户 35 家

| 指标 | 目标 | 完成 |
|:--|:--:|--:|
| 销售额 | 1000 | 1200 |
| 客户数 | 30 | 35 |

> 说明：数据来自财务系统。

## 三、存在问题

- 回款周期偏长
- ~~人手不足~~ 已解决

[分页]

## 四、下一步计划

\`\`\`
第四季度：冲刺 1500 万
\`\`\`
`;

describe('文档结构解析', () => {
  it('多级列表、斜体、链接、删除线、引用、表格对齐、分页', () => {
    const d = parseDoc(REPORT);
    const list = d.find((b) => b.type === 'list' && b.ordered);
    expect(list.items[0].children[0]).toMatchObject({ type: 'list', ordered: false });
    expect(list.items[0].children[0].items[1].children[0].items[0].inlines[0].text).toBe('深圳 250 万');
    const p = d.find((b) => b.type === 'paragraph');
    expect(p.inlines).toEqual(expect.arrayContaining([expect.objectContaining({ text: '主要目标', bold: true }), expect.objectContaining({ text: '同比', italic: true }), expect.objectContaining({ text: '公司官网', link: 'https://example.com' })]));
    expect(d.find((b) => b.type === 'table').align).toEqual(['left', 'center', 'right']);
    expect(d.some((b) => b.type === 'quote')).toBe(true);
    expect(d.some((b) => b.type === 'pagebreak')).toBe(true);
    expect(headings(d).map((h) => h.level)).toEqual([1, 2, 2, 2, 2]);
    expect(parseDoc('![架构图](images/a.png)')[0]).toEqual({ type: 'image', src: 'images/a.png', alt: '架构图' });
  });
});

describe('Word 排版', () => {
  it('A4、标准页边距、1.5 倍行距、首行缩进、标题样式、真正的多级编号', async () => {
    const { blob, info } = await import('../src/agent/docxWriter.js').then((m) => m.makeDocx({ title: 'x', content: REPORT, theme: THEMES.business }));
    const x = await unzip(blob);
    expect(x.doc).toMatch(/<w:pgSz w:w="11906" w:h="16838"/); // A4
    expect(x.doc).toMatch(/w:top="1440"/);
    expect(x.doc).toMatch(/w:left="1803"/); // 3.18 cm
    expect(x.styles).toMatch(/w:line="360"/); // 1.5 倍行距
    expect(x.doc).toMatch(/w:firstLineChars="200"/);
    expect(x.styles).toMatch(/w:styleId="Heading1"/);
    expect(x.styles).toMatch(/w:eastAsia="微软雅黑"/);
    // 编号：项目符号 + 有序，多级
    expect(x.numbering).toContain('●');
    expect(x.numbering).toContain('○');
    expect(x.numbering).toMatch(/w:numFmt w:val="decimal"/);
    expect(x.doc).toMatch(/<w:ilvl w:val="2"\/>/); // 第三级
    expect(x.doc).not.toContain('• ');
    expect(info).toMatchObject({ toc: true, headings: 4 });
  });

  it('表格：边框、表头底色白字、表头跨页重复、对齐；斜体、链接、删除线、引用、代码、分页', async () => {
    const { blob } = await generate('docx', { title: 'x', content: REPORT, theme: 'ocean-depths' });
    const x = await unzip(blob);
    expect(x.doc).toMatch(/<w:tblHeader\/>/);
    expect(x.doc).toMatch(/w:fill="1A2332"/); // 主题深色主色做表头
    expect(x.doc).toMatch(/<w:color w:val="FFFFFF"\/>/);
    expect(x.doc).toMatch(/<w:tcBorders>/);
    expect(x.doc).toMatch(/<w:jc w:val="right"\/>/);
    expect(x.doc).toMatch(/<w:i\/>/);
    expect(x.doc).toMatch(/<w:strike\/>/);
    expect(x.doc).toMatch(/<w:hyperlink [^>]*r:id=/);
    expect(x.rels).toContain('https://example.com');
    expect(x.doc).toMatch(/<w:br w:type="page"\/>/);
    expect(x.doc).toContain('Consolas');
    // 读回文字
    const { text } = await parseFile(blob, 'r.docx');
    for (const w of ['2026 年第三季度工作总结', '深圳 250 万', '1200', '回款周期偏长', '冲刺 1500 万']) expect(text).toContain(w);
  });

  it('页脚页码、页眉标题、目录（二级标题 3 个以上才加）', async () => {
    const x = await unzip((await generate('docx', { title: 'x', content: REPORT })).blob);
    expect(x.footers).toMatch(/PAGE/);
    expect(x.footers).toMatch(/NUMPAGES/);
    expect(x.footers).toContain('第 ');
    expect(x.doc).toMatch(/TOC \\h \\o &quot;1-3&quot;/);
    expect(x.doc).toMatch(/<w:hyperlink [^>]*w:anchor="_Toc[^"]+"><w:r><w:t[^>]*>一、基本情况/); // 目录项已预先填好，WPS 不更新也能看到
    expect(x.doc).toContain('目　录');
    expect(x.settings).toMatch(/updateFields/);
    const short = await unzip((await generate('docx', { title: 'x', content: '# 短文\n\n## 一\n\n正文\n\n## 二\n\n正文' })).blob);
    expect(short.doc).not.toMatch(/TOC \\h/);
    const forced = await unzip((await generate('docx', { title: 'x', content: '## 一\n\n正文', toc: true })).blob);
    expect(forced.doc).toMatch(/TOC \\h/);
  });

  it('封面：标题、副标题、署名、日期，封面没有页码', async () => {
    const x = await unzip((await generate('docx', { title: '项目方案', content: '## 背景\n\n正文', cover: true, subtitle: '智慧园区一期', author: '信息中心', date: '2026 年 10 月 14 日' })).blob);
    for (const w of ['项目方案', '智慧园区一期', '信息中心', '2026 年 10 月 14 日']) expect(x.doc).toContain(w);
    expect((x.doc.match(/<w:sectPr/g) ?? []).length).toBe(2); // 封面单独一节
  });

  it('插入工作区图片：按版心缩放、带图注；找不到的用占位并报告', async () => {
    const { blob, info } = await generate('docx', {
      title: 'x', content: '## 架构\n\n![系统架构图](images/arch.png)\n\n![缺失](images/none.png)',
      loadImage: async (src) => (src === 'images/arch.png' ? PNG_1x1 : null)
    });
    const x = await unzip(blob);
    expect(Object.keys(x.zip.files).some((f) => /^word\/media\//.test(f))).toBe(true);
    expect(x.doc).toContain('图 1  系统架构图');
    expect(x.doc).toContain('［图片：缺失］');
    expect(info).toMatchObject({ images: 1, missingImages: ['images/none.png'] });
  });

  it('公文样式：公文页边距、仿宋三号、固定行距、黑体 / 楷体标题、“— 1 —”页码', async () => {
    const { blob, theme } = await generate('docx', { title: 'x', content: '# 关于开展安全检查的通知\n\n各部门：\n\n## 一、检查范围\n\n全体办公区域。\n\n### （一）重点部位\n\n机房。' });
    expect(theme.id).toBe('gongwen'); // 按标题自动识别
    const x = await unzip(blob);
    expect(x.doc).toMatch(/w:top="2098"/); // 37 mm
    expect(x.doc).toMatch(/w:left="1587"/); // 28 mm
    expect(x.styles).toMatch(/w:eastAsia="仿宋"/);
    expect(x.styles).toMatch(/w:eastAsia="黑体"/);
    expect(x.styles).toMatch(/w:eastAsia="楷体"/);
    expect(x.styles).toMatch(/w:line="579" w:lineRule="exact"/);
    expect(x.styles).toMatch(/<w:sz w:val="32"\/>/); // 三号
    expect(x.footers).toContain('— ');
  });
});

describe('排版细节（看过渲染效果后补的）', () => {
  const NOTICE = '# 关于开展安全检查的通知\n\n各部门：\n\n## 一、范围\n\n正文\n\n## 二、内容\n\n正文\n\n## 三、要求\n\n1. 自查\n\n公司办公室\n2026 年 10 月 14 日';
  it('公文：不自动加目录；称呼顶格；落款右对齐；编号像正文一样缩进', async () => {
    const x = await unzip((await generate('docx', { title: 'x', content: NOTICE })).blob);
    expect(x.doc).not.toMatch(/TOC \\h/);
    const salutation = x.doc.match(/<w:p>(?:(?!<\/w:p>).)*各部门：/s)[0];
    expect(salutation).not.toMatch(/firstLine/);
    const sign = x.doc.match(/<w:p>(?:(?!<w:p>).)*2026 年 10 月 14 日/s)[0];
    expect(sign).toMatch(/<w:jc w:val="right"\/>/);
    expect(x.numbering).toMatch(/<w:suff w:val="nothing"\/>/);
    const html = htmlDocument('x', NOTICE, { theme: THEMES.gongwen });
    expect(html).not.toContain('<nav class="toc">');
    expect(html).toContain('<p class="salutation">各部门：</p>');
    expect(html).toMatch(/<p class="signature">公司办公室<br>2026 年 10 月 14 日<\/p>/);
  });

  it('有目录时顺序是：标题 → 目录 → 正文；正文首行缩进同时写字符数和绝对值', async () => {
    const x = await unzip((await generate('docx', { title: 'x', content: REPORT })).blob);
    expect(x.doc.indexOf('2026 年第三季度工作总结')).toBeLessThan(x.doc.indexOf('目　录'));
    expect(x.doc).toMatch(/w:firstLine="480" w:firstLineChars="200"|w:firstLineChars="200" w:firstLine="480"/);
  });

  it('表格列宽按内容分：短的数字列窄、长的文字列宽', async () => {
    const md = '| 编号 | 说明 |\n|--|--|\n| 1 | 这是一段比较长的说明文字，用来测试列宽分配是否合理 |';
    const x = await unzip((await generate('docx', { title: 'x', content: md })).blob);
    const [a, b] = [...x.doc.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(b).toBeGreaterThan(a * 3);
  });
});

describe('主题', () => {
  it('10 套 theme-factory 主题 + 商务蓝 + 公文；按 id 或中文名找', () => {
    expect(THEME_IDS).toHaveLength(12);
    expect(findTheme('深海').id).toBe('ocean-depths');
    expect(findTheme('tech-innovation').name).toBe('科技创新');
    expect(findTheme('不存在')).toBeNull();
  });

  it('按内容自动选：财务 → 深海，AI → 科技创新，环保 → 森林，公文 → 公文，其他 → 商务蓝', () => {
    expect(pickTheme('# 2026 年度财务分析报告\n营收、投资回报').id).toBe('ocean-depths');
    expect(pickTheme('# 大模型产品发布方案\nAI 能力').id).toBe('tech-innovation');
    expect(pickTheme('# ESG 与碳中和报告').id).toBe('forest-canopy');
    expect(pickTheme('# 关于召开年度工作会议的通知').id).toBe('gongwen');
    expect(pickTheme('请按公文格式写一份请示').id).toBe('gongwen');
    expect(pickTheme('# 周末读书笔记').id).toBe('business');
    expect(resolveTheme('golden-hour', '财务').id).toBe('golden-hour'); // 指定的优先
  });
});

describe('网页 / PDF', () => {
  it('同一套主题、目录锚点、图片内嵌、链接只允许 http(s)、内容转义', () => {
    const html = htmlDocument('x', `${REPORT}\n\n[点我](javascript:alert(1))\n\n<script>alert(1)</script>\n\n![图](a.png)`, { theme: THEMES['ocean-depths'], printable: true, images: new Map([['a.png', 'data:image/png;base64,AAAA']]) });
    expect(html).toContain('--accent:#2D8B8B');
    expect(html).toContain('<nav class="toc">');
    expect(html).toMatch(/<h1 id="s1">一、基本情况<\/h1>/);
    expect(html).toContain('href="#s1"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('javascript:alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('@bottom-center');
    expect(html).toContain('class="page-break"');
  });

  it('桌面版：直接出 PDF 文件；网页版：可打印网页加说明', async () => {
    let got = '';
    const pdf = await generate('pdf', { title: '报告', content: REPORT, toPdf: async (html) => { got = html; return new TextEncoder().encode('%PDF-1.7 test'); } });
    expect(pdf.ext).toBe('pdf');
    expect(pdf.blob.type).toBe('application/pdf');
    expect(got).toContain('@page{size:A4');
    const web = await generate('pdf', { title: '报告', content: REPORT });
    expect(web.ext).toBe('html');
    expect(web.note).toContain('导出 PDF');
  });
});

describe('图片尺寸', () => {
  it('PNG / JPEG / GIF 读出格式和宽高；不是图片返回 null', () => {
    expect(imageInfo(PNG_1x1)).toEqual({ type: 'png', width: 1, height: 1 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    expect(imageInfo(jpg)).toEqual({ type: 'jpg', width: 800, height: 600 });
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 0x40, 1, 0xf0, 0, ...new Array(20).fill(0)]);
    expect(imageInfo(gif)).toEqual({ type: 'gif', width: 320, height: 240 });
    expect(imageInfo(new TextEncoder().encode('hello world, not an image at all'))).toBeNull();
  });
});

describe('create_document 工具', () => {
  let tools;
  let ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
    tools = (await import('../src/agent/tools.js')).createTools({});
  });
  afterEach(() => { delete globalThis.indexedDB; });
  const run = (args) => tools.find((t) => t.name === 'create_document').run(args);

  it('主题、封面、目录说明、工作区图片、缺失图片提示都写进结果', async () => {
    await ws.write('images/chart.png', new Blob([PNG_1x1]));
    const r = await run({ format: 'docx', path: '报告/季度总结', content: `${REPORT}\n\n![销售趋势](images/chart.png)\n\n![没有](images/x.png)`, theme: 'ocean-depths', cover: true });
    expect(r).toMatch(/^报告\/季度总结\.docx/);
    expect(r).toContain('主题：深海');
    expect(r).toContain('已加目录');
    expect(r).toContain('images/x.png');
    expect(await ws.exists('报告/季度总结.docx')).toBe(true);
  });

  it('工具说明里列出主题、Markdown 写法；模板不存在时报错', async () => {
    const t = tools.find((x) => x.name === 'create_document');
    expect(t.description).toContain('gongwen');
    expect(t.description).toContain('[分页]');
    expect(t.input_schema.properties.theme.enum).toContain('ocean-depths');
    await expect(run({ format: 'docx', path: 'a', content: '正文', template: '模板/没有.docx' })).rejects.toThrow(/找不到模板/);
  });
});

describe('说明书', () => {
  it('聊天回答：结论先行、要点简练；写文档有单独要求', () => {
    expect(STABLE_PROMPT).toMatch(/聊天回答按下面“回答的样子”来写；写文档.*不受这条限制/);
    expect(STABLE_PROMPT).toContain('## 回答的样子');
    expect(STABLE_PROMPT).toMatch(/结论放第一行/);
    expect(STABLE_PROMPT).toMatch(/2–5 条短要点/);
    expect(STABLE_PROMPT).toContain('## 写文档');
    expect(STABLE_PROMPT).toMatch(/层级不跳级/);
  });
});
