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
  for (const progress of [true, false]) {
    const result = await page.evaluate(async progress => {
      const { Transcript } = await import('/src/ui/transcript.js');
      const root = document.querySelector('#fixture'); root.replaceChildren();
      const transcript = new Transcript(root, { progress });
      const empty = transcript.add('agent');
      const only = empty.toolCard('web_fetch', {}); only.omit(); only.omit(); empty.done();
      const emptyCards = root.querySelectorAll('.progress-card,.tool-group').length;
      const bubble = transcript.add('agent');
      bubble.toolCard('web_search', {}).done(true, '取得来源', 20);
      const skipped = bubble.toolCard('web_fetch', {});
      skipped.progress('正在读取'); skipped.omit();
      bubble.toolCard('web_fetch', {}).done(false, '错误：真实连接超时', 30);
      bubble.done();
      return {
        emptyCards,
        rows: root.querySelectorAll(progress ? '.pc-steps>li' : '.tool-card').length,
        failures: root.querySelectorAll(progress ? 'li[data-st="fail"]' : '.tool-card.fail').length,
        text: root.textContent
      };
    }, progress);
    assert.equal(result.emptyCards, 0);
    assert.equal(result.rows, 2);
    assert.equal(result.failures, 1);
    assert.ok(result.text.includes(progress ? '用了 2 步' : '执行了 2 步（1 步出错）'));
    assert.ok(result.text.includes('真实连接超时'));
    assert.ok(!result.text.includes('正在读取'));
  }
  console.log('通过：正常收尾不留下空卡片、红叉或虚增步骤，真实连接故障仍可查看。');
} finally {
  await browser?.close();
  await server.close();
}
