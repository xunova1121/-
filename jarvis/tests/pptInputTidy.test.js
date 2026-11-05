/** 用户 2026-11-05 发来的“全国城轨格局与南京定位”三页 PPT：十强表并排两半画成横轴 1–5 的图、封面带文件名尾巴、没用政企风格 */
import { describe, it, expect } from 'vitest';
import { makePptx } from '../src/agent/pptxWriter.js';
import { deckTitle } from '../src/agent/pptInputTidy.js';
import { THEMES } from '../src/agent/themes.js';
import { chooseDesign } from '../src/agent/documentDesign.js';

const MD = `## 二、里程十强：京沪超900公里，南京列第7

| 排名 | 城市 | 里程（公里） | 排名 | 城市 | 里程（公里） |
|---|---|---|---|---|---|
| 1 | 上海 | 909 | 6 | 武汉 | 597 |
| 2 | 北京 | 882 | 7 | 南京 | 557 |
| 3 | 广州 | 773 | 8 | 杭州 | 516 |
| 4 | 成都 | 720 | 9 | 重庆 | 512 |
| 5 | 深圳 | 654 | 10 | 西安 | 404 |`;

describe('PPT 输入整理', () => {
  it('并排两半的排名表：接成一张长表，城市名都在，排名不当数据', async () => {
    const { info } = await makePptx({ title: '十强', content: MD, theme: THEMES.business, style: 'business' });
    const page = JSON.stringify(info.preview[1]);
    for (const city of ['上海', '南京', '西安']) expect(page).toContain(city);
    expect(page).not.toMatch(/排名：1/);
    expect(info.layouts).toEqual(['cover', 'table']);
  });
  it('行数少时画成柱状图：横轴是城市名，不是 1、2、3', async () => {
    const short = MD.split('\n').slice(0, 6).join('\n');
    const { info } = await makePptx({ title: '十强', content: short, theme: THEMES.business, style: 'business' });
    expect(info.layouts).toContain('chart');
    const chart = info.preview[1].items.find(it => it.kind === 'chart');
    expect(JSON.stringify(chart)).toContain('南京');
    expect(JSON.stringify(info.preview[1])).not.toMatch(/排名：/);
  });
  it('封面标题去掉“_三页_政企汇报”这类尾巴', () => {
    expect(deckTitle('全国城轨格局与南京定位_三页_政企汇报')).toBe('全国城轨格局与南京定位');
    expect(deckTitle('智慧园区_v2')).toBe('智慧园区');
    expect(deckTitle('南京_无锡对比')).toBe('南京 无锡对比');
    expect(deckTitle('普通标题')).toBe('普通标题');
  });
  it('标题里写了政企汇报，表格多也用政企风格', () => {
    const two = '| a | b |\n|---|---|\n| 1 | 2 |\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(chooseDesign({ format: 'pptx', title: '全国城轨格局与南京定位_三页_政企汇报', content: two }).style).toBe('report');
    expect(chooseDesign({ format: 'pptx', title: '季度数据', content: two }).style).toBe('data');
  });
});
