/** 评测只隔离长期记忆写入，不改变普通任务，也不切换进程级存储后端。 */
const MEMORY_WRITES = new Set(['remember', 'forget', 'core_memory_update', 'save_skill']);

export function evaluationTools(tools, evaluationId) {
  if (!evaluationId) return tools;
  return tools.map((tool) => tool.name === 'list_work_records' ? { ...tool, run: async () => JSON.stringify({ total: 0, items: [], completeHistory: false, note: '评测隔离，不读取正式成果记录' }) } : MEMORY_WRITES.has(tool.name) ? {
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
