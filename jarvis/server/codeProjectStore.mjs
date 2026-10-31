import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { codeError } from './codeGit.mjs';
/** 项目元数据单独保存；64项目/100会话绑定/16待确认，完全不保存令牌或代码正文。 */
export function createCodeProjectStore(directory) {
  const root = path.resolve(directory),
    file = path.join(root, 'index.json');
  let pending = Promise.resolve();
  const read = async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(root)) !== root) throw codeError('CODE_PROJECT_PATH', '项目目录不能为符号链接');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) throw codeError('CODE_PROJECT_INDEX', '项目索引无效，未覆盖');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        !Array.isArray(data.projects) ||
        !Array.isArray(data.bindings) ||
        !Array.isArray(data.requests) ||
        data.projects.length > 64 ||
        data.bindings.length > 100 ||
        data.requests.length > 16
      )
        throw new Error('shape');
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, projects: [], bindings: [], requests: [] };
      if (e.code === 'CODE_PROJECT_INDEX') throw e;
      throw codeError('CODE_PROJECT_INDEX', '项目索引损坏，未重建或清空');
    }
  };
  return {
    read,
    update(action) {
      const job = pending.then(async () => {
        const data = await read(),
          result = await action(data);
        if (data.projects.length > 64 || data.bindings.length > 100 || data.requests.length > 16)
          throw codeError('CODE_PROJECT_CAPACITY', '项目或会话数量达到上限，请核对已有项目');
        const bytes = JSON.stringify(data);
        if (Buffer.byteLength(bytes) > 256000) throw codeError('CODE_PROJECT_CAPACITY', '项目索引超过256KB');
        const tmp = file + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
          await fs.rename(tmp, file);
        } finally {
          await fs.rm(tmp, { force: true });
        }
        return result;
      });
      pending = job.catch(() => {});
      return job;
    }
  };
}
