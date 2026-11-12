/**
 * 本机一键跑“发布前完整验证”（2026-11-12 复审：1.0.429 改了企业首屏，只改了一个 e2e、漏了另一个，
 * 本机只跑了部分测试，到 CI 才失败）。直接从 .github/workflows/jarvis-desktop.yml 的 verify 作业读取步骤，
 * 按 CI 同样的顺序和命令执行，不另外维护一份清单，免得两边对不上。
 *
 *   node scripts/release-gate.mjs            跑全部能在本机跑的步骤（失败继续，最后汇总）
 *   node scripts/release-gate.mjs --list     只列出步骤和是否会跳过
 *   node scripts/release-gate.mjs --from 构建网页版   从名字含该词的步骤开始
 *   node scripts/release-gate.mjs --only 企业        只跑名字或命令含该词的步骤
 *
 * 会跳过：装系统软件（apt/sudo）、需要 Docker 镜像或下载 Electron、上传发布的步骤——这些只有 CI 能做；
 * 命令里的 GitHub 变量（${{ }}，如版本号）换成本机测试值 0.0.0-local。
 * 结尾会列出跳过了哪些，不能把“本机通过”当成“CI 全过”。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.resolve(ROOT, '..', '.github/workflows/jarvis-desktop.yml');

/** 只解析 verify 作业里的 name / run 两种写法（单行 run: xxx 和 run: | 多行块），不引入 YAML 依赖 */
export function verifySteps(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex(line => /^ {2}verify:\s*$/.test(line));
  if (start < 0) throw new Error('工作流里没有 verify 作业');
  let end = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:\s*$/.test(line));
  if (end < 0) end = lines.length;
  const steps = [];
  let current = null;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const name = /^ {6}- (?:name:\s*(.+)|uses:\s*(.+))$/.exec(line);
    if (name) { current = { name: (name[1] || name[2]).trim(), run: '', condition: '' }; steps.push(current); continue; }
    if (!current) continue;
    const condition = /^ {8}if:\s*(.+)$/.exec(line);
    if (condition) { current.condition = condition[1]; continue; }
    const single = /^ {8}run:\s*([^|\s].*)$/.exec(line);
    if (single) { current.run = single[1]; continue; }
    if (/^ {8}run:\s*\|\s*$/.test(line)) {
      const body = [];
      while (i + 1 < end && (/^ {10}/.test(lines[i + 1]) || lines[i + 1].trim() === '')) body.push(lines[++i].slice(10));
      current.run = body.join('\n').replace(/\s+$/, '');
    }
  }
  return steps.filter(step => step.run);
}

/** 只有 CI 能做的步骤：返回跳过原因；能在本机跑返回空 */
export function skipReason(step) {
  const text = step.run;
  if (/github\./.test(step.condition)) return '需要 GitHub 变量';
  if (/npm ci --prefix desktop|electron\/install/.test(text)) return '需要下载 Electron（只在 CI 跑）';
  if (/\bsudo\b|apt-get|ci-official-apt/.test(text)) return '装系统软件（只在临时构建机做）';
  if (/\bdocker\b|_IMAGE=/.test(text)) return '需要 Docker 镜像';
  if (/gh release|upload|npx playwright install|\bnpm ci\b/.test(text)) return '发布/装依赖（本机已装好）';
  return '';
}

function main(args) {
  const steps = verifySteps(fs.readFileSync(WORKFLOW, 'utf8'));
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : '';
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
  let started = !from;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-gate-'));
  const results = [];
  for (const step of steps) {
    if (!started && step.name.includes(from)) started = true;
    if (!started || only && !step.name.includes(only) && !step.run.includes(only)) continue;
    const reason = skipReason(step);
    if (args.includes('--list')) { console.log(`${reason ? '跳过' : '执行'} | ${step.name}${reason ? `（${reason}）` : ''}`); continue; }
    if (reason) { results.push({ name: step.name, state: 'skipped', reason }); continue; }
    console.log(`\n=== ${step.name}`);
    const begin = Date.now();
    // 与 CI 相同：bash -e、在 jarvis/ 下执行、RUNNER_TEMP 指向独立临时目录
    // CI 里用 GitHub 变量算版本号的地方（如打服务器包）换成本机测试版本号
    const script = step.run.replace(/\$\{\{[^}]*\}\}/g, '0.0.0-local');
    const run = spawnSync('bash', ['-e', '-c', script], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, RUNNER_TEMP: temp, CI: '1' } });
    results.push({ name: step.name, state: run.status === 0 ? 'passed' : 'failed', seconds: Math.round((Date.now() - begin) / 1000) });
  }
  if (args.includes('--list')) return 0;
  const count = state => results.filter(item => item.state === state).length;
  console.log('\n======== 发布门禁汇总 ========');
  for (const item of results) console.log(`${item.state === 'passed' ? '✓' : item.state === 'failed' ? '✗' : '-'} ${item.name}${item.reason ? `（跳过：${item.reason}）` : item.seconds !== undefined ? `  ${item.seconds}s` : ''}`);
  console.log(`\n通过 ${count('passed')}，失败 ${count('failed')}，跳过 ${count('skipped')}。跳过的步骤只在 CI 上跑，本机全过不等于 CI 全过。产物：${temp}`);
  return count('failed') ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
