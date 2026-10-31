import { pptIconCatalogTool } from './pptIconCatalogTool.js';
import { createDocumentGenerateTool } from './documentGenerateTool.js';
import { createLongDocumentTool } from './longDocumentTool.js';
import { createDocumentEditingTools } from './documentEditingTools.js';
import { createDocumentInspectionTools } from './documentInspectionTools.js';
import { documentStyleContext } from './memory.js';
import { withDocumentStyles } from './documentStyles.js';
import { throwControl } from '../core/networkRequest.js';
import { createProfessionalDocumentTools } from './professionalDocumentTools.js';
import { mediaRequirement } from './actionDelivery.js';
import { formattingOnly } from './documentPreservation.js';

/** 文档工具入口只组装，具体制作、修改、计划和验收各自独立。 */
export function createDocumentTools(ctx) {
  ctx = withDocumentStyles(ctx, documentStyleContext);
  const tools = [pptIconCatalogTool, ...createProfessionalDocumentTools(ctx), ...createDocumentEditingTools(ctx), ...createDocumentInspectionTools(), createDocumentGenerateTool(ctx), createLongDocumentTool(ctx)];
  return tools.map((tool) => ({
    ...tool,
    run: async (...args) => {
      try {
        const request = String(args[1]?.rawRequestText || args[0]?.requirements || '');
        if (/^(write_long_document|write_professional_document)$/.test(tool.name) && (args[0]?.format || 'docx') === 'docx' && formattingOnly(request)) {
          throw Object.assign(new Error('只排版任务请用create_document绑定用户原文；不进入长文重写或专业起草流程'), { code: 'DOCUMENT_SOURCE', kind: 'validation' });
        }
        const isPpt = args[0]?.format === 'pptx' || /\.pptx$/i.test(args[0]?.path || '');
        if (/^(create_document|write_long_document|write_professional_document)$/.test(tool.name) && isPpt && mediaRequirement(request)?.tool === 'create_diagram' && !/\d+\s*页|汇报|演示文稿|建设方案/.test(request)) throw Object.assign(new Error('独立架构图须用create_diagram或export_diagram从同一设计稿导出PPT，不能在普通PPT工具另画一版'), { code: 'USE_CANONICAL_DIAGRAM', kind: 'input' });
        return await tool.run(...args);
      } catch (error) {
        throwControl(error, args[1]?.signal);
        if (!error.code && !error.status && !error.kind) {
          error.code = 'DOCUMENT_OPERATION';
          error.kind = 'document';
        }
        throw error;
      }
    }
  }));
}
