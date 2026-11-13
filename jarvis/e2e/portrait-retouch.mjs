/** 正式手机/网页构建的原片修图链路；PNG和模型回执均为本机夹具，不冒充真人效果。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { sizedRasterPng } from '../tests/fixtures/visualRasterImages.js';

const root = process.cwd();
const out = path.resolve(process.argv[2] || '/tmp/weiyang-portrait-retouch');
await mkdir(out, { recursive: true });
const original = sizedRasterPng(512, 768), edited = sizedRasterPng(1024, 1536, [232, 213, 199]);
const quality = { appearancePreserved: true, naturalSkin: true, naturalProportions: true, backgroundPreserved: true, noArtifacts: true, requestedChangeVisible: true, issues: [] };
let task = 'portrait_slim', imageModel = 'gpt-image-2', edits = 0, reviews = 0, generations = 0, mainRequests = 0;
const apiErrors = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname.startsWith('/v1/')) {
      const parts = []; for await (const part of req) parts.push(part);
      const body = Buffer.concat(parts);
      if (url.pathname === '/v1/images/edits') {
        edits++;
        let prompt;
        if (imageModel === 'gpt-image-2.6-sunburst') {
          assert.ok(req.headers['content-type'].startsWith('application/json'));
          const request = JSON.parse(body);
          assert.equal(request.model, imageModel); assert.equal(request.n, 1);
          assert.equal(request.images.length, 1);
          assert.equal(request.images[0].image_url, 'data:image/png;base64,' + original.toString('base64'));
          prompt = request.prompt;
        } else {
          const request = new Request('http://localhost/v1/images/edits', { method: 'POST', headers: req.headers, body });
          const form = await request.formData();
          assert.equal(form.get('model'), 'gpt-image-2');
          assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), original);
          prompt = form.get('prompt');
        }
        assert.ok(String(prompt).includes(task === 'portrait_slim' ? '自然显瘦' : '自然美颜'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ b64_json: edited.toString('base64') }] }));
        return;
      }
      if (url.pathname === '/v1/images/generations') { generations++; throw new Error('原片修图不能走文生图'); }
      if (url.pathname === '/v1/chat/completions') {
        const request = JSON.parse(body);
        res.setHeader('Content-Type', 'text/event-stream');
        const event = (delta, finish = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
        if (String(request.messages[0]?.content).includes('比较图1原片与图2修图候选')) {
          reviews++;
          assert.equal(request.messages.at(-1).content.filter(part => part.type === 'image_url').length, 2);
          event({ content: JSON.stringify(quality) }); event({}, 'stop');
        } else if (request.tools?.some(tool => tool.function?.name === 'process_image') && !request.messages.some(message => message.role === 'tool')) {
          mainRequests++;
          event({ tool_calls: [{ index: 0, id: 'portrait-call', type: 'function', function: { name: 'process_image', arguments: JSON.stringify({ task, path: '上传/原片.png', instructions: '默认自然，保留长相与原背景' }) } }] });
          event({}, 'tool_calls');
        } else {
          mainRequests++;
          event({ content: '人像修图候选已保存，原片保留，请对照确认效果。' }); event({}, 'stop');
        }
        res.end('data: [DONE]\n\n'); return;
      }
      throw new Error('未知测试API');
    }
    const webRoot = path.resolve(root, url.pathname.startsWith('/dist-mobile/') ? 'dist-mobile' : 'dist');
    const relative = url.pathname.startsWith('/dist-mobile/') ? url.pathname.slice('/dist-mobile/'.length) : url.pathname.slice(1) || 'index.html';
    const target = path.resolve(webRoot, decodeURIComponent(relative));
    if (!target.startsWith(webRoot + path.sep)) throw new Error('outside');
    const data = await readFile(target);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.wasm': 'application/wasm' })[path.extname(target)] || 'application/octet-stream');
    res.end(data);
  } catch (error) {
    if (req.url.startsWith('/v1/')) apiErrors.push(error.message);
    res.statusCode = req.url.startsWith('/v1/') ? 500 : 404;
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser;
const results = [];
try {
  browser = await chromium.launch();
  for (const [width, model] of [[390, 'gpt-image-2'], [1280, 'gpt-image-2'], [390, 'gpt-image-2.6-sunburst'], [1280, 'gpt-image-2.6-sunburst']]) {
    imageModel = model;
    const label = `${width}-${model}`;
    task = width === 390 ? 'portrait_slim' : 'portrait_retouch';
    edits = reviews = generations = mainRequests = 0;
    apiErrors.length = 0;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 800, hasTouch: width < 800 });
    await context.route('https://**/*', route => route.abort());
    await context.addInitScript(({ base, imageModel }) => {
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false, autoMemory: false, teamMode: 'off' }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'custom', models: { custom: 'gpt-4.1-mini' }, keys: { custom: 'fixture-key' }, baseURLs: { custom: base + '/v1' }, imageModel, routing: { enabled: false }, hedgeBackup: false, abilities: { vision: { main: { provider: 'custom', model: 'gpt-4.1-mini' } }, image: { main: { provider: 'custom', model: imageModel } } } }));
    }, { base, imageModel });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
    await page.goto(base + (width < 800 ? '/dist-mobile/index.html' : '/'));
    await page.waitForFunction(() => window.__jarvis?.agents);
    await page.evaluate(async () => { document.querySelector('#app-splash')?.remove(); await window.__jarvis.agents.start(await window.__jarvis.agents.profileOf('poster-designer')); });
    const start = page.locator('.wy-agent-start[data-agent="poster-designer"]');
    await start.getByRole('tab', { name: '图片处理', exact: true }).click();
    await start.getByRole('button', { name: task === 'portrait_slim' ? '人像显瘦' : '人像优化', exact: true }).click();
    assert.equal(await start.locator('[data-field="ratio"]').isVisible(), false);
    assert.equal(await start.locator('[data-field="caption"]').isVisible(), false);
    assert.equal(await start.getByText('选好效果，上传原片即可发送；也可补充想调整的部位。默认自然修图，原片保留，结果另存。', { exact: true }).isVisible(), true);
    assert.equal(edits, 0); assert.equal(reviews, 0);
    await page.screenshot({ path: `${out}/portrait-start-${label}.png` });
    await page.setInputFiles('#file-input', { name: '原片.png', mimeType: 'image/png', buffer: original });
    await page.waitForSelector('#attach-list .attach-name[title="上传/原片.png"]');
    assert.equal(await page.locator('#attach-list .has-thumb img').count(), 1);
    await page.fill('#prompt', task === 'portrait_slim' ? '把这张人像自然P瘦，保留长相与原背景' : '给这张人像自然美颜，保留长相与原背景');
    await page.click('#btn-send');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent .body')].some(node => node.textContent.includes('人像修图候选已保存')), null, { timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent img')].some(image => image.src.startsWith('blob:') && image.complete && image.naturalWidth === 1024 && image.naturalHeight === 1536));
    const saved = await page.evaluate(async () => {
      const app = window.__jarvis;
      const session = await app.sessionGet(app.sessionId);
      const file = session.messages.filter(message => message.role === 'assistant').at(-1)?.files?.find(name => /人像.*\.png$/.test(name));
      if (!file) return null;
      const blob = await app.workspace.readBlob(file);
      return { file, bytes: [...new Uint8Array(await blob.arrayBuffer())], original: [...new Uint8Array(await (await app.workspace.readBlob('上传/原片.png')).arrayBuffer())] };
    });
    assert.ok(saved);
    assert.deepEqual(Buffer.from(saved.bytes), edited); assert.deepEqual(Buffer.from(saved.original), original);
    assert.equal(edits, 1); assert.equal(reviews, 1); assert.equal(generations, 0); assert.ok(mainRequests <= 3);
    assert.deepEqual(apiErrors, []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${out}/portrait-result-${label}.png` });
    results.push({ width, imageModel, protocol: model.includes('2.6') ? 'json' : 'multipart', task, edits, reviews, generations, mainRequests, originalUnchanged: true, actual: '1024x1536', visualModel: 'fixture' });
    } catch (error) {
      await page.screenshot({ path: `${out}/failure-${label}.png` }).catch(() => {});
      const state = { width, imageModel, task, edits, reviews, generations, mainRequests, errors, apiErrors, text: await page.locator('body').innerText() };
      await writeFile(`${out}/failure-${label}.json`, JSON.stringify(state, null, 2));
      throw error;
    }
    await context.close();
  }
  await writeFile(out + '/report.json', JSON.stringify(results, null, 2));
  console.log('通过：手机与PC人像操作不要求海报参数，真实原片multipart编辑各1次、双图检查各1次，候选原字节保存，原片未覆盖；不代表真人或付费模型效果验收。');
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
