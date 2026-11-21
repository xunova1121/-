/** 2026-11-12 复审：本机发布门禁直接读 CI 工作流，不另维护清单；能本机跑的都跑，只有 CI 能做的才跳过 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import { verifySteps, skipReason } from '../scripts/release-gate.mjs';

const steps = verifySteps(fs.readFileSync(new URL('../../.github/workflows/jarvis-desktop.yml', import.meta.url), 'utf8'));

it('读出 verify 作业全部步骤，含 1.0.429 漏跑的跨域 e2e', () => {
  expect(steps.length).toBeGreaterThan(20);
  const web = steps.find(step => step.name.includes('网页版和单文件版端到端测试'));
  expect(web.run).toContain('node e2e/agent-resources-cross-origin.mjs');
  expect(web.run).toContain('node e2e/smoke.mjs');
  expect(skipReason(web)).toBe('');
  expect(steps.every(step => !step.run.startsWith('|'))).toBe(true);
});

it('只跳过 CI 专属步骤：装系统软件、Docker、下载 Electron、上传', () => {
  const skipped = steps.filter(step => skipReason(step));
  expect(skipped.length).toBeLessThan(10);
  for (const step of skipped) expect(step.run).toMatch(/sudo|apt-get|ci-official-apt|docker|_IMAGE=|electron|npm ci|gh release|upload|playwright install/);
  expect(skipReason(steps.find(step => step.name.includes('服务器模式端到端测试')))).toBe('');
});
it('成品文件空间回归必须在手机版实际构建之后执行', () => {
  const mobile = steps.findIndex(step => step.name === '构建并验证手机版界面' && step.run.includes('npm run build:mobile'));
  const poster = steps.findIndex(step => step.run.includes('node e2e/poster-task-delivery.mjs'));
  expect(mobile).toBeGreaterThan(-1);
  expect(poster).toBeGreaterThan(mobile);
  expect(skipReason(steps[poster])).toBe('');
});
