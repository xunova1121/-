/** 第 3 批：Excel（ExcelJS：样式、格式、公式、CSV 带 BOM）和 PPT（多种版式） */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { IDBFactory } from 'fake-indexeddb';
import { typed, makeXlsx, makeCsv } from '../src/agent/xlsxWriter.js';
import { layoutOf, parseSlides, makePptx } from '../src/agent/pptxWriter.js';
import { generate, parseFile } from '../src/agent/docs.js';
import { THEMES } from '../src/agent/themes.js';

beforeAll(() => Promise.all([import('exceljs'), import('xlsx'), import('pptxgenjs')]), 60_000);

const PNG_1x1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const readBook = async (blob) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  return wb;
};

describe('Excel：识别格式', () => {
  it('千分位、百分数、金额、日期、公式；以 0 开头的编号保持文字', () => {
    expect(typed('1,200')).toEqual({ value: 1200, numFmt: '#,##0' });
    expect(typed('1200.5')).toEqual({ value: 1200.5, numFmt: '#,##0.00' });
    expect(typed('18%')).toEqual({ value: 0.18, numFmt: '0%' });
    expect(typed('18.5%')).toMatchObject({ value: 0.185, numFmt: '0.0%' });
    expect(typed('¥1,200.50')).toEqual({ value: 1200.5, numFmt: '"¥"#,##0.00' });
    expect(typed('300元')).toMatchObject({ value: 300 });
    expect(typed('2026-10-14').value).toEqual(new Date(Date.UTC(2026, 9, 14)));
    expect(typed('2026年10月14日').numFmt).toBe('yyyy-mm-dd');
    expect(typed('=SUM(B2:B5)')).toEqual({ formula: 'SUM(B2:B5)' });
    expect(typed('007')).toEqual({ value: '007' });
    expect(typed('')).toEqual({ value: null });
  });
});

describe('Excel：样式和公式', () => {
  const SALES = `## 季度销售
| 区域 | 2025年 | 2026年 | 同比增长 |
|--|--|--|--|
| 华东 | 500 | 612 |  |
| 华南 | 360 | 418 |  |
| 合计 |  |  |  |

## 目标完成
| 指标 | 目标 | 实际 | 完成率 |
|--|--|--|--|
| 销售额 | 1,000 | 1,236 |  |
| 回款率 | 90% | 92% |  |

## 自定义
| 项目 | 金额 |
|--|--|
| A | 10 |
| B | 20 |
| 两倍合计 | =2*SUM(B2:B3) |`;

  it('表头样式、冻结首行、筛选、列宽、数字格式', async () => {
    const { blob, info } = await makeXlsx(SALES, { theme: THEMES['ocean-depths'] });
    const wb = await readBook(blob);
    const ws = wb.getWorksheet('季度销售');
    const h = ws.getCell('A1');
    expect(h.font.bold).toBe(true);
    expect(h.fill.fgColor.argb).toBe('FF2D8B8B');
    expect(h.font.color.argb).toBe('FFFFFFFF');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual(8);
    expect(ws.getCell('B2').value).toBe(500);
    expect(ws.getCell('B2').numFmt).toBe('#,##0');
    expect(ws.getCell('A2').border.top.style).toBe('thin');
    expect(info.sheets).toBe(3);
  });

  it('合计行自动写 SUM 公式；同比按年份认出本期、上期；完成率 = 实际 / 目标；都带算好的结果', async () => {
    const wb = await readBook((await makeXlsx(SALES, { theme: THEMES.business })).blob);
    const s = wb.getWorksheet('季度销售');
    expect(s.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 860 });
    expect(s.getCell('C4').value).toEqual({ formula: 'SUM(C2:C3)', result: 1030 });
    expect(s.getCell('D2').value.formula).toBe('IFERROR((C2-B2)/B2,"")');
    expect(s.getCell('D2').value.result).toBeCloseTo(0.224);
    expect(s.getCell('D2').numFmt).toBe('0.0%');
    expect(s.getCell('D4').value.formula).toBe('IFERROR((C4-B4)/B4,"")'); // 合计行的同比
    expect(s.getCell('D4').value.result).toBeCloseTo((1030 - 860) / 860); // 用合计算出来的结果
    const g = wb.getWorksheet('目标完成');
    expect(g.getCell('D2').value.formula).toBe('IFERROR(C2/B2,"")');
    expect(g.getCell('D2').value.result).toBeCloseTo(1.236);
    expect(g.getCell('B3').numFmt).toBe('0%');
    const c = wb.getWorksheet('自定义');
    expect(c.getCell('B4').value).toMatchObject({ formula: '2*SUM(B2:B3)' }); // 自己写的公式保留
  });

  it('Excel / WPS 打开时重新计算全部公式', async () => {
    const zip = await JSZip.loadAsync(await (await makeXlsx(SALES, { theme: THEMES.business })).blob.arrayBuffer());
    expect(await zip.file('xl/workbook.xml').async('string')).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
  });

  it('本期 / 上期写在表头里也能认出', async () => {
    const wb = await readBook((await makeXlsx('| 月份 | 上期 | 本期 | 环比 |\n|--|--|--|--|\n| 9月 | 80 | 100 |  |', { theme: THEMES.business })).blob);
    expect(wb.worksheets[0].getCell('D2').value.formula).toBe('IFERROR((C2-B2)/B2,"")');
  });

  it('贾维斯读回：看到的是算好的数（原来的读取功能不受影响）', async () => {
    const { blob } = await generate('xlsx', { content: SALES });
    const { text } = await parseFile(blob, 's.xlsx');
    expect(text).toContain('工作表：季度销售');
    expect(text).toMatch(/合计,860,"?1,030"?/);
    expect(text).toContain('工作表：目标完成');
  });

  it('CSV：带 UTF-8 BOM，含逗号的单元格加引号', async () => {
    const blob = makeCsv('| 名称 | 金额 |\n|--|--|\n| 甲,乙 | 1,200 |');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await blob.text()).toContain('"甲,乙","1,200"');
    const r = await generate('csv', { content: 'a,b\n1,2' });
    expect(r.ext).toBe('csv');
  });
});

