/**
 * 打包服务器版（部署到自己的云服务器，见 deploy/服务器部署说明.md）：
 *   node scripts/pack-server.mjs <版本号> [输出目录]   → <输出目录>/jarvis-server-<版本号>.tar.gz
 * 先 npm run build。包里是网页界面（dist）、网关和智能体代码，依赖只列服务器上真正用到的那几个，
 * 服务器上 npm install 时用锁定文件里的版本、国内镜像安装（见 deploy/install.sh）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] || 'dev';
const out = path.resolve(process.argv[3] || path.join(ROOT, 'release-server'));
/** 服务器上用到的依赖（网关、智能体、生成 / 读取文档）；浏览器才用的语音、三维、人脸识别等不装 */
export const SERVER_DEPS = ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'docx', 'exceljs', 'jszip', 'mammoth', 'marked', 'pdfjs-dist', 'pptxgenjs', 'xlsx'];

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { console.error('请先 npm run build'); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });
const stage = fs.mkdtempSync(path.join(out, '.stage-'));
const dir = path.join(stage, 'jarvis-server');
fs.mkdirSync(dir);
for (const p of ['dist', 'server', 'shared', 'src', 'deploy', 'package-lock.json']) fs.cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
const missing = SERVER_DEPS.filter((d) => !pkg.dependencies[d]);
if (missing.length) { console.error(`package.json 里没有：${missing.join('、')}`); process.exit(1); }
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
  name: 'jarvis-server', version, private: true, type: pkg.type,
  scripts: { start: 'node server/server.mjs' },
  dependencies: Object.fromEntries(SERVER_DEPS.map((d) => [d, pkg.dependencies[d]]))
}, null, 2));
fs.writeFileSync(path.join(dir, 'VERSION'), `${version}\n`);
const file = path.join(out, `jarvis-server-${version}.tar.gz`);
execFileSync('tar', ['-czf', file, '-C', stage, 'jarvis-server']);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${file}（${(fs.statSync(file).size / 1048576).toFixed(1)} MB）`);
