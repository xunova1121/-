import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Docker守护进程必须看得见；正式服务传dataDir下目录，避免PrivateTmp。父目录0700保护副本。 */
export async function projectDirectory(baseDir = path.join(os.tmpdir(), 'jarvis-project-jobs')) {
  const base = path.resolve(baseDir);
  if (/[\r\n,]/.test(base)) throw Object.assign(new Error('隔离项目共享路径无效'), { code: 'INVALID_PROJECT_INPUT' });
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(base)) !== base) throw Object.assign(new Error('隔离项目共享目录不能是符号链接'), { code: 'INVALID_PROJECT_INPUT' });
  await fs.chmod(base, 0o700);
  const folder = await fs.mkdtemp(path.join(base, 'job-'));
  await fs.chmod(folder, 0o755); // bind mount中UID65534可读；宿主访问仍受父目录0700限制。
  return folder;
}

/** mode参数会被systemd的umask 077过滤，必须显式chmod每层目录及文件。 */
export async function writeProjectSnapshot(directory, relative, bytes) {
  const parts = relative.split('/');
  let parent = directory;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    await fs.mkdir(parent, { recursive: true, mode: 0o755 });
    await fs.chmod(parent, 0o755);
  }
  const target = path.join(directory, ...parts);
  await fs.writeFile(target, bytes, { mode: 0o644, flag: 'wx' });
  await fs.chmod(target, 0o644);
}
