/** 在功能提交后生成固定版本的小文件清单；清单另作[skip ci]提交，避免版本自引用。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('提交编号无效');
const names = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'src', 'server', 'shared', 'evals', 'package.json', 'package-lock.json'], {
  encoding: 'utf8'
})
  .trim()
  .split('\n');
const selected = names.filter((name) => !/runtime-manifest\.json$/.test(name));
if (selected.length > 1000) throw new Error('代码清单超过1000文件');
const files = [];
for (const name of selected) {
  const bytes = execFileSync('git', ['show', 'HEAD:jarvis/' + name], { maxBuffer: 20_000_000 });
  files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await fs.writeFile(path.resolve('evals/code-runtime-manifest.json'), JSON.stringify({ version: 1, revision, files }));
console.log(`固定源码${revision}，${files.length}文件`);
