/** 文档任务常驻完成交付所需工具；其他能力仍可按名字或tool_search加载，未禁用。 */
export const DOCUMENT_TASK_CORE = new Set([
  'create_document', 'write_long_document', 'write_professional_document', 'generate_task_brief',
  'edit_office_document', 'edit_spreadsheet', 'check_document',
  'find_files', 'list_files', 'read_file', 'write_file', 'edit_file', 'search_in_files',
  'read_task_requirements', 'read_tool_result', 'read_evidence', 'update_plan', 'review_task',
  'execution_capabilities', 'verify_numbers', 'preview', 'tool_search',
  'web_search', 'fetch_url', 'get_current_time'
]);

/** 已有内容整理无需重启调研和专业分节；仍保留完整文件/内容检查。 */
export function simpleDocumentTask(request) {
  const text = String(request || '');
  return text.length <= 600 && /Word|PPT|文档|幻灯片/i.test(text)
    && /上面|上述|刚才|这些|整理成|做一份清爽|再做一份/.test(text)
    && !/调研|研究|搜集|搜索|联网|补充资料|标书|论文|完整方案|逐条核实/.test(text);
}
export function documentRouteNote(request) {
  if (/PPT|幻灯片|演示文稿|\.pptx/i.test(request) && /补图|每页.*(?:图|图片)|逐页.*配图/.test(request)) return '沿用现有PPT补图：优先一次create_document，format=pptx、source_path=原PPT、path=另存路径、content为空、requirements填原要求；工具从可核对底稿批量配图并复用缓存，不要逐张generate_image后重抄正文。旧文件没有底稿时如实报告，再核对页面，不覆盖原件。';
  return simpleDocumentTask(request) ? '本轮是把已有内容整理为文件，直接用create_document并保留原内容；不要重新调研或升级为write_professional_document，仍执行真实文件和交付检查。' : '';
}
