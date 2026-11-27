import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { browserRequest, createCodeBrowser } from '../server/codeBrowser.mjs';
import { codeRepoFixture } from './helpers/codeRepoFixture.mjs';
import { createCodeTools } from '../server/codeTools.mjs';
it('浏览器输入有界，不接受越界路径或任意脚本', () => {
  expect(browserRequest({})).toMatchObject({ entry: 'index.html', width: 390, height: 844, steps: [] });
  for (const v of [
    { entry: '../x.html' },
    { entry: '/x.html' },
    { width: 10 },
    { steps: Array(41).fill({ action: 'wait' }) },
    { steps: [{ action: 'evaluate', value: 'process.env' }] }
  ])
    expect(() => browserRequest(v)).toThrow();
});
it('未配置提前停；新工具显式启用，旧代码工具列表保留', async () => {
  await expect(createCodeBrowser({ baseDir: '/tmp/unused-code-browser' }).run({ root: '/tmp', files: [] })).rejects.toMatchObject({
    code: 'CODE_BROWSER_UNAVAILABLE'
  });
  expect(createCodeTools({ repos: {}, sessionId: 's', taskId: 't', editing: true }).map((t) => t.name)).not.toContain('code_browser');
  expect(createCodeTools({ repos: {}, sessionId: 's', taskId: 't', editing: true, enableBrowser: true }).map((t) => t.name)).toContain('code_browser');
});
it('有界内容快照只读断网；单测回执/图片独立返回，宿主文件不变', async () => {
  const f = await codeRepoFixture({ 'index.html': '<title>Fixture</title>' });
  let args;
  try {
    const runDocker = async (a) => {
      if (a[0] === 'image') return { exitCode: 0, stdout: 'sha256:' + 'a'.repeat(64), stderr: '' };
      if (a[0] === 'ps' || a[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      args = a;
      const out = a.find((v) => v.includes('dst=/output')).match(/src=([^,]+)/)[1];
      await fs.writeFile(
        path.join(out, 'report.json'),
        JSON.stringify({ ok: true, checks: [{ ok: true }], errors: [], visual: 'rendered_not_human_reviewed' })
      );
      await fs.writeFile(path.join(out, 'preview.png'), 'unit-fixture-not-real-png');
      return { exitCode: 0, stdout: 'fixture', stderr: '' };
    };
    const b = createCodeBrowser({ image: 'fixture:browser', baseDir: path.join(f.directory, 'jobs'), runDocker }),
      r = await b.run({ root: f.source, files: ['index.html'] });
    expect(r.ok).toBe(true);
    expect(r.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(r.screenshotBytes).toBeInstanceOf(Buffer);
    expect(args).toEqual(expect.arrayContaining(['--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL']));
    expect(args.find((v) => v.includes('dst=/source'))).toContain('readonly');
    expect(await fs.readFile(path.join(f.source, 'index.html'), 'utf8')).toBe('<title>Fixture</title>');
    expect(await fs.readdir(path.join(f.directory, 'jobs'))).toEqual([]);
  } finally {
    await f.close();
  }
});
