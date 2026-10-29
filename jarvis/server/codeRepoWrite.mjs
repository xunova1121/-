import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { codeError, redactCode } from './codeGit.mjs';
import { allowedCodePath, readCodeFile } from './codeRepoFiles.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function contentText(value, token, max) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || value.includes('\0')) throw codeError('CODE_CONTENT', '只写入上限内的UTF-8文本');
  if (redactCode(value, token) !== value) throw codeError('CODE_SECRET', '不能把GitHub凭据写入仓库文件');
  return value;
}
async function parent(root, relative) {
  if (!allowedCodePath(relative) || relative.split('/').includes('node_modules')) throw codeError('CODE_PATH', '不能修改越界、Git元数据、凭据或node_modules');
  const base = await fs.realpath(root);
  let directory = base;
  for (const part of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
      throw codeError('CODE_SYMLINK', '不能通过符号链接修改文件');
  }
  return path.join(directory, path.basename(relative));
}
async function existing(root, relative, token) {
  try {
    const value = await readCodeFile(root, relative, token);
    if (value.redacted) throw codeError('CODE_SECRET', '文件含凭据，不能用脱敏文本覆盖原文件');
    return value;
  } catch (error) {
    if (error.code === 'CODE_FILE_MISSING') return null;
    throw error;
  }
}
/** 先核原文和版本，再临时文件原子替换；不提供删除或任意命令入口。 */
export async function writeCodeFile(root, input, { token = '', signal, edit = false } = {}) {
  signal?.throwIfAborted();
  if (!allowedCodePath(input.path)) throw codeError('CODE_PATH', '只修改工作副本内的非凭据文件');
  const old = await existing(root, input.path, token);
  let text;
  if (edit) {
    if (!old) throw codeError('CODE_FILE_MISSING', '待修改文件不存在，请先读取确认');
    const before = contentText(input.old, token, 64000),
      after = contentText(input.new, token, 64000);
    if (!before || old.text.split(before).length !== 2) throw codeError('CODE_EDIT_MATCH', 'old必须在当前文件中精确且唯一出现；请重新读取相关行');
    text = old.text.replace(before, () => after);
  } else {
    text = contentText(input.content, token, 256000);
    if (old && input.expected_sha256 !== old.sha256) throw codeError('CODE_WRITE_CONFLICT', '覆盖已有文件需要code_read返回的当前sha256，原文件未改');
    if (!old && input.expected_sha256) throw codeError('CODE_WRITE_CONFLICT', '文件不存在，不能用旧版本覆盖');
  }
  contentText(text, token, 1_000_000);
  const target = await parent(root, input.path),
    temp = path.join(path.dirname(target), '.weiyang-' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    const current = await existing(root, input.path, token);
    if (current?.sha256 !== old?.sha256) throw codeError('CODE_WRITE_CONFLICT', '文件在修改期间已变化，原文件未覆盖');
    signal?.throwIfAborted();
    if (old) {
      const mode = (await fs.stat(target)).mode & 0o777;
      await fs.chmod(temp, mode & 0o111 ? 0o700 : 0o600);
      await fs.rename(temp, target);
    } else {
      // link原子地拒绝并发创建；rename会覆盖突然出现的同名文件。
      await fs.link(temp, target).catch((error) => {
        if (error.code === 'EEXIST') throw codeError('CODE_WRITE_CONFLICT', '同名文件已创建，未覆盖');
        throw error;
      });
    }
    return { path: input.path, operation: edit ? 'edit' : old ? 'replace' : 'create', bytes: Buffer.byteLength(text), sha256: digest(text), saved: true };
  } finally {
    await fs.rm(temp, { force: true });
  }
}
