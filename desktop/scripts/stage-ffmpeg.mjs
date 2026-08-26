/**
 * 把经过版本锁定的 FFmpeg 放进 electron-builder 的 extraResources/bin。
 *
 * 交付目标是“下载一个 EXE 双击就用”，所以不能把 FFmpeg 留给用户安装。
 * 同时它是 GPL 软件，二进制、许可证和构建来源必须一起进入安装包。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin');
const packageRoot = path.dirname(require.resolve('ffmpeg-static/package.json'));
const sourceBinary = require('ffmpeg-static');
const targetBinary = path.join(BIN, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

if (!sourceBinary || !fs.existsSync(sourceBinary)) {
  throw new Error(`ffmpeg-static 没有提供当前平台的二进制：${sourceBinary || '空路径'}`);
}

fs.mkdirSync(BIN, { recursive: true });
fs.copyFileSync(sourceBinary, targetBinary);
fs.chmodSync(targetBinary, 0o755);

for (const [from, to] of [
  ['LICENSE', 'FFMPEG-LICENSE.txt'],
  ['README.md', 'FFMPEG-BUILD-INFO.md']
]) {
  const source = path.join(packageRoot, from);
  if (!fs.existsSync(source)) throw new Error(`ffmpeg-static 包里缺少 ${from}，拒绝生成不完整的分发包`);
  fs.copyFileSync(source, path.join(BIN, to));
}

const probe = spawnSync(targetBinary, ['-hide_banner', '-version'], {
  encoding: 'utf8', timeout: 15000, windowsHide: true
});
if (probe.status !== 0) {
  throw new Error(`随包 FFmpeg 无法运行：${probe.stderr || probe.error || `退出码 ${probe.status}`}`);
}

const filters = spawnSync(targetBinary, ['-hide_banner', '-filters'], {
  encoding: 'utf8', timeout: 15000, windowsHide: true
});
const capabilities = `${probe.stdout}\n${filters.stdout}`;
for (const required of ['libx264', 'xfade', 'loudnorm']) {
  if (!capabilities.includes(required)) throw new Error(`随包 FFmpeg 缺少关键能力：${required}`);
}

fs.writeFileSync(path.join(BIN, 'FFMPEG-DISTRIBUTION.txt'), [
  'Bundled component: FFmpeg',
  `Staged from npm package: ffmpeg-static`,
  `Binary version: ${(probe.stdout.split('\n')[0] || '').trim()}`,
  'Wrapper/build repository and corresponding source information:',
  'https://github.com/eugeneware/ffmpeg-static',
  'Upstream FFmpeg source:',
  'https://ffmpeg.org/download.html#get-sources',
  '',
  'FFmpeg is invoked as a separate executable. See the adjacent license and build-info files.'
].join('\n'), 'utf8');

console.log(`FFmpeg staged: ${targetBinary}`);
console.log((probe.stdout.split('\n')[0] || '').trim());
