import { LIMITS, readJson, workflowError } from './workflowSchema.js';

/**
 * 按原文片段定点修改。片段对不上或不唯一的那条跳过（不猜位置），其余照改；
 * 以前一条对不上就整批作废、整篇报错，现在只丢那一条。改完删掉一半以上正文的，保留原稿。
 * @param {{ skipped?: number }} [report] 跳过了几条记在这里
 * @returns {string} 修改后的正文
 */
export function applyRevisions(draft, value, report = {}) {
  if (!value || !Array.isArray(value.edits)) throw workflowError('定点修订格式无效', 'DOCUMENT_RESPONSE');
  let revised = draft;
  let skipped = 0;
  for (const item of value.edits.slice(0, LIMITS.edits)) {
    const find = String(item?.find ?? '');
    const replacement = String(item?.replace ?? '').slice(0, 16000);
    const first = find.length >= 8 ? revised.indexOf(find) : -1;
    if (first < 0 || revised.indexOf(find, first + 1) >= 0) {
      skipped++;
      continue;
    }
    revised = revised.slice(0, first) + replacement + revised.slice(first + find.length);
  }
  report.skipped = skipped;
  if (revised.length > LIMITS.draft || revised.trim().length < draft.trim().length * 0.5) return draft;
  return revised;
}

export async function reviseDocument(input, plan, draft, review, ask, report = {}) {
  const output = await ask('revising', {
    system: '你是文档编辑，仅修复审查指出的问题。不能新增无依据事实、删除用户明确要求或擅自降级。只输出JSON。',
    prompt: `要求：${input.task}\n材料：${input.material}\n底稿与推演：${JSON.stringify(plan)}\n审查：${JSON.stringify(review)}\n正文：\n${draft}\n输出{"edits":[{"find":"原文中唯一匹配的片段，至少8字","replace":"替换内容，建议标明前提，不重复堆待确认"}]}，最多24处。不得重写无关章节；不适用修改留空数组并由复核保留未解决项。`
  });
  return applyRevisions(draft, readJson(output), report);
}
