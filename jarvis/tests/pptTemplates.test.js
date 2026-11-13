/** PPT 模板库（智能体广场第3步）：10 个模板的风格配色存在、配图图案存在、样张缩略图在、样例内容排版无错误；选了模板时交给模型的说明 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PPT_TEMPLATES, PPT_TEMPLATE_IDS, TEMPLATE_SCENES, templateNote, templateArtPath, pptTemplate } from '../src/agent/pptTemplates.js';
import { artSvg, ART_MOTIFS } from '../src/agent/pptTemplateArt.js';
import { THEMES, themeById } from '../src/agent/themes.js';
import { ALL_STYLE_IDS } from '../src/agent/pptStyles.js';
import { makePptx } from '../src/agent/pptxWriter.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { agentFormNote } from '../src/agent/agentTurn.js';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAFCAIAAAD38zoCAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAA0BwIB8p4pqwAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const texts = (page) => page.items.filter(it => it.kind === 'text').map(it => (Array.isArray(it.text) ? it.text.map(r => r.text).join('') : String(it.text))).join('|');

describe('PPT 模板库', () => {
  it('10 个模板：编号唯一，风格、配色、场景、配图图案都存在，3 张样张缩略图都在', () => {
    // 第一批 10 个一个都不能少（第二批另有守护）
    for (const id of ['gov-progress', 'gov-annual', 'eco-park', 'work-summary', 'startup-pitch', 'training', 'data-report', 'product-launch', 'festival-event', 'simple-general']) expect(PPT_TEMPLATE_IDS).toContain(id);
    expect(new Set(PPT_TEMPLATE_IDS).size).toBe(PPT_TEMPLATE_IDS.length);
    for (const t of PPT_TEMPLATES) {
      expect(ALL_STYLE_IDS, t.id).toContain(t.style);
      expect(themeById(t.theme), t.id).toBeTruthy();
      expect(TEMPLATE_SCENES[t.scene], t.id).toBeTruthy();
      for (const [, motif] of t.art) expect(ART_MOTIFS, t.id).toContain(motif);
      for (const n of [1, 2, 3]) expect(fs.existsSync(path.join('src/assets/ppt-templates', `${t.id}-${n}.jpg`)), `${t.id}-${n}`).toBe(true);
    }
  });
  it('第二批 6 个：借鉴 GitHub 上 MIT 开源项目的思路，注明出处；咨询、复盘、技术、学术类带写法说明', () => {
    const second = ['violet-glass', 'academic-report', 'consulting-decision', 'operating-review', 'tech-review', 'incident-review'];
    expect(PPT_TEMPLATES).toHaveLength(16);
    for (const id of second) {
      const t = pptTemplate(id);
      expect(t, id).toBeTruthy();
      expect(t.credit, id).toMatch(/MIT/);
    }
    for (const id of second.slice(1)) expect(pptTemplate(id).method, id).toBeTruthy();
    expect(templateNote('incident-review')).toContain('写法：');
    expect(themeById('violet-glass').name).toBe('紫韵');
    expect(themeById('academic-blue').name).toBe('学术蓝');
  });
  it('原创配图：只用简单图形，不引用外部图片、字体或脚本', () => {
    for (const motif of ART_MOTIFS) {
      const svg = artSvg(motif, THEMES.business.colors);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toMatch(/<image|<script|href=|@import|url\(http/);
    }
    expect(() => artSvg('nope', THEMES.business.colors)).toThrow();
  });
  it('样例内容用排版引擎生成：有封面配图、无排版错误、不缺图', async () => {
    for (const t of PPT_TEMPLATES) {
      const { info } = await makePptx({ title: t.name, content: t.sample, theme: themeById(t.theme), style: t.style, loadImage: async () => PNG });
      expect(info.layoutIssues.filter(x => x.level === 'error'), t.id).toEqual([]);
      expect(info.missingImages, t.id).toEqual([]);
      expect(info.slides, t.id).toBeGreaterThanOrEqual(4);
    }
  });
  it('选了模板：PPT 制作智能体的表单接受模板编号，交给模型的说明写清风格配色、结构和配图路径', () => {
    const ppt = BUILTIN_AGENTS.find(p => p.id === 'ppt-maker');
    expect(ppt.form.find(f => f.key === 'template').options).toEqual([...PPT_TEMPLATE_IDS]);
    const note = agentFormNote(ppt, { template: 'gov-annual', pages: '6-10' });
    expect(note).toContain('模板「年度工作汇报」');
    expect(note).toContain('style=report、theme=gov-red');
    expect(note).toContain(templateArtPath('gov-annual', 'cover'));
    expect(note).toContain('页数 6-10');
    expect(agentFormNote(ppt, { template: 'not-a-template' })).toBe('');
    expect(templateNote('nope')).toBe('');
    expect(pptTemplate('training').name).toBe('培训课件');
  });
});

describe('排版引擎：模板样张发现的两个问题', () => {
  it('“3个月”是一个单位，不拆成“3个”和“月”', async () => {
    const { info } = await makePptx({ title: 'x', content: '## 概况\n\n- 12项：任务完成\n- 98%：覆盖率\n- 3个月：比计划提前', theme: THEMES.business, style: 'business' });
    const page = texts(info.preview.at(-1));
    expect(page).toContain('3个月');
    expect(page).not.toMatch(/月：比计划提前/);
  });
  it('时刻“14:00 签到”不当成数字，也不按冒号拆成标签', async () => {
    const { info } = await makePptx({ title: 'x', content: '## 活动流程\n\n1. 14:00 签到入场\n2. 14:30 领导致辞\n3. 15:00 游戏互动', theme: THEMES.business, style: 'business' });
    const page = texts(info.preview.at(-1));
    expect(page).toContain('14:00');
    expect(page).not.toMatch(/(^|\|)00 签到入场/);
  });
});

describe('排版引擎：第二批模板样张发现的问题', () => {
  it('每行单位不同的指标表不画成同一根纵轴的柱状图', async () => {
    const md = '## 实际与计划\n\n| 指标 | 实际 | 计划 |\n|---|---|---|\n| 营收（万元） | 960 | 1000 |\n| 新客户（家） | 42 | 40 |\n| 毛利率（%） | 38 | 40 |';
    const { info } = await makePptx({ title: 'x', content: md, theme: THEMES.business, style: 'business' });
    expect(info.layouts.at(-1)).toBe('table');
  });
  it('“4.8分：满意度”当成大数字', async () => {
    const { info } = await makePptx({ title: 'x', content: '## 概览\n\n- 36个：上线需求\n- 4.8分：用户满意度\n- 2倍：活跃增长', theme: THEMES.business, style: 'business' });
    expect(info.layouts.at(-1)).toBe('stats');
    expect(texts(info.preview.at(-1))).toContain('4.8');
  });
});
