import { lookupIntent, LOOKUP_KINDS } from './intent.js';
import { withWebDeadline } from '../retrievalBudget.js';

/** 可选廉价分类只准返回kind；最多1秒，超时走general，不让它规划工具或增加参数。 */
export async function classifyLookupIntent(text, { classify, signal, ...options } = {}) {
  if (signal?.aborted) throw signal.reason;
  const result = lookupIntent(text, options);
  if (result.sure || !result.lookup || !classify) return result;
  try {
    const value = await withWebDeadline(activeSignal => classify({ text: String(text).slice(0, 1500), kinds: [...LOOKUP_KINDS], signal: activeSignal }), { signal, timeoutMs: 1000 });
    const kind = typeof value === 'string' ? value.trim() : value?.kind;
    if (!LOOKUP_KINDS.includes(kind)) return result;
    return { kind, params: {}, sure: true, lookup: kind !== 'meta', rule: 'cheap_classifier' };
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError' || error.code === 'RETRIEVAL_BUDGET') throw error;
    return result;
  }
}
