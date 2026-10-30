/** 评测隔离长期记忆写入和个人信息读取，不改变普通任务，也不切换进程级存储后端。 */
const MEMORY_WRITES = new Set(['remember', 'forget', 'core_memory_update', 'save_skill']);

/** 评测也不读用户的个人记忆、过往对话、持仓和知识库：结果要能复现，报告里也不带真实信息 */
const PERSONAL_READS = new Set(['recall', 'search_conversations', 'read_conversation', 'list_my_messages', 'list_holdings', 'kb_search']);
/** 评测里不能删、恢复用户真实的对话 */
const CONVERSATION_WRITES = new Set(['delete_conversations', 'restore_conversations', 'list_deleted_conversations']);

export function evaluationTools(tools, evaluationId) {
  if (!evaluationId) return tools;
  return tools.map((tool) => CONVERSATION_WRITES.has(tool.name) ? { ...tool, run: async () => '评测隔离：不删除、不恢复用户的对话，也不读回收站。' } : PERSONAL_READS.has(tool.name) ? { ...tool, run: async () => '评测隔离：不读取用户的正式记忆、过往对话、持仓或知识库；按题面作答，需要的信息直接问用户。' } : tool.name === 'list_work_records' ? { ...tool, run: async () => JSON.stringify({ total: 0, items: [], completeHistory: false, note: '评测隔离，不读取正式成果记录' }) } : MEMORY_WRITES.has(tool.name) ? {
    ...tool,
    run: async () => '本条测试信息已保留在当前评测会话中，未写入、修改或删除正式长期记忆；本会话后续可继续引用。'
  } : tool);
}

export function bindEvaluation(session, evaluationId) {
  if (evaluationId !== null && (typeof evaluationId !== 'string' || !/^[\w-]{1,80}$/.test(evaluationId))) throw Object.assign(new Error('评测编号格式错误'), { status: 400, code: 'EVAL_PROTOCOL', kind: 'api' });
  if (evaluationId && ((session.evaluationId && session.evaluationId !== evaluationId) || (!session.evaluationId && session.messages.length))) throw Object.assign(new Error('评测不能接入已有正式对话或另一套评测'), { status: 409, code: 'EVAL_PROTOCOL', kind: 'api' });
  if (evaluationId) session.evaluationId = evaluationId;
  return session.evaluationId || null;
}
