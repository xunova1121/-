/** PPT 模板库（智能体广场第3步）：10 个模板的风格配色存在、配图图案存在、样张缩略图在、样例内容排版无错误；选了模板时交给模型的说明 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PPT_TEMPLATES, PPT_TEMPLATE_IDS, TEMPLATE_SCENES, templateNote, templateArtPath, pptTemplate } from '../src/agent/pptTemplates.js';
import { artSvg, ART_MOTIFS } from '../src/agent/pptTemplateArt.js';
import { THEMES, REPORT_THEMES } from '../src/agent/themes.js';
import { ALL_STYLE_IDS } from '../src/agent/pptStyles.js';
import { makePptx } from '../src/agent/pptxWriter.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { agentFormNote } from '../src/agent/agentTurn.js';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAFCAIAAAD38zoCAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAA0BwIB8p4pqwAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const texts = (page) => page.items.filter(it => it.kind === 'text').map(it => (Array.isArray(it.text) ? it.text.map(r => r.text).join('') : String(it.text))).join('|');

describe('PPT 模板库', () => {
  it('10 个模板：编号唯一，风格、配色、场景、配图图案都存在，3 张样张缩略图都在', () => {
    expect(PPT_TEMPLATES).toHaveLength(10);
    expect(new Set(PPT_TEMPLATE_IDS).size).toBe(10);
    for (const t of PPT_TEMPLATES) {
      expect(ALL_STYLE_IDS, t.id).toContain(t.style);
      expect(THEMES[t.theme] || REPORT_THEMES[t.theme], t.id).toBeTruthy();
      expect(TEMPLATE_SCENES[t.scene], t.id).toBeTruthy();
      for (const [, motif] of t.art) expect(ART_MOTIFS, t.id).toContain(motif);
      for (const n of [1, 2, 3]) expect(fs.existsSync(path.join('src/assets/ppt-templates', `${t.id}-${n}.jpg`)), `${t.id}-${n}`).toBe(true);
    }
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
      const { info } = await makePptx({ title: t.name, content: t.sample, theme: THEMES[t.theme] || REPORT_THEMES[t.theme], style: t.style, loadImage: async () => PNG });
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
