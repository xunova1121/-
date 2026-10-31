import { STYLE_DIRECTIVE } from '../core/responseRevision.js';
const CARE = /产检|孕检|体检|化验|检查单|检查报告|糖耐|胎儿|胎心|孕周|三尖瓣|宠物.*(?:检查|报告)|陪诊/;
const WRITING = /文章|写作|方案|报告|文案|论文|措辞|论证/;
const STYLE = /安抚|共情|感受|通俗|温柔|贴心|冷冰冰|简洁|简短|深入|论证|口吻|语气|风格|陪诊|安慰/;
const QUOTED = /假设|示例|引用|对话记录|翻译|转述|他说|她说|同事说/;
export function communicationScope(text = '') {
  const value = String(text).slice(0, 1200);
  if (QUOTED.test(value) || !STYLE_DIRECTIVE.test(value) || !STYLE.test(value)) return null;
  return CARE.test(value) ? 'care' : WRITING.test(value) ? 'writing' : 'general';
}
const concepts = (text) =>
  [/(?:安抚|共情|感受|温柔|贴心|冷冰冰|陪诊|安慰)/, /通俗|好懂|解释/, /简洁|简短/, /深入|论证|分析/, /语气|口吻|风格/].map((re) => re.test(text));
export function communicationPreferenceSupported(content, evidence) {
  if (!communicationScope(evidence) || !/^(?:用户(?:希望|要求|偏好)|以后|回答|解读)/.test(String(content))) return false;
  if (/\d|确诊|患有|保证|肯定没事|忽略风险/.test(String(content)) || !STYLE.test(String(content))) return false;
  const noComfort = (text) => /(?:不要|不用|不必|不需要|不想|别|无需)[^，,。；;\n]{0,6}(?:安抚|安慰|共情|温柔|贴心|陪诊|照顾.{0,4}感受)/.test(text);
  if (concepts(content)[0] && noComfort(content) !== noComfort(evidence)) return false;
  const claims = concepts(String(content)),
    proof = concepts(String(evidence));
  return claims.every((has, index) => !has || proof[index]);
}
export const recordScope = (record) =>
  (!record.category || record.category === 'preference') && String(record.content || '').length <= 600 && STYLE.test(String(record.content || ''))
    ? (['care', 'writing', 'general'].includes(record.communicationScope) ? record.communicationScope : null) ||
      communicationScope(record.context || record.evidence || '')
    : null;
export function matchesCommunication(record, query) {
  const scope = recordScope(record);
  return scope === 'general' || (scope === 'care' && CARE.test(query)) || (scope === 'writing' && WRITING.test(query));
}
/** 同一表达范围只带最新一条，最多3条；删除记录后直接消失，不从缓存或旧摘要恢复。 */
export function communicationRecords(records, query) {
  const latest = new Map();
  for (const item of [...records].sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0))) {
    const scope = recordScope(item);
    if (scope && !latest.has(scope)) latest.set(scope, item);
  }
  return [...latest.values()].filter((item) => matchesCommunication(item, query)).slice(0, 3);
}
