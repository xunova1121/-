/** 只读服务器已有配置；明确选择代码线路，GitHub凭据只交仓库层，不进入报告。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, createAdapter } from '../src/llm/config.js';
import { routeFor } from '../src/llm/router.js';
import { validateLiveConfig } from './baseline.mjs';

export const CODE_TEST_REPOSITORY = 'xunova1121/weiyang-code-sandbox';
export const liveInputError = (message) => Object.assign(new Error(message), { code: 'CODE_LIVE_INPUT' });

export async function loadCodeLiveConfig(directory) {
  let saved;
  try {
    const file = path.join(directory, 'config.json');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('size');
    saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('shape');
  } catch {
    throw liveInputError('无法读取服务器config.json或配置格式有误；请核对数据目录，不要把配置或Key发到对话里');
  }
  const cfg = { ...DEFAULT_CONFIG, ...saved, autoMemory: false };
  const route = routeFor(cfg, 'code');
  let selected;
  try {
    selected = validateLiveConfig(route.cfg);
  } catch {
    throw liveInputError('请先在服务器模型界面配置真实编程线路；尚未发起模型请求');
  }
  if (createAdapter(route.cfg).problem) throw liveInputError('服务器编程线路配置不完整；请在模型界面检查接口与Key');
  const connection = cfg.codeRepos;
  if (connection?.provider !== 'github' || connection.repository?.toLowerCase() !== CODE_TEST_REPOSITORY || !connection.verifiedAt)
    throw liveInputError('请先在未央服务器设置中连接GitHub测试仓库xunova1121/weiyang-code-sandbox；不会使用或修改其他仓库');
  if (typeof connection.token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(connection.token))
    throw liveInputError('请在未央服务器设置中保存只授权测试仓库的GitHub令牌；不要把令牌发到对话里');
  cfg.codeRepos = { ...connection, repository: CODE_TEST_REPOSITORY, protectDefaultBranch: true };
  return { cfg, selected };
}

/** 不回显上游错误正文，避免HTTP/JSON错误夹带配置；保留可处理的失败类别。 */
export function liveFailure(error, { modelRequested = false } = {}) {
  const code = /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'CODE_LIVE_FAILED';
  const notes = {
    CODE_DOCKER_UNAVAILABLE: 'Docker不可用；请安装并启动本机Docker，未请求模型',
    CODE_GITHUB_AUTH: 'GitHub令牌无效或已过期；请在服务器设置中更新，未请求模型',
    CODE_GITHUB_FORBIDDEN: 'GitHub拒绝访问；请核对测试仓库权限与额度，未请求模型',
    CODE_GITHUB_NOT_FOUND: '测试仓库不可读取；请核对仓库名和令牌权限，未请求模型',
    CODE_GITHUB_NETWORK: '暂时无法连接GitHub；未请求模型',
    CODE_GITHUB_TIMEOUT: 'GitHub连接超时；未请求模型',
    CODE_GIT_TIMEOUT: 'Git操作超时；对应阶段尚未核验，不能据此断定代码错误'
  };
  const note = notes[code];
  return { code, ...(code === 'CODE_LIVE_INPUT' ? { message: error.message } : note ? { message: modelRequested ? note.replace(/[，；]未请求模型/g, '') : note } : {}) };
}