describe('PPT 版式', () => {
  const DECK = `# 2026 年度经营汇报

## 第一部分 年度回顾

## 核心数据
- 1,236 万元 全年销售额
- 35 家 新签客户
- 92% 客户续约率

## 主要工作
- 完成华东、华南两大区域布局
  - 华东 612 万
- 上线智能终端产品线
- 建立代理商体系

## 方案对比
### 自建团队
- 可控性强
- 成本高
### 外包合作
- 上线快
- 依赖供应商

## 区域业绩
| 区域 | 2025年 | 2026年 |
|--|--|--|
| 华东 | 500 | 612 |
| 华南 | 360 | 418 |

备注：这一页重点讲华东的增长原因

## 组织架构
| 部门 | 负责人 | 职责 |
|--|--|--|
| 市场部 | 王敏 | 品牌与推广 |

## 产品展示
- 智能终端 A1
![产品外观](images/a1.png)

## 谢谢`;

  it('按内容选版式', () => {
    const slides = parseSlides('汇报', DECK);
    expect(slides.map((s, i) => layoutOf(s, { last: i === slides.length - 1 }))).toEqual(['section', 'section', 'stats', 'bullets', 'compare', 'chart', 'table', 'imageText', 'end']);
  });

  it('生成：封面 + 各页、图表、表格、图片、演讲者备注、主题配色', async () => {
    const { blob, info } = await makePptx({ title: '汇报', content: DECK, theme: THEMES['tech-innovation'], subtitle: '经营管理部', loadImage: async (src) => (src === 'images/a1.png' ? PNG_1x1 : null) });
    expect(info.layouts[0]).toBe('cover');
    expect(info.slides).toBe(9); // 第一个“# 标题”没有内容，当封面
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const files = Object.keys(zip.files);
    expect(files.some((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))).toBe(true);
    expect(files.some((f) => /^ppt\/media\//.test(f))).toBe(true);
    expect(files.some((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f))).toBe(true);
    const all = (await Promise.all(files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => zip.file(f).async('string')))).join('');
    expect(all).toContain('0066FF'); // 主题强调色
    expect(all).toContain('<a:tbl>');
    expect(all).toContain('经营管理部');
    const notes = (await Promise.all(files.filter((f) => /notesSlide\d+\.xml$/.test(f)).map((f) => zip.file(f).async('string')))).join('');
    expect(notes).toContain('重点讲华东的增长原因');
    expect(all).not.toContain('重点讲华东的增长原因'); // 备注不上屏
    const { text } = await parseFile(blob, 'd.pptx');
    for (const w of ['2026 年度经营汇报', '1,236 万元', '可控性强', '外包合作', '王敏', '谢谢']) expect(text).toContain(w);
  });

  it('要点超过 7 条自动拆页（续）；找不到的图片用占位并报告', async () => {
    const many = `## 工作清单\n${Array.from({ length: 10 }, (_, i) => `- 事项 ${i + 1}`).join('\n')}\n\n## 图\n![缺图](none.png)`;
    const { blob, info } = await makePptx({ title: 't', content: many, theme: THEMES.business });
    expect(info.slides).toBe(4); // 封面 + 两页清单 + 图
    expect(info.missingImages).toEqual(['none.png']);
    const { text } = await parseFile(blob, 'd.pptx');
    expect(text).toContain('工作清单（续）');
    expect(text).toContain('事项 10');
  });
});

describe('写 CSV 文件自动加 BOM', () => {
  let tools;
  let ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
    tools = (await import('../src/agent/tools.js')).createTools({});
  });
  afterEach(() => { delete globalThis.indexedDB; });

  it('write_file 写 .csv 时加 BOM，其他文件不加', async () => {
    const run = (args) => tools.find((t) => t.name === 'write_file').run(args);
    await run({ path: 'a.csv', content: '名称,金额\n甲,1' });
    await run({ path: 'a.txt', content: '名称' });
    expect([...new Uint8Array(await (await ws.readBlob('a.csv')).arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect([...new Uint8Array(await (await ws.readBlob('a.txt')).arrayBuffer()).slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});
