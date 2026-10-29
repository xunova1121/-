/** 只取仓库ID、命令和验收标记，不把测试日志或代码放进回执摘要。 */
export function repositoryReceipt(toolName, args, ok, output) {
  if (!/^code_(?:read|edit|write|run)$/.test(toolName)) return null;
  const workspaceId = /^[a-f0-9]{24}$/.test(args.workspace_id || '') ? args.workspace_id : '';
  const command = toolName === 'code_run' && ['lint', 'test'].includes(args.command) ? args.command : '';
  let testVerified = false;
  if (ok && command === 'test' && typeof output === 'string' && output.length <= 120000) {
    try {
      const value = JSON.parse(output);
      testVerified =
        value.ok === true &&
        value.command === 'test' &&
        value.stage === 'test' &&
        value.exitCode === 0 &&
        value.install?.exitCode === 0 &&
        value.isolation === 'docker_offline_snapshot' &&
        value.hostWorktreeWritable === false &&
        /^[a-f0-9]{64}$/.test(value.sourceDigest || '');
    } catch {
      /* 缺少真实结构化验收不算通过。 */
    }
  }
  return { workspaceId, command, testVerified };
}
export function repositoryRepair(previous, later) {
  if (!previous.workspaceId || previous.workspaceId !== later.workspaceId) return false;
  if (previous.tool === 'code_run') return later.tool === 'code_run' && previous.command === later.command && (later.command !== 'test' || later.testVerified);
  return /^code_(?:edit|write)$/.test(previous.tool) && /^code_(?:edit|write)$/.test(later.tool) && previous.path === later.path;
}
