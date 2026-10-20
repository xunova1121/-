import { normalizeBrief, readJson } from './workflowSchema.js';
import { simulationGuide, WRITING_RULES } from './workflowPolicy.js';

// 底稿和业务推演合并一次调用，原始要求仍随正文审查核对，不能只信模型摘录。
export async function generateTaskBrief(input, ask) {
  const output = await ask('briefing', {
    system: `你是文档业务分析员。先理解再推演，最后才组织章节。${WRITING_RULES}只输出JSON，不输出内部思维过程。`,
    prompt: `格式：${input.format}。${simulationGuide(input.format, input.task)}\n用户要求：\n${input.task}\n用户材料：\n${input.material}\n输出结构：{"brief":{"purpose":"用途与读者","requirements":["输入中逐字存在的明确要求片段，不漏核心需求"],"relationships":["参与方和关系"],"facts":["用户事实及出处"],"assumptions":["建议及假设前提"],"unknowns":["未知事项及影响的决策"],"direction":"推荐方向"},"scenarios":{"normal":["正常流"],"exceptions":["异常与责任"],"settlement":["资金、费用或核算流"],"acceptance":["可验证场景"],"structure":["根据推演形成的章节及论点"]}}。列表每项不超过1600字，每表最多12项；requirements最多40项且必须原话。五类推演列表均须有内容，不适用也说明原因。`
  });
  return normalizeBrief(readJson(output), input.task + '\n' + input.material);
}
