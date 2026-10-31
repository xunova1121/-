/** 服务器仓库任务不能因“不要删除测试/锁文件”等约束转成本机文件操作。 */
const REPOSITORY =
  /GitHub|仓库|工作副本|workspace_id|\brepo_(?:clone|status|diff)\b|\bcode_(?:read|write|edit|run)\b|\bnpm\s+(?:run\s+)?(?:test|lint)\b|weiyang\/task-[a-f0-9]+/i;
const LOCAL = /桌面|文件夹|我的电脑|这台电脑|本机|电脑上|本地(?:磁盘|硬盘|文件|文档)|[a-z]\s*盘|[a-z]:[\\/]|回收站|下载(?:文件夹|目录)/gi;
export function serverRepositoryIntent(text, { history = [], codeTaskKnown = false } = {}) {
  const value = String(text || '').trim();
  for (const match of value.matchAll(LOCAL)) {
    // “不要搜本机目录”不等于要求访问本机。
    if (!/(?:不要|不用|不许|不得|不必|别|禁止|无需|不能|不会)[^，。；\n]{0,12}$/.test(value.slice(Math.max(0, match.index - 22), match.index))) return false;
  }
  if (/^(?:请|帮我|麻烦你|给我)?(?:打开|启动|切换到|点击|双击|关闭)[^。！？\n]{0,60}(?:浏览器|网页|网站|窗口|软件|应用)/.test(value)) return false;
  if (REPOSITORY.test(value)) return true;
  const last = history
    .slice(-8)
    .reverse()
    .find((message) => message.role === 'assistant');
  const codeTools = last?.tools?.some((tool) => /^(?:repo_(?:clone|status|diff)|code_(?:read|search|edit|write|run))$/.test(tool));
  return value.length <= 200 && /^(?:继续|接着|恢复)/.test(value) && !/天气|新闻|闲聊|唱歌/.test(value) && Boolean(codeTaskKnown || codeTools);
}
