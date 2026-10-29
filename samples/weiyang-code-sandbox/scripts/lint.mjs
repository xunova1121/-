// 最简单的代码检查：每个源文件都能被 Node 解析，且没有遗留的 console.log
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = ['src', 'test', 'scripts'].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).map((f) => `${dir}/${f}`));
let bad = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`语法错误：${file}\n${e.stderr}`);
  }
  if (file.startsWith('src/') && /console\.log\(/.test(readFileSync(file, 'utf8'))) {
    bad++;
    console.error(`源码里不要留 console.log：${file}`);
  }
}
if (bad) process.exit(1);
console.log(`代码检查通过：${files.length} 个文件`);
