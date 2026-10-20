import * as ws from './workspace.js';
import { DOCUMENT_TEMPLATES, documentTemplate } from './documentTemplates.js';
import { planDocument, documentError } from './documentPlan.js';
import { S, str } from './documentSchema.js';

/** 计划与重新检查均不写产物文件，也不额外调用模型。 */
export function createDocumentInspectionTools() {
  return [
    {
      name:'get_document_template',
      description:'查看未央内置的PPT、Word、Excel模板与制作检查清单。没有id时列出模板；有id时返回结构、版式和资料要求。先读用户材料，按实际用途填充，不能把模板当成已经完成的文件。',
      input_schema:S({id:str('模板编号；不填则列出全部模板')}),
      run:async({id})=>id?documentTemplate(id):JSON.stringify(DOCUMENT_TEMPLATES.map(({id,format,name,purpose})=>({id,format,name,purpose})),null,2)
    },
    {
      name: 'plan_document',
      description: '制作文档前选择场景方案，返回章节、布局骨架和检查要求，不请求模型、不写盘。先读取用户附件；返回的来源清单不代表已核实。普通任务不需停下来等用户确认。',
      input_schema: S({format:{type:'string',enum:['docx','pptx','xlsx','pdf','html','md']},task:str('用户原始要求'),template_id:str('可选，指定模板编号；auto自动选择'),audience:str('受众，已有信息足够时不要追问'),sources:{type:'array',maxItems:12,items:{type:'string'}}},['format','task']),
      run: async args => JSON.stringify(planDocument(args), null, 2)
    },
    {
      name: 'check_document',
      description: '对工作区真实Office文件重新检查结构、读回、公式，返回短检查报告；不写文件、不自动生成预览。静态检查或转换不证明事实准确，也不等于视觉验收。',
      input_schema: S({path:str('工作区文件路径'),required_text:{type:'array',maxItems:20,items:{type:'string'},description:'应出现的文字，只做片段匹配，不冒充语义审核'}},['path']),
      run: async ({path, required_text:requiredText = []}, options = {}) => {
        const ext = ws.ext(path);
        if (!['docx','pptx','xlsx'].includes(ext)) throw documentError('目前重新检查支持Word、PPT和Excel');
        const blob = await ws.readBlob(path);
        // 重新检查不重写原文件，也不因本地文件夹另存而生成无意义副本。
        const { inspectDocument, qualitySummary } = await import('./documentQuality.js');
        const report = await inspectDocument(blob,path,{requiredText,signal:options.signal});
        await options.checkpoint?.({type:'artifact_validation',path,validation:report});
        return JSON.stringify({path,...report,summary:qualitySummary(report)},null,2);
      }
    },
  ];
}
