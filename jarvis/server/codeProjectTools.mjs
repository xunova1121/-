/** 模型只准备项目确认请求；GitHub写入由鉴权UI对具体请求确认后执行。 */
export function codeProjectTools(projects, sessionId) {
  const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const tool = (name, description, input_schema, run) => ({ name, description, input_schema, run: async (a, e) => JSON.stringify(await run(a, e)) });
  return [
    tool('project_list', '查看本对话当前项目、最近项目、真实副本和待确认操作。', schema({}), () => projects.list(sessionId)),
    tool(
      'project_prepare',
      '用户要新建项目时，准备GitHub建仓确认卡；默认私有，name用英文仓库名，title可中文。菜单或侧栏的“代码项目”确认后才创建远程仓库与工作分支；此回执不是已创建。',
      schema(
        {
          name: { type: 'string', maxLength: 80 },
          title: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 240 },
          private: { type: 'boolean' }
        },
        ['name']
      ),
      (a) => projects.prepare(a, sessionId)
    ),
    tool(
      'project_save',
      '准备将原副本修改提交并推送工作分支的确认卡；回执含文件hash和目标，用户点确认后才保存；不改默认分支、不合并、不发布。',
      schema({ workspace_id: { type: 'string', pattern: '^[a-f0-9]{24}$' }, message: { type: 'string', maxLength: 180 } }, ['workspace_id']),
      (a, e) => projects.prepareSave(a, sessionId, e)
    )
  ];
}
