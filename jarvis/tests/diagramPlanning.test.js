import { it, expect } from 'vitest';
import { planDiagramContent, DIAGRAM_PLANNING } from '../src/agent/diagramPlanning.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
const input = { path: '规划样例.svg', title: '虚构示范平台', layers: [{ title: '感知设备层', nodes: [{ id: 'a', title: '示范雷达RX-8', detail: '雷达8套，连接数据平台' }] }] };
const fact = { text: '雷达8套', source: 'user', excerpt: '配置雷达8套' };
it('原话关键数量入图、建议分开，不强造缺失层', () => {
  const plan = planDiagramContent({ ...input, contentPlan: { facts: [fact], recommendations: ['建议增加安全审计'] } }, [], '配置雷达8套');
  expect(plan.facts[0]).toMatchObject({ included: true, evidence: 'source_excerpt_matched' });
  expect(plan.recommendations).toEqual(['建议增加安全审计']);
  expect(plan.levels.find(item => item.label === '安全保障').layers).toEqual([]);
  expect(plan.coverage).toBe('declared_facts_matched');
});
it('原文不支持的数量、系统名和型号不得登记为事实', () => {
  for (const text of ['雷达9套', '不存在的平台', 'RX-9']) {
    expect(() => planDiagramContent({ ...input, contentPlan: { facts: [{ ...fact, text }] } }, [], '配置雷达8套')).toThrow(/原文/);
  }
});
it('有原文但漏画的事实在生成之前阻断', () => {
  expect(() => planDiagramContent({ ...input, contentPlan: { facts: [{ text: '终端16台', source: 'user', excerpt: '终端16台' }] } }, [], '终端16台')).toThrow(/未进入/);
});
it('按确切文件绑定原文，不从另一份同名材料借证据', () => {
  const contentPlan = { facts: [{ ...fact, source: '材料/原文.md' }] };
  expect(planDiagramContent({ ...input, contentPlan }, [{ path: '材料/原文.md', text: '配置雷达8套' }]).coverage).toBe('declared_facts_matched');
  expect(() => planDiagramContent({ ...input, contentPlan }, [{ path: '其他/原文.md', text: '配置雷达8套' }])).toThrow(/原文/);
});
it('旧输入仍可用，缺少登记不冒充全面覆盖，限额明确失败', () => {
  expect(planDiagramContent(input).coverage).toBe('not_checked');
  expect(() => planDiagramContent({ ...input, contentPlan: { facts: Array(81).fill(fact) } })).toThrow(/80条/);
  expect(DIAGRAM_PLANNING).toContain('设备型号');
});
it('真实工具先核对原文件，规划正文仅写工作文件，回执仅短指针', async () => {
  await workspace.write('示范材料.md', '配置雷达8套');
  const result = await createDiagramTool({}).run({ ...input, sources: [{ path: '示范材料.md', excerpt: '配置雷达8套' }], contentPlan: { facts: [{ ...fact, source: '示范材料.md' }], recommendations: ['建议统一审计'] } });
  const receipt = JSON.parse(result.split('\n')[1]);
  expect(receipt.contentPlan.factCount).toBe(1);
  expect(result).not.toContain('建议统一审计');
  const saved = JSON.parse(await workspace.readText(receipt.contentPlan.path));
  expect(saved.facts[0].source).toBe('示范材料.md');
  expect(saved.recommendations).toEqual(['建议统一审计']);
});
