import { it, expect } from 'vitest';
import { computerTaskKind } from '../src/llm/router.js';

it('PC服务器模式：原商城续做和禁止删测/锁文件不再触发电脑文件工具', () => {
  const text =
    '继续刚才的商城任务。先核对原工作副本和已有改动，保留这次新增的文件，不重新克隆或重置。运行项目现有的 npm run lint 和 npm test。不要删除、跳过或放宽测试，不修改测试命令和锁文件，不提交、不推送。文件尚未推送时，不要提供 GitHub 页面链接。';
  expect(computerTaskKind(text)).toBe('files'); // 本机模式原行为保持。
  expect(computerTaskKind(text, { serverRepositories: true })).toBeNull();
  expect(computerTaskKind('不要搜索本机目录，继续原仓库并运行npm test', { serverRepositories: true })).toBeNull();
});

it('明确本机目的地和GUI请求仍留电脑；普通文档/聊天不被仓库接管', () => {
  for (const text of ['把GitHub仓库克隆到桌面文件夹', '修改C:\\work\\repo仓库', '打开GitHub仓库网页', '打开年度报告.docx', '点击右上角关闭按钮'])
    expect(computerTaskKind(text, { serverRepositories: true })).toBe(computerTaskKind(text));
  expect(computerTaskKind('你好', { serverRepositories: true, codeTaskKnown: true })).toBeNull();
});

it('代码续做沿用服务器，电脑控制续做仍沿用电脑，不从助手说本机的文本猜来源', () => {
  const history = [{ role: 'assistant', content: '我去本机桌面找找。', tools: ['computer_search'] }];
  expect(computerTaskKind('继续', { history, serverRepositories: true, codeTaskKnown: true })).toBeNull();
  const gui = [{ role: 'assistant', tools: ['computer_click'] }];
  expect(computerTaskKind('继续', { history: gui, serverRepositories: true })).toBe('gui');
  expect(computerTaskKind('继续', { history: [{ role: 'assistant', tools: ['repo_clone', 'code_write'] }], serverRepositories: true })).toBeNull();
});
