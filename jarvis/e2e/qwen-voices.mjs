/** 真实手机构建的音色选择/保存/刷新/试听参数；目录和PCM为假服务，不调用付费TTS。 */
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { QWEN_VOICES, QWEN_TTS } from '../shared/qwenRealtime.js';
import { QWEN_VOICE_SOURCE } from '../shared/qwenVoiceCatalog.js';
const root = path.resolve('dist-mobile');
const output = process.argv[2] || '/tmp/qwen-voices-e2e';
await mkdir(output, { recursive: true });
let fail = false;
const received = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/voice/qwen/voices') {
    received.push(req.headers.authorization);
    res.writeHead(fail ? 502 : 200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(fail ? { error: '模拟网络失败' } : { model: QWEN_TTS, source: QWEN_VOICE_SOURCE, fetchedAt: Date.now(), voices: [...QWEN_VOICES, ['FreshOfficial', '新增官方测试音色 · 女声']] }));
  }
  try {
    const file = path.resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
let failures = 0;
let total = 0;
const check = (label, ok) => { total++; console.log((ok ? '✓ ' : '✗ ') + label); if (!ok) failures++; };
try {
  for (const width of [390, 412]) {
    fail = false;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      if (window.top !== window) return;
      if (!localStorage.getItem('jarvis.llm.v1')) localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock', keys: { qwen: 'test-only-key' }, voice: { engine: 'qwen-realtime', voices: { 'qwen-realtime': 'Bella' }, cues: false, fx: 'none' } }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
      const listeners = new Set();
      window.__selectedQwenVoices = [];
      window.__jarvisQwenSocket = {
        addListener: async (_, handler) => { listeners.add(handler); return { remove: () => listeners.delete(handler) }; },
        connect: async () => {},
        send: async ({ id, data }) => {
          const event = JSON.parse(data);
          const emit = value => { for (const handler of listeners) handler({ id, phase: 'message', data: JSON.stringify(value) }); };
          if (event.type === 'session.update') { window.__selectedQwenVoices.push(event.session.voice); queueMicrotask(() => emit({ type: 'session.updated' })); }
          if (event.type === 'session.finish') queueMicrotask(() => { emit({ type: 'response.audio.delta', delta: btoa('\0'.repeat(4800)) }); emit({ type: 'session.finished' }); });
        },
        close: async () => {}
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    check(`${width} 完整内置48音色可见`, await page.locator('#tts-voice option').count() === 48);
    await page.selectOption('#tts-voice', 'Eldric Sage');
    check(`${width} 带空格的官方ID原样保存`, await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).voice.voices['qwen-realtime'] === 'Eldric Sage'));
    await page.fill('#qwen-voice-search', '无匹配音色');
    check(`${width} 搜索无结果不覆盖当前声音`, await page.inputValue('#tts-voice') === 'Eldric Sage');
    await page.fill('#qwen-voice-search', '');
    await page.evaluate(base => localStorage.setItem('jarvis.server.v1', JSON.stringify({ enabled: true, url: base, token: 'catalog-test-token' })), base);
    await page.click('#btn-qwen-voices');
    await page.waitForFunction(() => document.querySelector('#qwen-voice-info').textContent.includes('已更新官方目录'));
    check(`${width} 从云端刷新并显示新增ID`, await page.locator('#tts-voice option').count() === 49 && received.at(-1) === 'Bearer catalog-test-token');
    await page.selectOption('#tts-voice', 'FreshOfficial');
    await page.click('#btn-tts-preview');
    await page.waitForFunction(() => window.__selectedQwenVoices.includes('FreshOfficial'));
    check(`${width} 试听实际session.update使用所选音色`, await page.evaluate(() => window.__selectedQwenVoices.at(-1) === 'FreshOfficial'));
    fail = true;
    await page.click('#btn-qwen-voices');
    await page.waitForFunction(() => document.querySelector('#qwen-voice-info').textContent.includes('刷新未完成'));
    check(`${width} 刷新失败保留已选音色和目录`, await page.inputValue('#tts-voice') === 'FreshOfficial' && await page.locator('#tts-voice option').count() === 49);
    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    check(`${width} 重启后恢复目录和选择`, await page.inputValue('#tts-voice') === 'FreshOfficial' && await page.locator('#tts-voice option').count() === 49);
    check(`${width} 目录与长ID不撑宽页面`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#panel').scrollWidth <= document.querySelector('#panel').clientWidth));
    check(`${width} 无页面异常`, errors.length === 0);
    await page.locator('#row-tts-voice').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `qwen-voices-${width}.png`) });
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`音色目录 ${total - failures}/${total} 通过`);
if (failures) process.exitCode = 1;
