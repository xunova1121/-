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

  it('未央读回：看到的是算好的数（原来的读取功能不受影响）', async () => {
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

describe('PPT 版式：卡片、步骤、流程、图表单位、封面信息', () => {
  const L = (md, o) => layoutOf(parseSlides('t', md)[0], o);
  it('3–6 条“标签：说明”做成卡片；标题像流程时做成步骤；可以多带一句总结', () => {
    expect(L('## 建设定位\n- 预警研判：多源汇聚\n- 法规知识：条款核验\n- 调度派单：力量推荐\n- 复用已有平台能力')).toBe('cards');
    expect(L('## 业务场景：处置闭环\n- 发现：融合告警\n- 取证：调取视频\n- 研判：关联档案\n- 调度：推荐力量')).toBe('steps');
    expect(L('## 普通要点\n- 第一条很普通\n- 第二条也普通\n- 第三条')).toBe('bullets');
  });
  it('有“A→B→C”的链路画成流程', () => {
    expect(L('## 必要性\n- 当前链路：雷达告警→看视频→查档案→派工单\n- 多系统切换耗时')).toBe('flow');
  });
  it('单位不同的数字列不放进同一张图，合计行不画柱子', () => {
    const md = '## 投资\n| 内容 | 人天 | 投资（万元） |\n|---|---|---|\n| 甲 | 75 | 15 |\n| 乙 | 110 | 22 |\n| 合计 | 185 | 37 |';
    expect(L(md)).toBe('chart');
  });
  it('第二页是封面信息时挪回封面，生成出来少一页', async () => {
    const md = '# 某项目\n\n## 能力扩展\n- 项目建议汇报\n- 江苏省渔业执法监督中心\n- 2026年10月\n\n## 正文\n- 一条\n- 两条\n- 三条';
    const { generate } = await import('../src/agent/docs.js');
    const out = await generate('pptx', { title: '某项目', content: md });
    expect(out.info.layouts).toEqual(['cover', 'bullets']);
  });
});

describe('Excel 报表排版', () => {
  const REPORT = `## 总览
（项目建议书 V1.0，2026年10月）
### 一、项目基本信息
| 项目名称 | 禁捕执法AI能力扩展 | 编号 | G2025-0529 |
| 编制单位 | 江苏省渔业执法监督中心 | 版本号 | V1.0 |

### 二、投资结构
| 序号 | 建设内容 | 人天 | 金额（万元） | 占比 |
|---|---|---|---|---|
| 一 | 预警研判智能体 | 75 | 15 |  |
| 二 | 智能体运行底座 | 110 | 22 |  |
| 合计 | 总计 | 335 | 37 |  |

说明：本阶段为项目建议书阶段，投资估算允许误差 ±10%。

## 明细
| 序号 | 名称 |
|---|---|
| 1 | 甲 |
`;
  it('标题、副标题、小节、信息表、多张表、说明；占比和合计自动写公式', async () => {
    const wb = await readBook((await makeXlsx(REPORT, { theme: THEMES.business })).blob);
    const ws = wb.getWorksheet('总览');
    expect(ws.getCell('A1').value).toBe('总览');
    expect(ws.getCell('A1').font.bold).toBe(true);
    expect(ws.getCell('A1').isMerged).toBe(true); // 标题横跨整个表宽
    expect(ws.getCell('A2').value).toContain('项目建议书');
    const find = (text) => { let at = null; ws.eachRow((row, r) => { if (row.getCell(1).value === text) at = r; }); return at; };
    const sec = find('一、项目基本信息');
    expect(ws.getRow(sec).getCell(1).fill.fgColor.argb).toBe('FFE8F0F8');
    // 信息表：没有表头，左边的名目加粗
    const info = sec + 1;
    expect(ws.getRow(info).getCell(1).value).toBe('项目名称');
    expect(ws.getRow(info).getCell(1).font.bold).toBe(true);
    expect(ws.getRow(info).getCell(3).font.bold).toBe(true);
    expect(ws.getRow(info).getCell(2).font.bold).toBeFalsy();
    // 投资表：表头、合计公式、占比公式（按金额列）
    const head = find('序号');
    expect(ws.getRow(head).getCell(1).fill.fgColor.argb).toBe('FF2E6DA4');
    const total = head + 3;
    expect(ws.getRow(total).getCell(4).value.formula).toBe(`SUM(D${head + 1}:D${head + 2})`);
    expect(ws.getRow(head + 1).getCell(5).value.formula).toBe(`IFERROR(D${head + 1}/D$${total},"")`);
    expect(ws.getRow(head + 1).getCell(5).value.result).toBeCloseTo(15 / 37);
    expect(ws.getRow(head + 1).getCell(5).numFmt).toBe('0.0%');
    expect(ws.getRow(total).getCell(5).value.result).toBeCloseTo(1);
    expect(ws.getRow(head + 1).getCell(1).alignment.horizontal).toBe('center'); // 序号居中
    // 说明整行合并；冻结到表头；报表不加筛选、不显示网格线
    const note = find('说明：本阶段为项目建议书阶段，投资估算允许误差 ±10%。');
    expect(ws.getRow(note).getCell(1).isMerged).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', showGridLines: false });
    expect(ws.autoFilter).toBeFalsy();
    // 只有一张表的工作表仍是普通数据表：表头在第一行、带筛选
    const plain = wb.getWorksheet('明细');
    expect(plain.getCell('A1').value).toBe('序号');
    expect(plain.autoFilter).toBeTruthy();
  });

  it('长文字按列宽估算行高（不会被截掉）', async () => {
    const long = '对接一期智能预警子系统，实时接入光电视频抓拍、雷达航迹、AIS报文、电子围栏越界告警等多种事件，建立统一的事件模型'.repeat(2);
    const wb = await readBook((await makeXlsx(`| 序号 | 名称 | 内容 |\n|---|---|---|\n| 1 | 甲 | ${long} |`, { theme: THEMES.business })).blob);
    const ws = wb.worksheets[0];
    expect(ws.getColumn(3).width).toBe(50);
    expect(ws.getRow(2).height).toBeGreaterThan(60);
  });
});

describe('PPT 版式：段落写法、时间线、进度条、重点句、版式指令', () => {
  const L = (md, o) => layoutOf(parseSlides('t', md)[0], o);
  it('要点写成一段一段的话（不带“- ”）也能排成卡片；多出的一句总结不影响', () => {
    expect(L('## 外部依赖\n专线打通：32/33，截止 10-24\n\n送电与 IP：太平港不通电\n\n智算资源：7 项挂起\n\n三项都卡在地方协调')).toBe('cards');
  });
  it('列表最后一项后面紧跟一段话（没空行）也拆开；“0/12”“10-19”这类数字做成大数字', () => {
    expect(L('## 雷达\n- 0/12：雷达安装数\n- 10-19：支架到货\n- 10-20：启动安装\n卡点：支架定做')).toBe('stats');
  });
  it('日期开头的几条排成时间线；“名称：百分比”排成进度条；只有百分比列的表格也是进度条', () => {
    expect(L('## 节点\n- 10-19 支架到货\n- 10-20 启动安装\n- 11月1日：初验')).toBe('timeline');
    expect(L('## 进度\n- 软件开发：100%\n- 设备到货：98.7%\n- 雷达安装：0%')).toBe('progress');
    expect(L('## 进度\n| 阶段 | 完成率 |\n|--|--|\n| 软件 | 100% |\n| 雷达 | 0% |')).toBe('progress');
  });
  it('大小差几十倍的数字不画进同一张柱状图，改用表格', () => {
    expect(L('## 规模\n| 项目 | 数量 |\n|--|--|\n| 水域 | 3000 |\n| 雷达 | 12 |')).toBe('table');
  });
  it('一句话 + 一条“标签：说明”是重点句页；“标签：”单独一行和下一段并成一条', () => {
    expect(L('## 建议一\n把雷达列为唯一红色项，按天盯。\n\n分批方案：\n\n先验软件与云台，雷达补验。')).toBe('statement');
  });
  it('页内写“版式：……”按指定的排；排不成时仍自动选', () => {
    expect(L('## 四件事\n版式：卡片\n- 船载终端：提供船只信息\n- 流量卡：明确数量')).toBe('cards');
    expect(L('## 普通\n版式：大数字\n- 第一条\n- 第二条\n- 第三条')).toBe('bullets');
    expect(L('## 四件事\n- 版式：卡片\n- 船载终端：提供船只信息\n- 流量卡：明确数量')).toBe('cards'); // 写成列表的一条也认
  });
  it('封面后面重复写名称和日期的“副封面”去掉；连续 3 页普通列表提醒换版式；“汇报完毕”是结尾页', async () => {
    const md = '# 周报\n\n## 综合管理平台\n2026 年 10 月 12—16 日\n\n## 甲\n- 一条普通的话\n- 两条普通的话\n- 三条普通的话\n\n## 乙\n- 一条普通的话\n- 两条普通的话\n- 三条普通的话\n\n## 丙\n- 一条普通的话\n- 两条普通的话\n- 三条普通的话\n\n## 汇报完毕，请指示';
    const out = await makePptx({ title: '周报', content: md, theme: THEMES.business });
    expect(out.info.layouts).toEqual(['cover', 'bullets', 'bullets', 'bullets', 'end']);
    expect(out.info.layoutIssues.some((x) => /连续 3 页都是普通要点列表/.test(x.text))).toBe(true);
    const cover = out.info.preview[0].items.filter((it) => it.kind === 'text').map((it) => String(it.text));
    expect(cover.some((t) => t.includes('综合管理平台'))).toBe(true);
  });
});

describe('PPT 卡片阴影（评测里做 PPT 时服务器被系统杀掉）', () => {
  it('每张卡片的阴影都是正常大小：不会一张乘一次变成上万倍（LibreOffice 转 PDF 吃到 2GB 内存）', async () => {
    const content = ['## 背景：20户参与', '- 参与：20户养殖户', '- 现状：人工记录', '- 问题：对账易出错', '## 风险：接口未确认', '- 接口：银行能力未知', '- 网络：断网补传', '- 人员：培训不足', '## 待决策', '- 决策一：是否启动', '- 决策二：人工兜底', '- 决策三：负责人'].join('\n');
    const { blob } = await makePptx({ title: '试点汇报', content, theme: THEMES.business });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const blur = [];
    for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      for (const m of (await zip.file(name).async('string')).matchAll(/blurRad="(\d+)"/g)) blur.push(Number(m[1]));
    }
    expect(blur.length).toBeGreaterThan(3);
    expect(Math.max(...blur)).toBeLessThanOrEqual(76200);
  });
});
