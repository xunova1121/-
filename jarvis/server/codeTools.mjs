import { codeError } from './codeGit.mjs';
/** 默认保留P1只读入口；P2由服务器显式开放，仍无提交/推送/合并。 */
export function createCodeTools({ repos, sessionId, taskId, editing = false }) {
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
  const tools = [
    tool(
      'repo_clone',
      '连接GitHub代码仓库，拉取到服务器并为本任务开独立工作副本；先在设置连接仓库。' +
        (editing ? '可修改和隔离测试，不推送、不改主线。' : '本期只读，不改主线、不推送。'),
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
  if (editing)
    tools.push(
      tool(
        'code_edit',
        '精确修改GitHub任务工作副本，old必须唯一；先code_read核对，不改默认分支。不能删除/调松测试冒充修复。',
        schema({ workspace_id: id, path: file, old: { type: 'string', maxLength: 64000 }, new: { type: 'string', maxLength: 64000 } }, [
          'workspace_id',
          'path',
          'old',
          'new'
        ]),
        (a, e) => repos.edit(a.workspace_id, sessionId, a, e)
      ),
      tool(
        'code_write',
        '在GitHub任务工作副本创建文本；覆盖已有文件必须提供code_read返回的当前expected_sha256。',
        schema(
          { workspace_id: id, path: file, content: { type: 'string', maxLength: 256000 }, expected_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
          ['workspace_id', 'path', 'content']
        ),
        (a, e) => repos.write(a.workspace_id, sessionId, a, e)
      ),
      tool(
        'code_run',
        '在断网Docker副本运行npm项目lint或test；锁定依赖由允许源下载后离线安装，安装脚本禁用。先读package.json，不在宿主机运行，不删改原测试。失败必须修代码后重跑。',
        schema({ workspace_id: id, command: { type: 'string', enum: ['lint', 'test'] } }, ['workspace_id', 'command']),
        async (a, e) => {
          const value = await repos.run(a.workspace_id, sessionId, a.command, e);
          if (!value.ok) {
            const lines = String(value.stderr || value.stdout || '进程没有输出日志').split('\n');
            const first = lines.findIndex((line) => /not ok|error|assertion|exception|failed/i.test(line));
            // 失败摘要只留200字：先给真实错误，再放长回执，不能让哈希/环境字段挤掉原因。
            const detail = lines
              .slice(Math.max(0, first), Math.max(0, first) + 8)
              .join('\n')
              .slice(0, 500);
            throw codeError('CODE_TEST_FAILED', `隔离${value.stage}失败（退出码${value.exitCode}）。原始日志：${detail}\n完整回执：` + JSON.stringify(value), {
              result: value,
              stage: value.stage
            });
          }
          return value;
        }
      )
    );
  return tools;
}
