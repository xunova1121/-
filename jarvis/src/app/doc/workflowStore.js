import { boundedText, LIMITS, workflowError } from './workflowSchema.js';

// 每次任务最多8次模型调用；每次状态另存，文件夹模式不依赖覆盖写。
// 正文和完整底稿只进工作区，检查点只含引用；不存在跨任务全局缓存。
export function createWorkflowStore(app, execution) {
  const save = async (state) => {
    execution.signal?.throwIfAborted();
    if ((state.saves || 0) >= 40) throw workflowError('本任务阶段文件已达40份上限，请查看已保存文件', 'DOCUMENT_STORAGE_LIMIT');
    state.saves = (state.saves || 0) + 1;
    const proposed = `${state.folder}/state-${state.saves}-${globalThis.crypto.randomUUID()}.json`;
    const checkpointId = `${state.id}-${state.saves}`;
    // 复用已有tool_start强制落盘协议，在每次写状态前留下待核对的路径。
    await execution.checkpoint?.({ type: 'tool_start', id: checkpointId, name: 'document_workflow_save', args: { path: proposed } });
    const serialized = JSON.stringify(state, null, 2);
    if (new Blob([serialized]).size > 2000000) throw workflowError('阶段记录超过2MB，请拆分任务', 'DOCUMENT_STORAGE_LIMIT');
    const result = await app.documentWorkspace.write(proposed, serialized);
    state.stateFile = result.path;
    await execution.checkpoint?.({ type: 'tool_end', id: checkpointId, name: 'document_workflow_save', ok: true, output: `阶段：${state.phase}；恢复文件：${result.path}` });
    return result.path;
  };
  const load = async (filePath) => {
    const normalized = app.documentWorkspace.normalize(filePath);
    if (!/^文档流程\/[^/]+\/state-[^/]+\.json$/.test(normalized)) throw workflowError('恢复文件必须位于文档流程目录', 'DOCUMENT_INPUT');
    const blob = await app.documentWorkspace.readBlob(normalized);
    if (blob.size > 2000000) throw workflowError('恢复文件过大', 'DOCUMENT_INPUT');
    let state;
    try { state = JSON.parse(await blob.text()); } catch { throw workflowError('恢复文件损坏', 'DOCUMENT_INPUT'); }
    if (state.version !== 3 || state.sessionId !== (execution.sessionId ?? null) || state.folder !== normalized.slice(0, normalized.lastIndexOf('/'))) {
      throw workflowError('恢复文件与本轮会话不匹配', 'DOCUMENT_SESSION');
    }
    const siblings = await app.documentWorkspace.list?.(state.folder) || [];
    if (siblings.some(item => Number(item.path.slice(item.path.lastIndexOf('/') + 1).match(/^state-(\d+)-/)?.[1]) > state.saves)) {
      throw workflowError('存在更新的阶段文件，请先核对最新记录，不能从旧检查点重复执行', 'DOCUMENT_STALE_STATE');
    }
    if (!['new', 'planned', 'drafted', 'reviewed', 'revised', 'completed'].includes(state.phase) || !Number.isInteger(state.calls) || state.calls < 0 || state.calls > LIMITS.calls) {
      throw workflowError('恢复状态或调用计数无效', 'DOCUMENT_INPUT');
    }
    boundedText(state.input?.task, LIMITS.task, '原始要求', true);
    boundedText(state.input?.material, LIMITS.material, '原始材料');
    boundedText(state.draft, LIMITS.draft, '保存正文');
    if (!['expert', 'simple'].includes(state.depth) || !Number.isInteger(state.revisionAttempts) || state.revisionAttempts < 0 || state.revisionAttempts > 1) {
      throw workflowError('恢复深度或修订次数无效', 'DOCUMENT_INPUT');
    }
    state.stateFile = normalized;
    return state;
  };
  return { save, load };
}
