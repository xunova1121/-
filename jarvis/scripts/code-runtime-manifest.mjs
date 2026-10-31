/** 在功能提交后生成固定版本的小文件清单；清单另作[skip ci]提交，避免版本自引用。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateCodeRuntimeManifest } from '../evals/code-runtime.mjs';

export async function generateCodeRuntimeManifest(cwd = process.cwd()) {
  const git = (args, options = {}) => execFileSync('git', args, { cwd, ...options });
  const revision = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('提交编号无效');
  const scopes = ['src', 'server', 'shared', 'evals', 'package.json', 'package-lock.json'];
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...scopes], { encoding: 'utf8' });
  if (dirty.split('\n').some((line) => line.trim() && !line.endsWith('evals/code-runtime-manifest.json')))
    throw new Error('请先提交最终运行源码，再生成固定清单；未提交源码不纳入已验收版本');
  const names = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...scopes], {
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean);
  const selected = names.filter((name) => !/runtime-manifest\.json$/.test(name));
  if (selected.length > 1000) throw new Error('代码清单超过1000文件');
  const files = [];
  for (const name of selected) {
    const bytes = git(['show', 'HEAD:jarvis/' + name], { maxBuffer: 20_000_000 });
    files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = validateCodeRuntimeManifest({ version: 1, revision, files });
  await fs.writeFile(path.resolve(cwd, 'evals/code-runtime-manifest.json'), JSON.stringify(manifest) + '\n');
  console.log(`固定源码${revision}，${files.length}文件`);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await generateCodeRuntimeManifest();
