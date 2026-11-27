import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { makeXlsx } from '../src/agent/xlsxWriter.js';
import { THEMES } from '../src/agent/themes.js';

const open = async (blob) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await blob.arrayBuffer())); return wb.worksheets[0]; };
const SETTLE = `## 收购结算表
| 序号 | 养殖户 | 毛重（公斤） | 筐重（公斤） | 净重（公斤） | 单价（元/公斤） | 金额（元） | 付款状态 |
|--|--|--|--|--|--|--|--|
| 1 | 张三 | 100 | 5 | 90 | 12 | 1000 | 未付 |
| 2 | 李四 | 80 | 4 | 76 | 15 | 1140 | 已付 |
| 合计 | | | | | | | |`;

describe('Excel 按用途建表', () => {
  it('结算表：净重 = 毛重 − 筐重、金额 = 净重 × 单价都是公式（模型手算错的也改对）；合计不加单价', async () => {
    const ws = await open((await makeXlsx(SETTLE, { theme: THEMES.business, kind: 'settlement' })).blob);
    expect(ws.getCell('E2').value).toMatchObject({ formula: 'C2-D2', result: 95 });
    expect(ws.getCell('G2').value).toMatchObject({ formula: 'ROUND(E2*F2,2)', result: 1140 });
    expect(ws.getCell('G4').value).toMatchObject({ formula: 'SUM(G2:G3)', result: 2280 });
    expect(ws.getCell('F4').value).toBeNull();
  });

  it('录入是蓝字、公式是灰底；状态列有下拉和标色；打印区域、页码都设好', async () => {
    const ws = await open((await makeXlsx(SETTLE, { theme: THEMES.business, kind: 'settlement' })).blob);
    expect(ws.getCell('C2').font.color.argb).toBe('FF1F4E9A');
    expect(ws.getCell('E2').fill.fgColor.argb).toBe('FFF1F3F6');
    expect(ws.getCell('H2').dataValidation.formulae[0]).toBe('"未付,部分付,已付"');
    const rules = ws.conditionalFormattings.flatMap((c) => c.rules.map((r) => `${c.ref} ${r.type} ${r.formulae?.[0] ?? ''}`));
    expect(rules.some((r) => /^H2:H3 expression OR\(.*未付/.test(r))).toBe(true);
    expect(ws.pageSetup.printArea).toBe('A1:H4');
    expect(ws.headerFooter.oddFooter).toMatch(/第 &P 页/);
  });

  it('预算表：实际超过预算标红；执行率自动写公式；合计行把“差异”公式列也加上，结果算对', async () => {
    const md = '## 预算执行\n| 类别 | 预算（万元） | 实际（万元） | 差异（万元） | 执行率 |\n|--|--|--|--|--|\n| 设备 | 120 | 135 | =C2-B2 | |\n| 软件 | 80 | 60 | =C3-B3 | |\n| 合计 | | | | |';
    const ws = await open((await makeXlsx(md, { theme: THEMES.business, kind: 'budget' })).blob);
    expect(ws.getCell('E2').value).toMatchObject({ formula: 'IFERROR(C2/B2,"")' });
    expect(ws.getCell('D4').value).toMatchObject({ formula: 'SUM(D2:D3)', result: -5 });
    const rules = ws.conditionalFormattings.flatMap((c) => c.rules.map((r) => r.formulae?.[0] ?? ''));
    expect(rules).toContain('AND(ISNUMBER(C2),C2>B2)');
  });

  it('台账：截止日期过了、还没完成的标橙；没有公式的表不加“蓝字 / 灰底”页眉', async () => {
    const md = '## 台账\n| 编号 | 事项 | 负责人 | 截止日期 | 状态 |\n|--|--|--|--|--|\n| 1 | 接口联调 | 张工 | 2026-10-20 | 进行中 |\n| 2 | 报告 | 王工 | 2026-10-10 | 已完成 |';
    const ws = await open((await makeXlsx(md, { theme: THEMES.business, kind: 'ledger' })).blob);
    const rules = ws.conditionalFormattings.flatMap((c) => c.rules.map((r) => r.formulae?.[0] ?? ''));
    expect(rules.some((f) => /D2<TODAY\(\),ISERROR\(SEARCH\("完成",E2\)\)/.test(f))).toBe(true);
    expect(ws.getCell('E2').dataValidation.formulae[0]).toMatch(/未开始,进行中,已完成,已逾期/);
    expect(ws.headerFooter.oddHeader).not.toMatch(/灰底/);
  });
});
