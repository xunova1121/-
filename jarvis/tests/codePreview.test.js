import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codePreview } from '../server/codePreview.mjs';
import { codeProjectRoutes } from '../server/codeProjectRoutes.mjs';
it('HTML预览内联本地脚本图片，限制网络，不回退到宿主路径', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-preview-'));
  try {
    await fs.writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><title>Fixture</title><link href="app.css" rel="stylesheet"><script src="app.js" defer></script><img src="image.svg">'
    );
    await fs.writeFile(path.join(root, 'app.css'), 'body{color:navy}');
    await fs.writeFile(path.join(root, 'app.js'), 'document.title="Fixture loaded";');
    await fs.writeFile(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const result = await codePreview(root, 'index.html');
    expect(result.html).toContain("connect-src 'none'");
    expect(result.html).toContain('data:application/javascript;base64,');
    expect(result.html).toContain('data:image/svg+xml;base64,');
    expect(result.resources).toBe(3);
    expect(result.html).toMatch(/^<!doctype html>/);
    expect(result.html).toContain('defer');
    await expect(codePreview(root, '../outside.html')).rejects.toBeTruthy();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('项目确认不能从缺少明确confirm的HTTP请求触发', async () => {
  let executed = false,
    response;
  const route = codeProjectRoutes({
    projects: {
      execute: async () => {
        executed = true;
      }
    },
    readJson: async () => ({ sessionId: 's', requestId: 'r' }),
    json: (_, status, body) => (response = { status, body })
  });
  await route({ method: 'POST' }, null, '/api/server/code-projects/confirm', new URL('http://localhost/api/server/code-projects/confirm'));
  expect(response.status).toBe(400);
  expect(executed).toBe(false);
});
