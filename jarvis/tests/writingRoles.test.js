import { describe, it, expect } from 'vitest';
import { detectRole, roleGuide, roleReview, hedges, hedgeIssue } from '../src/app/doc/writingRoles.js';
import { createDocumentWorkflow } from '../src/app/doc/documentWorkflow.js';
import { fixture, review } from './helpers/documentWorkflowCases.js';

// 用户 2026-10-26 实际收到的那份“满篇推辞”的方案里的句子
const HEDGY = '本文为基于讨论稿的需求拆解，用于范围评审和接口协调，不构成文件未明确规定的验收标准。接口字段细则应在需求基线中另行确认。上述内容不代表相关单位已承诺具体交付。责任边界见下表。开发前应由项目方确认终端编码，未统一前不宜承诺跨设备互通效果。';

describe('写作角色：认场景', () => {
  it('用户点名的角色优先；再按文种和用途认；认不出返回 null（沿用原写法）', () => {
    expect(detectRole('用高级售前经理的口吻写一份方案')).toBe('presales');
    expect(detectRole('作为一个严谨的法务，审一下这份合同')).toBe('legal');
    expect(detectRole('以项目经理的身份写个周报')).toBe('pm');
    expect(detectRole('把这份需求整理成给客户汇报的方案')).toBe('presales');
    expect(detectRole('写一份海洋渔业宽带卫星组网的技术方案')).toBe('solution');
    expect(detectRole('出一份系统上线的实施方案')).toBe('implementation');
    expect(detectRole('帮我看看采购合同的违约条款')).toBe('legal');
    expect(detectRole('写一份本周工作周报')).toBe('pm');
    expect(detectRole('整理一下会议纪要')).toBeNull();
  });

  it('对外角色的写法要求：主动给方案、不满篇推辞、需拍板的集中放文末；法务反而要写细边界', () => {
    expect(roleGuide('presales')).toMatch(/我方推荐.*可根据贵方实际调整/);
    expect(roleGuide('presales')).toContain('实施前双方确认事项');
    expect(roleGuide('presales')).toContain('不构成承诺');
    expect(roleGuide('legal')).toContain('正是要写细');
    expect(roleGuide('legal')).not.toContain('这是对外文档');
    expect(roleReview('presales')).toContain('must_fix');
    expect(roleGuide(null)).toBe('');
  });

  it('数得出推辞话术；对外文档太多就要求改，内部分析和法务不管', () => {
    expect(hedges(HEDGY).length).toBeGreaterThanOrEqual(5);
    expect(hedgeIssue('presales', HEDGY)).toMatchObject({ severity: 'must_fix', location: '全文' });
    expect(hedgeIssue('presales', HEDGY).problem).toContain('没法拿去汇报');
    expect(hedgeIssue('legal', HEDGY)).toBeNull();
    expect(hedgeIssue(null, HEDGY)).toBeNull();
    expect(hedgeIssue('presales', '我们将为贵方建设统一的船岸一体化平台，分三期实施。')).toBeNull();
  });
});

/** 最小的文档流程替身：按顺序返回模型回答，记下每次请求 */
function harness(responses) {
  const files = new Map();
  const prompts = [];
  const workspace = {
    normalize: (v) => v,
    list: async (prefix) => [...files.keys()].filter((p) => p.startsWith(prefix + '/')).map((p) => ({ path: p })),
    write: async (p, text) => {
      files.set(p, String(text));
      return { path: p };
    },
    readBlob: async (p) => new Blob([files.get(p)])
  };
  const llm = async (request) => {
    prompts.push(request);
    const value = responses.shift();
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { prompts, workflow: createDocumentWorkflow({ llm, documentWorkspace: workspace }), execution: { sessionId: 's1', checkpoint: async () => {} } };
}

describe('写作角色接进文档流程', () => {
  const task = '把需求整理成给客户汇报的方案，必须写电子秤自动称重，并对接银行结算。';
  const hedgyDraft = `# 方案\n\n电子秤自动称重。对接银行结算。\n\n${HEDGY}`;
  const fixed = '# 方案\n\n我们将为贵方实现电子秤自动称重，并对接银行结算，分两期上线。';

  it('认出是给客户的：撰稿、推演、审查都带上售前角色；推辞太多程序自动要求改写，改完再复核', async () => {
    const h = harness([fixture(), hedgyDraft, review(), { edits: [{ find: hedgyDraft.slice(2, 40), replace: fixed.slice(2) }] }, review()]);
    const result = await h.workflow.run({ task, format: 'docx' }, h.execution);
    const systems = h.prompts.map((p) => p.system);
    expect(systems[0]).toContain('【写作角色：高级售前经理】');
    expect(systems[1]).toContain('以高级售前经理的身份写');
    expect(systems[2]).toContain('按“高级售前经理”的标准审');
    // 审查模型说没问题，但程序数出推辞话术太多：照样进入修订
    expect(h.prompts[3].prompt).toContain('推辞、自保的话');
    expect(h.prompts).toHaveLength(5);
    expect(result.depth).toBe('expert');
  });

  it('明确要内部分析口吻（role: internal）：不加角色、不查推辞话术', async () => {
    const h = harness([fixture(), hedgyDraft, review()]);
    await h.workflow.run({ task, format: 'docx', role: 'internal', depth: 'expert' }, h.execution);
    expect(h.prompts.map((p) => p.system).join('\n')).not.toContain('写作角色');
    expect(h.prompts).toHaveLength(3);
  });
});
