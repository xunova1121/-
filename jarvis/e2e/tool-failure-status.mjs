/** 真实浏览器验证失败摘要替换“正在…”；两种工具卡片均保留完整详情。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'isolated-tool-status',
      configureServer(vite) {
        vite.middlewares.use('/__tool-status.html', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><html><body><main id="fixture"></main></body></html>');
        });
      }
    }
  ]
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__tool-status.html`);
  for (const progress of [true, false]) {
    const result = await page.evaluate(async (progress) => {
      const { Transcript } = await import('/src/ui/transcript.js');
      const root = document.querySelector('#fixture');
      root.replaceChildren();
      const transcript = new Transcript(root, { progress });
      const bubble = transcript.add('agent');
      const card = bubble.toolCard('plan_architecture', {});
      card.progress('正在整理业务职责、关系及原文映射…');
      const output = '错误：依据未出现在实际读取材料中\n定点修复：entities[0].source';
      card.done(false, output, 1800);
      bubble.done();
      return {
        summary: root.querySelector(progress ? '.pc-tx small' : '.ta').textContent,
        detail: root.querySelector('pre').textContent,
        failed: Boolean(root.querySelector(progress ? 'li[data-st="fail"]' : '.tool-card.fail'))
      };
    }, progress);
    assert.equal(result.summary, '错误：依据未出现在实际读取材料中');
    assert.ok(result.failed);
    assert.ok(result.detail.includes('entities[0].source'));
    assert.ok(result.detail.includes('正在整理业务职责'));
  }
  console.log('通过：手机与桌面失败步骤显示错误摘要，完整进度和修复字段仍可查看。');
} finally {
  await browser?.close();
  await server.close();
}
