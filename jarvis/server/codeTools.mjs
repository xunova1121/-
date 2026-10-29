/** 此阶段只有读取；没有任意git命令、写文件、运行项目、提交或推送入口。 */
export function createCodeTools({ repos, sessionId, taskId }) {
  const id = { type: 'string', description: 'repo_clone回执中的workspace_id，限本对话使用' };
  const file = { type: 'string', description: '工作副本内的相对文件路径，不允许.git/凭据文件/符号链接' };
  const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const tool = (name, description, input_schema, run) => ({
    name,
    description,
    input_schema,
    run: async (args, execution = {}) => {
      execution.signal?.throwIfAborted();
      const result = await run(args, execution);
      execution.signal?.throwIfAborted();
      return JSON.stringify(result);
    }
  });
  return [
    tool(
      'repo_clone',
      '连接GitHub代码仓库，拉取到服务器并为本任务开独立工作副本；先在设置连接仓库。本期只读，不改主线、不推送。',
      schema({ repository: { type: 'string', description: '已在设置连接的owner/repo，不填沿用当前仓库' } }),
      (args, e) => repos.clone(args, { sessionId, taskId }, e)
    ),
    tool('repo_status', '查看GitHub代码工作副本的分支、提交与文件变更，不显示凭据文件。', schema({ workspace_id: id }, ['workspace_id']), (a, e) =>
      repos.status(a.workspace_id, sessionId, e)
    ),
    tool(
      'repo_diff',
      '读取GitHub工作副本相对HEAD的改动；不填path只给前200个可读文件的概要，填path读取该文件补丁。输出有界。',
      schema({ workspace_id: id, path: file }, ['workspace_id']),
      (a, e) => repos.diff(a.workspace_id, sessionId, a.path, e)
    ),
    tool(
      'code_search',
      '在GitHub代码工作副本按文件名或普通文本搜索，最多50条结果；截断时回执说明扫描范围。',
      schema({ workspace_id: id, query: { type: 'string', maxLength: 200 }, mode: { type: 'string', enum: ['content', 'name'] } }, ['workspace_id', 'query']),
      (a, e) => repos.search(a.workspace_id, sessionId, a.query, a.mode || 'content', e)
    ),
    tool(
      'code_read',
      '按行读取GitHub工作副本的代码，最多200行/16000字；不执行仓库中的代码或命令。',
      schema({ workspace_id: id, path: file, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, [
        'workspace_id',
        'path'
      ]),
      (a, e) => repos.read(a.workspace_id, sessionId, a.path, a.start_line ?? 1, a.end_line ?? (a.start_line ?? 1) + 119, e)
    )
  ];
}
