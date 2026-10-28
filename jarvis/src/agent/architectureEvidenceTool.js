import {readCurrentDocument} from './documentNavigation.js';
import {documentSectionCatalog} from './documentSections.js';
import { checkSources } from './diagramSources.js';
import { architectureEvidence, EVIDENCE_LIMITS } from './architectureEvidence.js';
import { throwControl } from '../core/networkRequest.js';
export const architectureSourceSchema = {
  type: 'array', minItems: 1, maxItems: 4,
  items: { type: 'object', properties: {
    path: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 },
    sectionId:{type:'string',maxLength:120,description:'程序目录返回的真实编号；优先使用，不与sectionStart/End混用'}, sectionStart: { type: 'string', maxLength: 300 }, sectionEnd: { type: 'string', maxLength: 300 }
  }, required: ['path'], additionalProperties: false }
};
export function createArchitectureEvidenceTool(ctx = {}) {
  return {
    name: 'prepare_architecture_evidence',
    description: '首次先用catalog:true及sources:[{path}]取得真实章节编号，可query按标题筛选；选择编号后用sources:[{path,sectionId}]读取证据。不猜章节/摘录，不靠offset+1重扫整份文件。目录不是正文。首次架构图先从选定原文件/唯一章节提取连续原文证据编号，不调用模型。sources回填plan_architecture，逐对象/关系/需求只引用evidenceId，无需手抄source/excerpt。分页/关键词查询只返回部分片段，不等于模型已看完全部；完整规划要读完相关范围。材料变化后重新取号，不能靠编号绕过业务审查。',
    input_schema: { type: 'object', properties: {
      sources: architectureSourceSchema,
      catalog:{type:'boolean',description:'只读程序目录，不调用模型；query筛目录标题，offset/limit为目录分页'},
      query: { type: 'string', maxLength: 120, description: '可选原文关键词；精确包含匹配，不命中时改词或取消过滤' },
      offset: { type: 'integer', minimum: 0, maximum: 4096 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
    }, required: ['sources'], additionalProperties: false },
    run: async ({ sources, query = '', offset = 0, limit = 12,catalog=false }, { signal, progress } = {}) => {
      throwControl(null, signal);
      if (!Number.isInteger(offset) || offset < 0 || offset > EVIDENCE_LIMITS.entries || !Number.isInteger(limit) || limit < 1 || limit > EVIDENCE_LIMITS.page || typeof query !== 'string' || query.length > 120)
        throw Object.assign(new Error('证据分页/关键词超限：offset 0～4096，limit 1～20，query最多120字符'), { code: 'ARCHITECTURE_EVIDENCE', kind: 'input' });
      const readDocument=ctx.readDocument||readCurrentDocument;
      if(catalog){
        if(!Array.isArray(sources)||!sources.length||sources.length>4)throw Object.assign(new Error('目录来源需1～4份明确文件'),{code:'DIAGRAM_SOURCE_SIZE',kind:'input'});
        const seen=new Set(),documents=[];
        for(const source of sources){throwControl(null,signal);if(seen.has(source.path))continue;seen.add(source.path);documents.push(await documentSectionCatalog(await readDocument(source.path,{signal}),{query,offset,limit}));}
        return JSON.stringify({state:'catalog',documents,note:'目录仅证明真实范围；用path/sectionId再取证据，不能将目录当作读完采购需求或任务完成。'});
      }
      progress?.('正在从选定原文提取可核对的证据编号…');
      const { materials, checks } = await checkSources(sources, signal,readDocument);
      let all;
      try{all=await architectureEvidence(materials,checks,signal);}catch(error){throwControl(error,signal);if(error.code==='ARCHITECTURE_EVIDENCE'&&checks.some(item=>item.scopeOptions))error.diagnostics.push(...checks.filter(item=>item.scopeOptions).map(item=>({stage:'source',field:'sources.sectionId',scopeOptions:item.scopeOptions,action:'使用返回的scopeOptions真实编号；可catalog:true查询更多目录，不要猜章节'})));throw error;}
      const filtered = query ? await architectureEvidence(materials, checks, signal, query) : all;
      const items = filtered.slice(offset, offset + limit);
      return JSON.stringify({ sources, readMaterials: checks.map((item, index) => ({ path: item.path, chars: materials[index].text.length, truncated: item.truncated, ...(item.scope && { scope: item.scope, ...(item.sectionId?{sectionId:item.sectionId}:{sectionStart:item.sectionStart,sectionEnd:item.sectionEnd}) }) })), total: all.length, matched: filtered.length, offset, nextOffset: offset + items.length < filtered.length ? offset + items.length : null, items, note: '编号只证明选定文件范围内存在连续原文；分页或过滤不是全文业务覆盖。引用编号仍须原需求核对、业务审查及真实导出。' });
    }
  };
}
