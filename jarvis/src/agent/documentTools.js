import { createDocumentGenerateTool } from './documentGenerateTool.js';
import { createLongDocumentTool } from './longDocumentTool.js';
import { createDocumentEditingTools } from './documentEditingTools.js';
import { createDocumentInspectionTools } from './documentInspectionTools.js';
import { throwControl } from '../core/networkRequest.js';

/** 文档工具入口只组装，具体制作、修改、计划和验收各自独立。 */
export function createDocumentTools(ctx) {
  const tools = [
    ...createDocumentEditingTools(ctx),
    ...createDocumentInspectionTools(),
    createDocumentGenerateTool(ctx),
    createLongDocumentTool(ctx)
  ];
  return tools.map(tool => ({ ...tool, run: async (...args) => {
    try {
      return await tool.run(...args);
    } catch (error) {
      throwControl(error, args[1]?.signal);
      if (!error.code && !error.status && !error.kind) {
        error.code = 'DOCUMENT_OPERATION';
        error.kind = 'document';
      }
      throw error;
    }
  } }));
}
