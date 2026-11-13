import { describe, it, expect } from 'vitest';
import { planDocument } from '../src/agent/documentPlan.js';
import { makePptx } from '../src/agent/pptxWriter.js';
import { THEMES } from '../src/agent/themes.js';
import { coverageIssues, userSections } from '../src/agent/selfCheck.js';

const REQ = `以下按目前能查到的第131集以后剧情，概括成5段；含剧透。
1. 深渊脱困，天运子追杀（131—132集）：王林被困潮汐深渊，炼化太古雷龙本源。
2. 化名许木，落脚冉云星（133集起）：王林进入罗天星域，化名“许木”。
3. 借势掌控冉云星：孙家老祖以八品次神丹设局，王林借拍卖会积累资源。
4. 与柳眉、幻家的冲突升级：柳眉以“幻眉”身份现身。
5. 再回联盟星域，进入新的追杀与救援：王林介入仙选族危机。
做一份5页PPT`;

describe('文档根子：不乱套模板、版式没照办要说、用户的分段要守住', () => {
  it('对不上任何场景（剧情梳理）时不套“项目方案与决策汇报”的规则', () => {
    const plan = planDocument({ format: 'pptx', task: REQ });
    expect(plan.templateId).toBe('ppt-general');
    expect(plan.rules.join('')).not.toMatch(/待决策|每页一个结论/);
    expect(planDocument({ format: 'pptx', task: '项目立项决策汇报' }).templateId).toBe('ppt-proposal');
    expect(planDocument({ format: 'docx', task: '旅行攻略' }).templateId).toBe('word-general');
  });

  it('写了“版式：步骤”但内容排不成：生成结果里告诉模型是哪一页、差什么', async () => {
    const out = await makePptx({ title: 't', content: '## 两件事\n版式：步骤\n- 一：先做这个\n- 二：再做那个', theme: THEMES.business });
    const warn = out.info.layoutIssues.find((x) => /版式：步骤/.test(x.text));
    expect(warn?.text).toMatch(/第 2 页.*3–7 条“标签：说明”/);
  });

  it('用户给了 5 段：认得出来；一段一页时不报，两段挤一页、漏段、顺序乱都报', () => {
    expect(userSections(REQ)).toEqual(['深渊脱困，天运子追杀', '化名许木，落脚冉云星', '借势掌控冉云星', '与柳眉、幻家的冲突升级', '再回联盟星域，进入新的追杀与救援']);
    const good = '## 深渊脱困，天运子追杀\n- 炼化雷龙本源\n## 化名许木，落脚冉云星\n- 进入罗天星域\n## 借势掌控冉云星\n- 拍卖会\n## 与柳眉、幻家冲突升级\n- 幻眉现身\n## 再回联盟星域：追杀与救援\n- 仙选族';
    expect(coverageIssues('pptx', REQ, good)).toEqual([]);
    const merged = '## 深渊脱困\n- 炼化雷龙本源\n## 化名许木后在冉云星卷入争斗\n- 化名：许木\n- 冲突：孙家老祖设局，借拍卖会掌控冉云星\n## 柳眉现身攻入幻家\n- 柳眉\n## 仙选族危局\n- 仙选族\n## 联盟星域的追杀与救援\n- 救援';
    expect(coverageIssues('pptx', REQ, merged).map((x) => x.text).join()).toMatch(/第 2 段和第 3 段挤在了同一页/);
    const missing = '## 深渊脱困，天运子追杀\n- a\n## 化名许木，落脚冉云星\n- b\n## 借势掌控冉云星\n- c\n## 与柳眉、幻家的冲突升级\n- d';
    expect(coverageIssues('pptx', REQ, missing).map((x) => x.text).join()).toMatch(/第 5 段「再回联盟星域/);
    expect(coverageIssues('pptx', '帮我做个PPT', good)).toEqual([]);
  });
});
