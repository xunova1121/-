import { boundedText, LIMITS, readJson, workflowError } from './workflowSchema.js';

export function applyRevisions(draft, value) {
  if (!Array.isArray(value.edits) || value.edits.length > LIMITS.edits) throw workflowError('定点修订数量无效', 'DOCUMENT_RESPONSE');
  let revised = draft;
  for (const item of value.edits) {
    const find = boundedText(item.find, 8000, '原文片段', true);
    const replacement = boundedText(item.replace, 16000, '替换内容');
    const first = revised.indexOf(find);
    if (find.length < 8 || first < 0 || revised.indexOf(find, first + 1) >= 0) {
      throw workflowError('修改片段必须唯一匹配，保留原稿，不猜测修改位置', 'DOCUMENT_REVISION_CONFLICT');
    }
    revised = revised.slice(0, first) + replacement + revised.slice(first + find.length);
  }
  boundedText(revised, LIMITS.draft, '修订正文', true);
  if (revised.trim().length < draft.trim().length * 0.5) throw workflowError('修订删除过多正文，保留原稿', 'DOCUMENT_REVISION_CONFLICT');
  return revised;
}

export async function reviseDocument(input, plan, draft, review, ask) {
  const output = await ask('revising', {
    system: '你是文档编辑，仅修复审查指出的问题。不能新增无依据事实、删除用户明确要求或擅自降级。只输出JSON。',
    prompt: `要求：${input.task}\n材料：${input.material}\n底稿与推演：${JSON.stringify(plan)}\n审查：${JSON.stringify(review)}\n正文：\n${draft}\n输出{"edits":[{"find":"原文中唯一匹配的片段，至少8字","replace":"替换内容，建议标明前提，不重复堆待确认"}]}，最多24处。不得重写无关章节；不适用修改留空数组并由复核保留未解决项。`
  });
  return applyRevisions(draft, readJson(output));
}
