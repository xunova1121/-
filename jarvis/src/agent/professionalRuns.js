/** 每个执行轮次最多16个流程恢复指针；只留摘要和路径，不缓存正文或材料。 */
export function createProfessionalRuns() {
  const scopes = new WeakMap();
  return async (input, args, execution) => {
    const scope = execution.executionScope;
    if (!scope || typeof scope !== 'object' || !globalThis.crypto?.subtle || !args.path || input.state_file) return null;
    const bytes = new TextEncoder().encode(JSON.stringify({
      sessionId: execution.sessionId || null,
      path: args.path,
      task: input.task,
      material: input.material,
      format: input.format || 'docx',
      depth: input.depth || 'auto',
      research: input.research !== false
    }));
    if (bytes.length > 200000) return null;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const entries = scopes.get(scope);
    return {
      stateFile: entries.get(hash),
      remember(stateFile) {
        if (typeof stateFile !== 'string' || stateFile.length > 500) return;
        entries.delete(hash);
        entries.set(hash, stateFile);
        while (entries.size > 16) entries.delete(entries.keys().next().value);
      }
    };
  };
}
