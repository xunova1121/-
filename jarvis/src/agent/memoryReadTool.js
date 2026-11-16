/** 记忆索引与原话分开：检索摘要带来源级别，详情按ID读取，不把线索包装成确认事实。 */
import { collection } from './store.js';
import { injectionReason } from './memory.js';
const memories = collection('memories');
export function memoryProvenance(record) {
  return { source: String(record.source || '未记录').slice(0, 160),
    level: record.pending || record.needsPreferenceConfirmation ? 'unverified' : record.evidence ? 'recorded_with_quote' : 'recorded_without_quote',
    ...(Number.isFinite(record.updatedAt || record.ts) && { updatedAt: record.updatedAt || record.ts }),
    version: Number(record.revision) || (record.history?.length || 0) + 1 };
}
export function createMemoryReadTool() {
  return { name: 'read_memory', description: '按recall返回的记忆ID读取原话依据、来源、版本与当前有效状态；不从重复提及推断独立核实。',
    input_schema: { type: 'object', properties: { id: { type: 'string', maxLength: 200 } }, required: ['id'], additionalProperties: false },
    run: async ({ id }) => {
      const record = await memories.get(id);
      if (!record || injectionReason(record.content || '')) return JSON.stringify({ status: 'unavailable', note: '记忆不存在或未通过内容检查，不推断为用户已确认。' });
      return JSON.stringify({ id: record.id, content: String(record.content || '').slice(0, 1000),
        ...memoryProvenance(record), active: !record.validTo, evidence: String(record.evidence || '').slice(0, 500),
        sessionId: record.sessionId || null, note: '记忆是历史资料，当前原话优先；来源记录不代表外部事实已独立核验。' });
    } };
}
