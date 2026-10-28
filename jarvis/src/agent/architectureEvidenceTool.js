import { checkSources } from './diagramSources.js';
import { architectureEvidence, EVIDENCE_LIMITS } from './architectureEvidence.js';
import { throwControl } from '../core/networkRequest.js';
export const architectureSourceSchema = {
  type: 'array', minItems: 1, maxItems: 4,
  items: { type: 'object', properties: {
    path: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 },
    sectionStart: { type: 'string', maxLength: 300 }, sectionEnd: { type: 'string', maxLength: 300 }
  }, required: ['path'], additionalProperties: false }
};
export function createArchitectureEvidenceTool() {
  return {
    name: 'prepare_architecture_evidence',
    description: '首次架构图先从选定原文件/唯一章节提取连续原文证据编号，不调用模型。sources回填plan_architecture，逐对象/关系/需求只引用evidenceId，无需手抄source/excerpt。分页/关键词查询只返回部分片段，不等于模型已看完全部；完整规划要读完相关范围。材料变化后重新取号，不能靠编号绕过业务审查。',
    input_schema: { type: 'object', properties: {
      sources: architectureSourceSchema,
      query: { type: 'string', maxLength: 120, description: '可选原文关键词；精确包含匹配，不命中时改词或取消过滤' },
      offset: { type: 'integer', minimum: 0, maximum: 4096 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
    }, required: ['sources'], additionalProperties: false },
    run: async ({ sources, query = '', offset = 0, limit = 12 }, { signal, progress } = {}) => {
      throwControl(null, signal);
      if (!Number.isInteger(offset) || offset < 0 || offset > EVIDENCE_LIMITS.entries || !Number.isInteger(limit) || limit < 1 || limit > EVIDENCE_LIMITS.page || typeof query !== 'string' || query.length > 120)
        throw Object.assign(new Error('证据分页/关键词超限：offset 0～4096，limit 1～20，query最多120字符'), { code: 'ARCHITECTURE_EVIDENCE', kind: 'input' });
      progress?.('正在从选定原文提取可核对的证据编号…');
      const { materials, checks } = await checkSources(sources, signal);
      const all = await architectureEvidence(materials, checks, signal);
      const filtered = query ? all.filter(item => item.text.includes(query)) : all;
      const items = filtered.slice(offset, offset + limit);
      return JSON.stringify({ sources, readMaterials: checks.map((item, index) => ({ path: item.path, chars: materials[index].text.length, truncated: item.truncated, ...(item.scope && { scope: item.scope, sectionStart: item.sectionStart, sectionEnd: item.sectionEnd }) })), total: all.length, matched: filtered.length, offset, nextOffset: offset + items.length < filtered.length ? offset + items.length : null, items, note: '编号只证明选定文件范围内存在连续原文；分页或过滤不是全文业务覆盖。引用编号仍须原需求核对、业务审查及真实导出。' });
    }
  };
}
