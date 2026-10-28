import * as workspace from './workspace.js';
import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';
export const REVIEW_KINDS = ['classification', 'ownership', 'dependency', 'flow', 'coverage'];
const invalid = (field, action) => Object.assign(new Error('审查回复字段未通过：' + field), {
  code: 'ARCHITECTURE_REVIEW_FORMAT', kind: 'input', diagnostics: [{ field, stage: 'format', action }]
});
/** 仅供模型输入的编号；不修改已保存底稿或要求模型数数组下标。 */
export function architectureReviewInput(plan) {
  return {
    ...plan,
    entities: plan.entities.map(item => ({ ...item, reviewTarget: 'entity:' + item.id })),
    relations: plan.relations.map((item, index) => ({ ...item, reviewTarget: 'relation:' + index })),
    requirements: plan.requirements.map((item, index) => ({ ...item, reviewTarget: 'requirement:' + index }))
  };
}
/** 原12000字符/16项/240字门槛保持；错误指出字段，不能将非法意见当无问题。 */
export function parseArchitectureReview(text, plan, stop = 'unknown') {
  if (typeof text !== 'string') throw invalid('response.text', '审查模型必须返回可见JSON文本');
  if (text.length > 12000 || ['max_tokens', 'length'].includes(stop)) throw invalid('response.length', '回复超限或被截断，不能补括号、删意见或假称通过');
  let value;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalid('response.json', '只返回约定的完整JSON；原始回复和停止类型已按实际调用保存');
  }
  if (!value || typeof value.passed !== 'boolean') throw invalid('review.passed', 'passed必须是布尔值，不能用字符串或口头结论');
  if (!Array.isArray(value.issues) || value.issues.length > 16) throw invalid('review.issues', 'issues必须是最多16项的数组，不丢弃意见换通过');
  const targets = new Set(['plan', ...plan.entities.map(item => 'entity:' + item.id), ...plan.relations.map((_, index) => 'relation:' + index), ...plan.requirements.map((_, index) => 'requirement:' + index)]);
  for (const [index, issue] of value.issues.entries()) {
    if (!targets.has(issue?.target)) throw invalid('review.issues[' + index + '].target', 'target逐字使用输入reviewTarget或plan，不用对象名称、虚构ID或JSON路径');
    if (!REVIEW_KINDS.includes(issue.kind)) throw invalid('review.issues[' + index + '].kind', 'kind只能从' + REVIEW_KINDS.join('、') + '中选一个');
    if (typeof issue.detail !== 'string' || !issue.detail.trim() || issue.detail.length > 240) throw invalid('review.issues[' + index + '].detail', 'detail必须为1～240字的具体意见');
  }
  return value;
}
/** 真实底稿入口每份最多初次/恢复两份回复，原文本最多12000字符，配置/headers不写盘。 */
export async function saveArchitectureReviewResponse(response, options = {}) {
  throwControl(null, options.signal);
  const text = typeof response === 'string' ? response : response?.text;
  const stop = typeof response?.stop === 'string' ? response.stop.slice(0, 80) : 'unknown';
  if (!options.reviewPath) return { text, stop, receipt: {} };
  const digest = await diagramDigest(options.reviewPath);
  const base = '文档检查/架构审查回复/' + digest.split(':').at(-1) + '.response-' + (options.reviewAttempt === 1 ? 1 : 0);
  const responsePath = base + '.txt', responseMetaPath = base + '.meta.json';
  const captured = typeof text === 'string' ? text.slice(0, 12000) : '';
  await workspace.writeArchitectureState(responsePath, captured);
  await workspace.writeArchitectureState(responseMetaPath, JSON.stringify({
    stop, receivedText: typeof text === 'string', chars: typeof text === 'string' ? text.length : 0,
    capturedChars: captured.length, captureTruncated: typeof text === 'string' && text.length > 12000
  }));
  for (const path of [responsePath, responseMetaPath]) await options.checkpoint?.({ type: 'file', path });
  return { text, stop, receipt: { responsePath, responseMetaPath, responseStop: stop } };
}
