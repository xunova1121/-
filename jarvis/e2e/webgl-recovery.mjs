/** 独立只测恢复：真实生产构建、SwiftShader，与smoke同门槛；20次一项失败即非零。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { MockAgent } from '../server/agents.mjs';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-webgl-recovery');
await fs.mkdir(out, { recursive: true });
const server = createServer({ agent: new MockAgent(), staticDir: path.resolve(process.env.JARVIS_WEBGL_DIST || 'dist'), ollama: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
// 本地HTTP夹具经过真实网关；不依赖外部模型，也不通过DevTools改写响应。
const fixture = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const finished = request.messages?.some((message) => message.role === 'tool');
  const delta = finished
    ? { content: '八个片段已运行，界面检查完成。' }
    : {
        tool_calls: Array.from({ length: 8 }, (_, i) => ({
          index: i,
          id: 'webgl-fixture-' + i,
          type: 'function',
          function: { name: 'run_javascript', arguments: JSON.stringify({ code: 'return ' + (i + 1) + ';' }) }
        }))
      };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
  );
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureBase = 'http://127.0.0.1:' + fixture.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const records = [],
  errors = [];
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((baseURL) => {
    if (window !== window.top) return; // 不向不透明来源的代码沙箱注入存储配置。
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ quality: 'auto', speechOutput: false, autoMemory: false, directVoice: false }));
    localStorage.setItem(
      'jarvis.llm.v1',
      JSON.stringify({
        provider: 'custom',
        keys: { custom: 'sk-local-ui-fixture' },
        models: { custom: 'webgl-ui-fixture' },
        baseURLs: { custom: baseURL + '/v1' },
        routing: { enabled: false }
      })
    );
    // capture阶段先于Three及应用的恢复处理，不能把同步重建/首帧移到计时之外。
    document.addEventListener(
      'webglcontextrestored',
      () => {
        globalThis.__webglEventStart = performance.now();
      },
      true
    );
  }, fixtureBase);
  await page.goto(base);
  await page.bringToFront();
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  await page.evaluate(() => {
    document.body.classList.add('side-closed');
    document.body.classList.remove('side-open');
  });
  await page.click('.wb-tabs button:nth-child(2)');
  await page.waitForFunction(() => window.__jarvis.stage.stats.frames > 10);
  // 与smoke一样，先实际启用泛光再回自动档，不能只测一张全新空场景。
  for (const quality of ['high', 'auto']) {
    await page.evaluate((value) => {
      const select = document.querySelector('#set-quality');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, quality);
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => window.__jarvis.send('运行八个独立的JavaScript小片段，检查界面反馈。'));
  await page.click('.wb-tabs button:nth-child(2)');
  console.log(
    '工具/HUD前置',
    await page.evaluate(() => ({
      satellites: document.querySelectorAll('.oh-sat').length,
      running: window.__jarvis.stage.running,
      form: window.__jarvis.stage.stats.form,
      size: [window.__jarvis.stage.renderer.domElement.width, window.__jarvis.stage.renderer.domElement.height],
      states: [...document.querySelectorAll('.oh-sat')].map((node) => node.getAttribute('class'))
    }))
  );
  await page.waitForFunction(() => window.__jarvis.stage.running && document.querySelectorAll('.oh-sat').length === 8);
  await page.evaluate(() => {
    globalThis.__webglSatellite = document.querySelector('.oh-sat');
  });
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => globalThis.__webglSatellite === document.querySelector('.oh-sat')), '锚点移动时不能重建相同卫星节点/重启其动画');
  for (let round = 1; round <= 20; round++) {
    const record = await page.evaluate(async () => {
      const stage = window.__jarvis.stage,
        canvas = stage.renderer.domElement;
      const ext = stage.renderer.getContext().getExtension('WEBGL_lose_context');
      if (!ext) throw new Error('本机缺WEBGL_lose_context，不能冒充恢复通过');
      ext.loseContext();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const decorationsPaused =
        canvas.hasAttribute('data-restoring') &&
        [...document.querySelectorAll('.cl-line')].every((node) => getComputedStyle(node).animationPlayState === 'paused');
      globalThis.__webglEventStart = 0;
      let smokeEvent = 0;
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          smokeEvent = performance.now();
        },
        { once: true }
      );
      const requested = performance.now();
      ext.restoreContext();
      const before = stage.stats.frames;
      while (stage.stats.frames <= before + 2 && performance.now() - requested < 3000) await new Promise((resolve) => setTimeout(resolve, 10));
      const ended = performance.now();
      return {
        total: Math.round(ended - requested),
        app: smokeEvent ? Math.round(ended - smokeEvent) : null,
        captureApp: globalThis.__webglEventStart ? Math.round(ended - globalThis.__webglEventStart) : null,
        frames: stage.stats.frames - before,
        decorationsPaused,
        decorationsResumed: !canvas.hasAttribute('data-restoring'),
        hidden: document.hidden,
        focused: document.hasFocus(),
        parallel: stage.stats.parallelCompile,
        compile: stage.stats.restoreCompileMs,
        event: stage.stats.restoreEventMs,
        draws: stage.stats.restoreDrawMs,
        simple: stage.stats.simpleScene,
        aa: stage.renderer.getContext().getContextAttributes()?.antialias,
        form: stage.stats.form,
        size: [canvas.width, canvas.height],
        particles: stage.stats.particles,
        calls: stage.stats.drawCalls,
        software: stage.stats.softwareRenderer,
        quality: window.__jarvis.quality
      };
    });
    const ok =
      record.app !== null &&
      record.app <= 300 &&
      record.captureApp !== null &&
      record.captureApp <= 300 &&
      record.total <= 1500 &&
      record.frames >= 3 &&
      !record.hidden &&
      record.decorationsPaused &&
      record.decorationsResumed;
    records.push({ round, ok, ...record });
    console.log(`${ok ? '✓' : '✗'} WebGL恢复 ${round}/20 ${JSON.stringify(record)}`);
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ records, errors }, null, 2));
    await page.waitForTimeout(500);
  }
  // 省电档和后台暂停必须恢复原行为，不能为加快恢复让舞台永久全速运行。
  await page.evaluate(() => {
    const select = document.querySelector('#set-quality');
    select.value = 'eco';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const cap = await page.evaluate(async () => {
    const stage = window.__jarvis.stage,
      before = stage.stats.frames,
      start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { frames: stage.stats.frames - before, ms: performance.now() - start, fps: window.__jarvis.quality.fps };
  });
  assert.equal(cap.fps, 24);
  assert(cap.frames <= Math.ceil((cap.ms * 24) / 1000) + 1, '恢复之后必须重新遵守24fps，不延长突发窗口');
  const hidden = await page.evaluate(async () => {
    const stage = window.__jarvis.stage,
      canvas = stage.renderer.domElement;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const before = stage.stats.frames,
      ext = stage.renderer.getContext().getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restored = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后台恢复事件未到达')), 5000);
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    ext.restoreContext();
    await restored;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const during = stage.stats.frames;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    return { before, during };
  });
  assert.equal(hidden.during, hidden.before, '隐藏时即使收到恢复事件也不能绘制');
  await page.waitForFunction((before) => window.__jarvis.stage.stats.frames > before + 2, hidden.before);
  console.log('✓ 恢复后保持省电上限；后台恢复不绘制，回到前台才继续');
  await page.screenshot({ path: path.join(out, 'restored.png') });
  const stats = (key) => ({
    median: percentile(
      records.map((item) => item[key]),
      0.5
    ),
    p95: percentile(
      records.map((item) => item[key]),
      0.95
    ),
    max: Math.max(...records.map((item) => item[key]))
  });
  const summary = {
    rounds: records.length,
    passed: records.filter((item) => item.ok).length,
    app: stats('app'),
    captureApp: stats('captureApp'),
    total: stats('total')
  };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ summary, records, errors, cap, hidden }, null, 2));
  console.log(JSON.stringify(summary));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(summary.passed, 20, '20次均须满足300ms/1500ms，包含capture阶段同步重建；无重试取最好值');
  assert(
    records.every((item) => item.particles >= 6000 && item.calls > 0),
    '真实主体必须渲染，不可用空帧计数'
  );
} finally {
  await browser.close();
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
