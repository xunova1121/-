import { describe, it, expect } from 'vitest';
import { makePptx } from '../src/agent/pptxWriter.js';
import { styleTokens, STYLE_IDS } from '../src/agent/pptStyles.js';
import { THEMES } from '../src/agent/themes.js';

const STORY = `## 深渊脱困，天运子追杀
- 王林被困潮汐深渊，炼化太古雷龙本源
- 从杜建口中得知天运子吞噬弟子的秘密
- 得到斩罗诀，遇见被困画轴的向家女子
## 化名许木，落脚冉云星
- 进入罗天星域，化名“许木”
- 以伪仙宝换取仙玉
- 重逢故友孙泰`;

/** 一页的“构图指纹”：放了哪些种类的东西、各几个 */
const shapeOf = (page) => page.items.map((it) => (it.kind === 'shape' ? it.type : it.kind)).sort().join(',');

describe('PPT 设计风格：构图真的不一样，不只是换颜色', () => {
  it('四种风格的规范各不相同；公文主题不管选什么风格都按公文排', () => {
    const t = STYLE_IDS.map((id) => styleTokens(id, THEMES.business));
    expect(new Set(t.map((x) => `${x.titleBar}/${x.icon}/${x.cover}/${x.bg}`)).size).toBe(4);
    expect(styleTokens('story', THEMES.gongwen).id).toBe('business');
  });

  it('同一份内容：四种风格的封面和正文页构图都不同；叙事风格是整页深底', async () => {
    const out = {};
    for (const style of STYLE_IDS) out[style] = (await makePptx({ title: '仙逆剧情', content: STORY, theme: THEMES.business, style })).info;
    const covers = STYLE_IDS.map((s) => shapeOf(out[s].preview[0]));
    const bodies = STYLE_IDS.map((s) => shapeOf(out[s].preview[1]));
    expect(new Set(covers).size).toBe(4);
    expect(new Set(bodies).size).toBe(4);
    const dark = (c) => parseInt(String(c).slice(0, 2), 16) < 0x60;
    expect(out.story.preview.every((p) => dark(p.background))).toBe(true);
    expect(out.business.preview.slice(1).every((p) => !dark(p.background))).toBe(true);
    // 连续两页普通要点：同一风格里换构图
    expect(shapeOf(out.story.preview[1])).not.toBe(shapeOf(out.story.preview[2]));
    for (const s of STYLE_IDS) expect(out[s].layoutIssues.filter((x) => x.level === 'error')).toEqual([]);
  });

  it('新版式：人物 / 结构页画成关系图；占比加起来 100% 画环形图；按季度排的数字画折线', async () => {
    const md = '## 主要人物关系\n王林\n- 柳眉：幻家背后的人\n- 天运子：一路追杀\n- 孙泰：故友\n\n## 资源占比\n| 家族 | 占比 |\n|--|--|\n| 冉家 | 40% |\n| 赵家 | 35% |\n| 孙家 | 25% |\n\n## 播放量\n| 季度 | 播放量 |\n|--|--|\n| 2025年Q1 | 1200 |\n| 2025年Q2 | 1500 |\n| 2025年Q3 | 1650 |\n| 2025年Q4 | 2100 |\n\n## 完成率\n| 项目 | 完成率 |\n|--|--|\n| 甲 | 80% |\n| 乙 | 60% |';
    const { info } = await makePptx({ title: 't', content: md, theme: THEMES.business, style: 'data' });
    expect(info.layouts).toEqual(['cover', 'relation', 'chart-pie', 'chart-line', 'progress']);
    const rel = info.preview[1].items.filter((it) => it.kind === 'text').map((it) => String(it.text));
    expect(rel).toContain('王林');
  });

  it('“版式：柱状图 / 饼图 / 折线图”可以指定图形', async () => {
    const md = '## 播放量\n版式：柱状图\n| 季度 | 播放量 |\n|--|--|\n| 2025年Q1 | 1200 |\n| 2025年Q2 | 1500 |\n| 2025年Q3 | 1650 |\n| 2025年Q4 | 2100 |';
    expect((await makePptx({ title: 't', content: md, theme: THEMES.business })).info.layouts[1]).toBe('chart');
  });

  it('叙事风格：剧情一件件往下讲，连着 5 页要点不提醒“单调”（构图在轮换）；商务风格照样提醒', async () => {
    const md = Array.from({ length: 5 }, (_, k) => `## 第${k + 1}段\n- 王林做了第一件事\n- 接着发生第二件事\n- 最后引出第三件事`).join('\n');
    const warn = async (style) => (await makePptx({ title: 't', content: md, theme: THEMES.business, style })).info.layoutIssues.some((x) => /单调/.test(x.text));
    expect(await warn('story')).toBe(false);
    expect(await warn('business')).toBe(true);
  });
});
