/** 文档任务常驻完成交付所需工具；其他能力仍可按名字或tool_search加载，未禁用。 */
export const DOCUMENT_TASK_CORE = new Set([
  'create_document', 'write_long_document', 'write_professional_document', 'generate_task_brief',
  'edit_office_document', 'edit_spreadsheet', 'check_document',
  'find_files', 'list_files', 'read_file', 'write_file', 'edit_file', 'search_in_files',
  'read_task_requirements', 'read_tool_result', 'read_evidence', 'update_plan', 'review_task',
  'execution_capabilities', 'verify_numbers', 'preview', 'tool_search',
  'web_search', 'fetch_url', 'get_current_time'
]);
