/** 导入仅存文件并填草稿，不自动发模型请求；异步完成不能写入切换后的对话。 */
export async function importPptSource({
  app,
  workspace,
  template,
  url,
  scope,
  fill,
  readDraft = () => '',
  fetchFile = fetch,
  uuid = () => crypto.randomUUID()
}) {
  const session = app.session;
  const server = app.server;
  const identity = scope();
  const draft = readDraft();
  const current = () => app.session === session && app.server === server && scope() === identity && !session.messages?.length;
  const check = () => {
    if (!current()) throw new Error('对话或账号已切换，请回到原对话重新导入。');
    if (readDraft() !== draft) throw new Error('输入内容已变化，已保留你的草稿，请重新导入。');
  };
  if (session?.agentId !== 'ppt-maker' || session.messages?.length) throw new Error('请在 PPT 制作的新对话中导入样板。');
  const response = await fetchFile(url);
  if (!response.ok) throw new Error('样板读取失败，请重试。');
  const blob = await response.blob();
  if (!blob.size) throw new Error('样板文件为空，未导入。');
  check();
  // 每次使用独立路径，不覆盖用户文件；云模式直接上传到捕获的本人客户端，不回退本地。
  let filePath = `模板样板/${template.name}-${uuid()}.pptx`;
  if (server) await server.upload(filePath, blob);
  else {
    const written = await workspace.write(filePath, blob);
    filePath = written.path;
  }
  check();
  // 清除的是旧生成方案选择，其他页数/场景保留。样板已有自己的原生版式。
  if (session.agentForm?.template) session.agentForm = { ...session.agentForm, template: '' };
  fill(`请基于工作区文件“${filePath}”修改 PPT，保留原生可编辑文字、图形与版式。先读取文件结构；修改要求：${draft}`);
  return { path: filePath };
}
