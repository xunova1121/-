import * as ws from './workspace.js';
/** 转换保留原文件，并生成可被后续普通文档/架构工具读取的DOCX来源。 */
export function legacyDocumentTool(ctx) {
  return {
    name: 'convert_legacy_doc',
    description: '将真正Word97-2003旧DOC转换成新的DOCX，保留原件，转换后可继续读文件和核对来源；需要服务器LibreOffice。',
    input_schema: { type: 'object', properties: { source: { type: 'string' }, path: { type: 'string' } }, required: ['source'], additionalProperties: false },
    run: async ({ source, path }, { signal } = {}) => {
      signal?.throwIfAborted();
      source = ws.normalize(source);
      if (!/\.doc$/i.test(source)) throw Object.assign(new Error('只转换真正旧.doc文件，其他格式沿用普通读取'), { code: 'LEGACY_DOC_TYPE' });
      const blob = await ws.readBlob(source),
        converted = await ctx.convertLegacyDoc(blob, { signal });
      signal?.throwIfAborted();
      const target = ws.normalize(path || source.replace(/\.doc$/i, '_转换.docx'));
      if (!/\.docx$/i.test(target) || target === source) throw Object.assign(new Error('转换输出必须是新的DOCX路径'), { code: 'LEGACY_DOC_PATH' });
      if (
        await ws.readBlob(target).then(
          () => true,
          (e) => {
            if (['ENOENT', 'WORKSPACE_NOT_FOUND'].includes(e.code)) return false;
            throw e;
          }
        )
      )
        throw Object.assign(new Error('转换目标已经存在，请指定新路径保留已有文件'), { code: 'LEGACY_DOC_EXISTS' });
      const saved = await ws.write(target, converted);
      ctx.onFileChanged?.(saved.path);
      return JSON.stringify({ path: saved.path, source, converted: true, originalPreserved: true, note: '格式转换已完成，内容和排版仍需读回核对' });
    }
  };
}
