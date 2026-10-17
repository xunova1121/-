/** 生成后检查：Excel 公式（引用、函数名、除零、循环引用），查出问题请模型改一轮再生成 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { makeXlsx } from '../src/agent/xlsxWriter.js';
import { checkFormulas, refsOf, sheetLayout } from '../src/agent/formulaCheck.js';
import { THEMES } from '../src/agent/themes.js';

beforeAll(() => Promise.all([import('exceljs'), import('pptxgenjs')]), 60_000);

const sheet = (name, rows) => {
  const cells = new Map();
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === undefined) return;
    cells.set(`${String.fromCharCode(65 + c)}${r + 1}`, typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : { value: v });
  }));
  return { name, cells, rows: rows.length, cols: Math.max(...rows.map((r) => r.length)) };
};

describe('Excel 公式检查', () => {
  it('认出引用：工作表名、$ 绝对引用、范围；字符串里的“A1”和函数名不算', () => {
    const refs = refsOf(`SUM($B$2:B9)+'销售 明细'!C3+汇总!A1+LOG10(B2)&"A1"`);
    expect(refs.map((r) => [r.sheet, r.c1, r.r1, r.c2, r.r2])).toEqual([[null, 1, 2, 1, 9], ['销售 明细', 2, 3, 2, 3], ['汇总', 0, 1, 0, 1], [null, 1, 2, 1, 2]]);
  });

  it('正常的公式（含自动补的合计、IFERROR 包住的比率）不报问题', async () => {
    const r = await makeXlsx('| 月份 | 本期 | 上期 | 同比 |\n|--|--|--|--|\n| 1月 | 100 | 0 |  |\n| 2月 | 120 | 100 |  |\n| 合计 |  |  |  |', { theme: THEMES.business });
    expect(r.info.formulas).toBeGreaterThan(2);
    expect(r.info.formulaIssues).toEqual([]);
  });

  it('函数名拼错、括号不配对、循环引用、引用不存在的工作表、范围在表格外、求和范围全是文字、除以 0 都能查出', () => {
    const issues = checkFormulas([sheet('明细', [
      ['项目', '收入', '成本', '结果'],
      ['甲', 100, 0, '=SUMM(B2:B3)'],
      ['乙', 120, 70, '=SUM(B2:B3'],
      ['丙', 1, 2, '=D4+1'],
      ['丁', 1, 2, '=汇总!B2'],
      ['戊', 1, 2, '=SUM(B20:B30)'],
      ['己', 1, 2, '=SUM(A2:A3)'],
      ['庚', 1, 2, '=B2/C2'],
      ['辛', 1, 2, '=IFERROR(B2/C2,"")']
    ])]);
    const by = (cell) => issues.filter((x) => x.cell === cell).map((x) => x.text).join('；');
    expect(by('D2')).toMatch(/SUMM 不认识.*#NAME\?/);
    expect(by('D3')).toMatch(/括号不配对/);
    expect(by('D4')).toMatch(/引用了自己.*循环引用/);
    expect(by('D5')).toMatch(/工作表“汇总”不存在.*#REF!/);
    expect(by('D6')).toMatch(/在表格外面（表格只到第 9 行、D 列）/);
    expect(by('D7')).toMatch(/SUM 的范围 A2:A3 里一个数字都没有/);
    expect(by('D8')).toMatch(/除数 C2 是 0.*#DIV\/0!/);
    expect(by('D9')).toBe(''); // IFERROR 兜底了
    expect(issues.every((x) => x.level === 'error')).toBe(true);
  });

  it('跨工作表引用存在的表时不报；部分越界只提醒', () => {
    const a = sheet('汇总', [['项目', '金额'], ['合计', '=明细!B2*2']]);
    const b = sheet('明细', [['项目', '金额'], ['甲', 5]]);
    const issues = checkFormulas([a, b]);
    expect(issues).toEqual([]);
    const part = checkFormulas([sheet('S', [['a', 'b', 'c'], ['x', 1, '=SUM(B2:B5)']])]);
    expect(part.map((x) => x.level)).toEqual(['warn']);
  });

  it('排版位置：报表模式下每格在 Excel 里的真实行号（给模型改公式时对照）', async () => {
    const r = await makeXlsx('## 汇总\n\n2026 年经营数据\n\n| 项目 | 金额 |\n|--|--|\n| 甲 | 10 |\n| 乙 | =SUM(B2:B3) |', { theme: THEMES.business });
    // 大标题、副标题、空行之后表头在第 4 行，所以 B2:B3 引到的是标题区：查出来
    expect(r.info.layout).toMatch(/A4：项目 \| B4：金额/);
    expect(r.info.layout).toMatch(/B6：=SUM\(B2:B3\)/);
    expect(r.info.formulaIssues.map((x) => x.text).join()).toMatch(/B2:B3/);
    expect(sheetLayout([sheet('S', [['a']])])).toContain('工作表“S”（1 行 × 1 列）');
  });
});

describe('create_document：Excel 公式有错时请模型改一轮再生成', () => {
  let ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
  });
  afterEach(() => { delete globalThis.indexedDB; });

  it('模型按单元格位置改好引用：结果写明修正了几处，文件里是改好的公式', async () => {
    const prompts = [];
    const llm = async ({ prompt }) => { prompts.push(prompt); return JSON.stringify({ problems: ['合计引用错行'], edits: [{ find: '=SUMM(B2:B3)', replace: '=SUM(B2:B3)' }] }); };
    const tools = (await import('../src/agent/tools.js')).createTools({ llm });
    const r = await tools.find((t) => t.name === 'create_document').run({ format: 'xlsx', path: '表', content: '| 项目 | 金额 |\n|--|--|\n| 甲 | 10 |\n| 乙 | 20 |\n| 两项 | =SUMM(B2:B3) |' }, {});
    expect(prompts.at(-1)).toMatch(/每个单元格在 Excel 里的位置[\s\S]*B4：=SUMM/);
    expect(r).toContain('生成后检查公式，自动修正了 1 处');
    expect(r).not.toContain('还需要注意');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await ws.readBlob('表.xlsx')).arrayBuffer());
    expect(wb.worksheets[0].getCell('B4').value.formula).toBe('SUM(B2:B3)');
  });

  it('没有模型时不改，把问题写进结果', async () => {
    const tools = (await import('../src/agent/tools.js')).createTools({});
    const r = await tools.find((t) => t.name === 'create_document').run({ format: 'xlsx', path: '表', content: '| 项目 | 金额 |\n|--|--|\n| 甲 | 10 |\n| 乙 | =B2/B9 |' }, {});
    expect(r).toMatch(/还需要注意：.*B3 的公式 =B2\/B9/);
  });
});

describe('PPT 排版检查：估算字放不放得下、压没压住', async () => {
  const { wrapText, fitText, layoutIssues, sheetSvg, slideSvg, pickSheets } = await import('../src/agent/slidePreview.js');
  const { makePptx } = await import('../src/agent/pptxWriter.js');

  it('按框宽折行：中文 1 个字号宽；20 号字 3.38 英寸宽的框一行放 11 个字左右', () => {
    const t = '多源证据汇聚，自动给出风险等级和处置建议，减少人工研判时间';
    const r = wrapText(t, { fontSize: 20 }, 3.38);
    expect(r.lines.length).toBe(3);
    expect(r.lines.map((l) => l.runs.map((x) => x.text).join('')).join('')).toBe(t);
    // 带项目符号的多段：每段单独起行，段前距算进高度
    const runs = [{ text: '一', options: { bullet: true, breakLine: true } }, { text: '二', options: { bullet: true, paraSpaceBefore: 12, breakLine: true } }];
    const two = wrapText(runs, { fontSize: 18 }, 4);
    expect(two.lines.length).toBe(2);
    expect(two.height).toBeCloseTo(0.1 + 2 * (18 / 72) * 1.2 + 12 / 72, 3);
  });

  it('“缩小字号以适应”生成时就生效：一档档缩到放得下，最多缩到 60%', () => {
    const t = '按预案自动派单，跟踪每一步处置进度，超时自动提醒和升级';
    const f = fitText(t, { w: 3.38, h: 1.1, fontSize: 20, lineSpacingMultiple: 1.25 });
    expect(f.o.fontSize).toBeLessThan(20);
    expect(wrapText(f.text, f.o, 3.38).height).toBeLessThanOrEqual(1.1 * 1.02);
    expect(fitText('短', { w: 3, h: 1, fontSize: 20 }).o.fontSize).toBe(20);
    expect(fitText(t.repeat(20), { w: 3, h: 0.5, fontSize: 20 }).o.fontSize).toBe(12);
  });

  it('放不下、超出页面、两段字压在一起、字压在图上都会报出来；同一位置的叠放（色块上的字）不算', () => {
    const text = (s, x, y, w, h, o = {}) => ({ kind: 'text', text: s, x, y, w, h, o: { fontSize: 18, x, y, w, h, ...o } });
    const issues = layoutIssues([
      { n: 2, title: '放不下', items: [text('很长的一段话'.repeat(30), 0.6, 1.6, 6, 1)] },
      { n: 3, title: '出界', items: [text('短', 12.5, 7, 2, 0.5)] },
      { n: 4, title: '压住', items: [text('第一段文字'.repeat(4), 1, 2, 4, 1), text('第二段文字', 1, 2.3, 4, 0.5), text('同位置', 1, 2, 4, 1, { fontSize: 10 })] },
      { n: 5, title: '压图', items: [{ kind: 'image', x: 5, y: 2, w: 3, h: 3 }, text('说明文字说明文字', 4, 3, 3, 0.6)] }
    ]);
    const on = (n) => issues.filter((x) => x.slide === n).map((x) => x.text).join('；');
    expect(on(2)).toMatch(/第 2 页「放不下」的文字放不下.*按 18 号字要排约 \d+ 行/);
    expect(issues.find((x) => x.slide === 2).level).toBe('error');
    expect(on(3)).toMatch(/超出了页面边界/);
    expect(on(4)).toMatch(/两段文字压在一起：“第一段文字第一段文字第一段文”和“第二段文字”/);
    expect(on(4)).not.toMatch(/同位置/);
    expect(on(5)).toMatch(/压到了图片上/);
  });

  it('正常的汇报 PPT 没有排版问题；记下每页的东西，卡片说明用同一个字号', async () => {
    const deck = `# 汇报\n\n## 核心数据\n- 1,236 万元 全年销售额\n- 35 家 新签客户\n\n## 建设内容\n- 预警研判：多源证据汇聚，自动给出风险等级和处置建议，减少人工研判时间\n- 处置调度：按预案自动派单\n- 复盘分析：自动生成复盘报告，沉淀经验到知识库，下次直接调用\n\n## 区域业绩\n| 区域 | 2025年 | 2026年 |\n|--|--|--|\n| 华东 | 500 | 612 |\n| 华南 | 360 | 418 |\n\n## 谢谢`;
    const { info } = await makePptx({ title: '汇报', content: deck, theme: THEMES.business });
    expect(info.layoutIssues).toEqual([]);
    expect(info.preview.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    expect(info.preview[0].background).toBeTruthy();
    const cards = info.preview[2].items.filter((it) => it.kind === 'text' && it.o.lineSpacingMultiple === 1.3);
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((c) => c.o.fontSize)).size).toBe(1);
    // 图表数据记的是生成时的样子（库会改写传进去的数组）
    const chart = info.preview[3].items.find((it) => it.kind === 'chart');
    expect(chart.data[0].labels).toEqual(['华东', '华南']);
  });

  it('画成 SVG：页码标签、文字、转义；挑页时有问题的页优先，每 4 页拼一张', async () => {
    const { info } = await makePptx({ title: 'A&B <测试>', content: '## 第一页\n- 要点一\n- 要点二\n\n## 第二页\n- 要点', theme: THEMES.business });
    const svg = sheetSvg(info.preview);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('第 2 页');
    expect(svg).toContain('A&amp;B &lt;测试&gt;');
    expect(svg).toContain('要点一');
    expect(slideSvg(info.preview[1], { width: 640 })).toMatch(/width="640" height="360"/);
    const slides = Array.from({ length: 12 }, (_, i) => ({ n: i + 1 }));
    const groups = pickSheets(slides, [{ slide: 11 }, { slide: 12 }], { max: 8 });
    expect(groups.map((g) => g.map((s) => s.n))).toEqual([[1, 2, 3, 4], [5, 6, 11, 12]]);
  });
});

describe('create_document：PPT 看图检查', () => {
  let ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
  });
  afterEach(() => { delete globalThis.indexedDB; });
  const deck = '# 汇报\n\n## 主要工作\n- 完成华东、华南两大区域布局，这一句写得有点啰嗦需要精简\n- 上线智能终端产品线\n- 建立代理商体系';

  it('有能看图的模型：把每页画成图交给它，按它给的修改重新生成，结果里写明', async () => {
    const calls = [];
    const visionLlm = async (o) => { calls.push(o); return JSON.stringify({ problems: ['第 2 页：第一条太长'], edits: [{ find: '，这一句写得有点啰嗦需要精简', replace: '' }] }); };
    const rasterize = async (svg) => ({ mime: 'image/jpeg', data: Buffer.from(svg).toString('base64').slice(0, 40) });
    const tools = (await import('../src/agent/tools.js')).createTools({ visionLlm, rasterize });
    const r = await tools.find((t) => t.name === 'create_document').run({ format: 'pptx', path: '汇报', content: deck }, {});
    expect(calls).toHaveLength(1);
    expect(calls[0].images).toHaveLength(1);
    expect(calls[0].prompt).toMatch(/第 1、2 页/);
    expect(r).toContain('看图检查了 2 页，修正了 1 处（第 2 页：第一条太长）');
    const { parseFile } = await import('../src/agent/docs.js');
    const text = (await parseFile(await ws.readBlob('汇报.pptx'), 'a.pptx')).text;
    expect(text).toContain('完成华东、华南两大区域布局');
    expect(text).not.toContain('啰嗦');
  });

  it('没有看图模型、或者画不出图（比如测试环境）时跳过，不影响生成', async () => {
    const visionLlm = vi.fn();
    const none = (await import('../src/agent/tools.js')).createTools({});
    expect(await none.find((t) => t.name === 'create_document').run({ format: 'pptx', path: 'a', content: deck }, {})).not.toContain('看图');
    const noCanvas = (await import('../src/agent/tools.js')).createTools({ visionLlm });
    expect(await noCanvas.find((t) => t.name === 'create_document').run({ format: 'pptx', path: 'b', content: deck }, {})).not.toContain('看图');
    expect(visionLlm).not.toHaveBeenCalled();
  });
});

describe('哪些模型能看图', async () => {
  const { seesImages } = await import('../src/llm/router.js');
  it('按模型名判断', () => {
    for (const m of ['claude-haiku-5-5', 'gpt-6.1-sol', 'gpt-4o', 'qwen2.5-vl-72b', 'gemini-2.5-pro', 'glm-4v-plus']) expect(seesImages(m), m).toBe(true);
    for (const m of ['deepseek-chat', 'deepseek-reasoner', 'kimi-k2', '']) expect(seesImages(m), m).toBe(false);
  });
});

describe('PPT 新样式：白底卡片、图标、提纲页、页脚', async () => {
  const { makePptx, iconPicker } = await import('../src/agent/pptxWriter.js');
  const { ICON_PNG } = await import('../src/agent/pptIcons.js');
  const deck = `# 年度汇报\n\n## 第一部分 经营情况\n\n## 经营整体向好\n- 营收：全年营收增长 18%\n- 风险：回款周期拉长到 75 天\n- 客户：新签客户 42 家\n\n## 第二部分 下一步计划\n\n## 区域业绩\n| 区域 | 营收 | 占比 |\n|--|--|--|\n| 华东 | 820 | 44% |\n| 华南 | 560 | 30% |\n| 合计 | 1380 | 100% |\n\n## 谢谢`;

  it('按文字意思配图标，同一页不重复；配不上的用备用图标；图标都在图标库里', () => {
    const pick = iconPicker();
    expect([pick('回款周期拉长'), pick('风险：回款变慢'), pick('新签客户 42 家'), pick('一些说不清的话')]).toEqual(['banknote', 'triangle-alert', 'users', 'sparkles']);
    expect(iconPicker()('回款')).toBe('banknote'); // 换一页重新计
    for (const name of ['banknote', 'triangle-alert', 'users', 'sparkles', 'layers', 'target', 'lightbulb', 'badge-check', 'rocket']) expect(ICON_PNG[name], name).toMatch(/^iVBORw0KGgo/);
  });

  it('两个以上“第 X 部分”时自动加汇报提纲页；章节后面的页右上角标着第几部分；每页底部有文档名和页码', async () => {
    const { info } = await makePptx({ title: '年度汇报', content: deck, theme: THEMES.business });
    expect(info.layouts).toEqual(['cover', 'agenda', 'section', 'cards', 'section', 'chart', 'end']);
    const texts = (n) => info.preview[n - 1].items.filter((it) => it.kind === 'text').map((it) => String(Array.isArray(it.text) ? it.text.map((r) => r.text).join('') : it.text));
    expect(texts(2)).toEqual(expect.arrayContaining(['汇报提纲', '01', '经营情况', '02', '下一步计划']));
    expect(texts(4)).toEqual(expect.arrayContaining(['01 经营情况', '年度汇报', '4']));
    expect(texts(6)).toContain('02 下一步计划');
    // 卡片页：三张卡片各有一个圆形图标（PNG），没有贴着左边的整条竖线
    const cardsPage = info.preview[3].items;
    expect(cardsPage.filter((it) => it.kind === 'image')).toHaveLength(3);
    expect(cardsPage.some((it) => it.kind === 'shape' && it.x === 0 && it.h >= 7)).toBe(false);
    expect(info.layoutIssues).toEqual([]);
  });

  it('图表旁的说明不写“占比 100%”这种废话', async () => {
    const { info } = await makePptx({ title: '年度汇报', content: deck, theme: THEMES.business });
    const note = info.preview[5].items.filter((it) => it.kind === 'text' && Array.isArray(it.text)).flatMap((it) => it.text.map((r) => r.text)).join('');
    expect(note).toMatch(/合计：营收 1380/);
    expect(note).not.toMatch(/100%/);
  });

  it('封面：署名里已经带了日期就不再重复写日期', async () => {
    const coverTexts = async (author) => (await makePptx({ title: 't', content: '## 一页\n- 要点', theme: THEMES.business, author })).info.preview[0].items.filter((it) => it.kind === 'text').map((it) => String(it.text));
    const withDate = await coverTexts('经营分析 · 2026 年 10 月');
    expect(withDate.filter((t) => /\d{4}\s*年/.test(t))).toEqual(['经营分析 · 2026 年 10 月']);
    expect((await coverTexts('经营分析部')).some((t) => /^\d{4} 年 \d+ 月 \d+ 日$/.test(t))).toBe(true);
  });
});

describe('Excel：模型自己写的公式先算好结果、读回能看到公式、百分比格式、表头', async () => {
  const { evaluateWorkbook } = await import('../src/agent/formulaEval.js');
  const { parseFile } = await import('../src/agent/docs.js');
  const OVERVIEW = `## 总览
| 项目 | 数值 |
| 2026年三季度总营收（万元） | ='区域数据'!C5 |
| 整体同比增长率 | =('区域数据'!C5-'区域数据'!B5)/'区域数据'!B5 |
| 增长最快的区域 | =INDEX('区域数据'!A2:A4,MATCH(MAX('区域数据'!D2:D4),'区域数据'!D2:D4,0)) |

## 区域数据
| 区域 | 2025年三季度（万元） | 2026年三季度（万元） | 同比 | 2026年占比 | 同比增减（万元） |
|--|--|--|--|--|--|
| 华东 | 680 | 820 | =(C2-B2)/B2 | =C2/$C$5 | =C2-B2 |
| 华南 | 470 | 560 | =(C3-B3)/B3 | =C3/$C$5 | =C3-B3 |
| 华北 | 466 | 480 | =(C4-B4)/B4 | =C4/$C$5 | =C4-B4 |
| 合计 | =SUM(B2:B4) | =SUM(C2:C4) | =(C5-B5)/B5 | =SUM(E2:E4) | =SUM(F2:F4) |`;

  it('公式计算：四则运算、跨表引用、SUM / MAX / INDEX / MATCH / IF / IFERROR / ROUND / SUMIF，除以 0 得到 #DIV/0!，不认识的函数不算', () => {
    const sheet = (name, rows) => ({ name, cells: new Map(Object.entries(rows).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : { value: v }])) });
    const r = evaluateWorkbook([
      sheet('数据', { A1: '甲', A2: '乙', B1: 10, B2: 30, C1: 0, D1: '=SUM(B1:B2)*2', D2: '=B2/C1', D3: '=IFERROR(B2/C1,"无")', D4: '=IF(B2>B1,"乙多","甲多")', D5: '=ROUND(B1/3,2)', D6: '=INDEX(A1:A2,MATCH(MAX(B1:B2),B1:B2,0))', D7: '=SUMIF(A1:A2,"乙",B1:B2)', D8: '=FOO(B1)', D9: '=50%*B1' }),
      sheet('汇总', { A1: '=数据!D1+1' })
    ]);
    expect(r.get('数据!D1')).toBe(80);
    expect(r.get('数据!D2')).toBe('#DIV/0!');
    expect(r.get('数据!D3')).toBe('无');
    expect(r.get('数据!D4')).toBe('乙多');
    expect(r.get('数据!D5')).toBe(3.33);
    expect(r.get('数据!D6')).toBe('乙');
    expect(r.get('数据!D7')).toBe(30);
    expect(r.has('数据!D8')).toBe(false);
    expect(r.get('数据!D9')).toBe(5);
    expect(r.get('汇总!A1')).toBe(81);
  });

  it('生成时把结果存进文件；比率列、比率行设百分比格式，金额列不设；“项目 | 数值”当作表头；模型写的占比公式不被替换', async () => {
    const r = await makeXlsx(OVERVIEW, { theme: THEMES.business });
    expect(r.info.formulaIssues).toEqual([]);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await r.blob.arrayBuffer());
    const data = wb.getWorksheet('区域数据');
    expect(data.getCell('B5').value).toEqual({ formula: 'SUM(B2:B4)', result: 1616 });
    expect(data.getCell('D2').value.result).toBeCloseTo(0.2059, 4);
    expect(data.getCell('D2').numFmt).toBe('0.0%');
    expect(data.getCell('E2').value.formula).toBe('C2/$C$5');
    expect(data.getCell('E2').numFmt).toBe('0.0%');
    expect(data.getCell('F2').numFmt).not.toBe('0.0%'); // “同比增减（万元）”是金额
    const sum = wb.getWorksheet('总览');
    const cellOf = (label) => { let hit; sum.eachRow((row) => row.eachCell((c) => { if (c.value === label) hit = row.getCell(c.col + 1); })); return hit; };
    expect(cellOf('整体同比增长率').numFmt).toBe('0.0%');
    expect(cellOf('整体同比增长率').value.result).toBeCloseTo(0.151, 3);
    expect(cellOf('增长最快的区域').value.result).toBe('华东');
    let headFill;
    sum.eachRow((row) => row.eachCell((c) => { if (c.value === '项目') headFill = c.fill?.fgColor?.argb; }));
    expect(headFill).toBe(`FF${THEMES.business.colors.accent}`);
  });

  it('读回 Excel：看得到算好的数和公式清单；没存结果的公式显示公式本身，不显示成空格子', async () => {
    const r = await makeXlsx(OVERVIEW, { theme: THEMES.business });
    const text = (await parseFile(r.blob, 'a.xlsx')).text;
    expect(text).toMatch(/华东,680,820,20\.6%,44\.1%/);
    expect(text).toMatch(/【公式】共 \d+ 个：.*B5 =SUM\(B2:B4\)/);
    // 别的软件生成、没存结果的公式
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 1; ws.getCell('A2').value = 2; ws.getCell('A3').value = { formula: 'SUM(A1:A2)' };
    const blank = await parseFile(new Blob([await wb.xlsx.writeBuffer()]), 'b.xlsx');
    expect(blank.text).toMatch(/^## 工作表：S\n1\n2\n=SUM\(A1:A2\)/);
  });
});

describe('PPT：套话提醒', () => {
  it('汇报里用了“赋能 / 抓手”这类词：自查提醒换成具体的动作和数字', async () => {
    const { lint } = await import('../src/agent/selfCheck.js');
    expect(lint('pptx', '## 计划\n- 以新客户为抓手，全方位赋能销售\n- 回款压到 60 天').map((x) => x.text)).toContain('用了套话“抓手、全方位、赋能”，换成具体的动作和数字');
    expect(lint('pptx', '## 计划\n- 重点跟进 42 家新签客户\n- 回款压到 60 天').some((x) => /套话/.test(x.text))).toBe(false);
  });
});

describe('PPT 版式要有变化；Word 落款单位靠右', async () => {
  const { makePptx } = await import('../src/agent/pptxWriter.js');
  const five = (t) => `## ${t}\n- 现状：华北 480 万元，增速低于整体\n- 测算：按 3% 反推去年约 466 万元\n- 差距：约 70 万元营收缺口\n- 原因：重点城市覆盖不足\n- 对策：增设 2 个办事处`;

  it('连续几页都是“标签：说明”：换着用卡片网格、一排大圆、左右分栏，不全是同一个样子', async () => {
    const deck = ['一', '二', '三'].map((x) => five(`第${x}页标题`)).join('\n\n');
    const { info } = await makePptx({ title: '汇报', content: deck, theme: THEMES.business });
    const p = (n) => info.preview[n - 1].items;
    const bigCircles = (n) => p(n).filter((it) => it.kind === 'shape' && it.type === 'ellipse' && it.w >= 1.4).length;
    const darkPanel = (n) => p(n).some((it) => it.kind === 'shape' && it.type === 'roundRect' && it.fill === THEMES.business.colors.primary && it.h > 5);
    expect(bigCircles(2)).toBe(0); // 第一页卡片网格
    expect(bigCircles(3)).toBe(5); // 第二页一排大圆
    expect(darkPanel(4)).toBe(true); // 第三页左右分栏
    expect(info.layoutIssues).toEqual([]);
  });

  it('“总体判断 / 结论”这类总结句放进深色重点横条，不当卡片；5、6 个数字也做成大数字卡片', async () => {
    const deck = `## 总览\n- 营收：1,860 万元，同比增长 18%\n- 客户：新签 42 家\n- 回款：周期 75 天\n- 总体判断：增长靠华东与华南\n\n## 关键数字\n- 1,860 万元：三季度营收\n- 820 万元：华东营收\n- 42 家：新签客户\n- 91%：续约率\n- 2,200 万元：四季度目标`;
    const { info } = await makePptx({ title: '汇报', content: deck, theme: THEMES.business });
    expect(info.layouts).toEqual(['cover', 'cards', 'stats']);
    const runs = info.preview[1].items.filter((it) => it.kind === 'text' && Array.isArray(it.text)).flatMap((it) => it.text.map((r) => r.text));
    expect(runs).toEqual(expect.arrayContaining(['总体判断　', '增长靠华东与华南']));
    const bigNumbers = info.preview[2].items.filter((it) => it.kind === 'text' && it.o.fontSize >= 28).map((it) => it.text);
    expect(bigNumbers).toEqual(['1,860 万元', '820 万元', '42 家', '91%', '2,200 万元']);
  });

  it('Word 通知：日期上面一行的单位名（综合办公室）也靠右；标题像公文时即使填了默认主题也按公文排', async () => {
    const { parseDoc, markSalutationAndSignature } = await import('../src/agent/docModel.js');
    const doc = markSalutationAndSignature(parseDoc('各部门：\n\n请准时参加。\n\n联系人：王磊，电话 8866 1234。\n\n综合办公室\n\n2026 年 10 月 16 日'));
    expect(doc.filter((b) => b.signature).map((b) => b.inlines.map((x) => x.text).join(''))).toEqual(['综合办公室', '2026 年 10 月 16 日']);
    // “联系人：……”有冒号，不是单位名
    const doc2 = markSalutationAndSignature(parseDoc('各部门：\n\n请准时参加。\n\n联系人：王磊。\n\n2026 年 10 月 16 日'));
    expect(doc2.filter((b) => b.signature)).toHaveLength(1);
    const { resolveTheme } = await import('../src/agent/themes.js');
    expect(resolveTheme('business', '# 关于召开四季度工作部署会的通知\n\n各部门：').id).toBe('gongwen');
    expect(resolveTheme('ocean-depths', '# 关于召开四季度工作部署会的通知').id).toBe('ocean-depths'); // 明确选了别的主题就照用
  });
});
