/** 实际三端构建的形象、手机语音恢复、Windows更新入口；原生桥/模型为可控替身，不代表真机或真实服务验收。 */
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const output = process.argv[2] || '/tmp/weiyang-client-recovery';
await mkdir(output, { recursive: true });
const root = path.resolve('.');
const approvedHash = createHash('sha256').update(await readFile('src/ui/mascot-approved.webp')).digest('hex');
const checks = [];
function check(label, ok) { checks.push({ label, ok: Boolean(ok) }); console.log(`${ok ? '✓' : '✗'} ${label}`); }
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const mobile = url.pathname.startsWith('/mobile/');
  const base = path.join(root, mobile ? 'dist-mobile' : 'dist');
  const suffix = url.pathname.replace(/^\/(mobile|desktop)\//, '').replace(/^\//, '');
  const target = path.resolve(base, suffix || 'index.html');
  try {
    if (!target.startsWith(base + path.sep)) throw new Error('路径越界');
    const bytes = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const positions = { idle: [0, 0], happy: [100 / 3, 0], shy: [200 / 3, 0], think: [100, 0], listen: [0, 50], rub: [100 / 3, 50], wave: [200 / 3, 50], pet: [100, 50], love: [100, 50], wink: [100, 50], spin: [0, 100], dance: [0, 100], sleep: [100 / 3, 100], run: [100, 0] };
try {
  for (const [label, url, selector, width, height] of [
    ['电脑首页', '/desktop/', '.wb-mark .wy-mascot', 1280, 820],
    ['手机首页', '/mobile/', '.home-pet .wy-mascot', 393, 844],
    ['独立桌面陪伴', '/desktop/wallpaper.html?widget=1', '.holo-pet .wy-mascot', 520, 720]
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route('https://**/*', route => route.abort());
    await context.addInitScript(() => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })));
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + url); await page.waitForSelector(selector); await page.waitForTimeout(350);
    const mascot = page.locator(selector).first();
    const metrics = await mascot.evaluate(el => { const s = getComputedStyle(el); return { image: s.backgroundImage, size: s.backgroundSize, width: s.width, height: s.height }; });
    const imageURL = metrics.image.match(/url\(["']?(.*?)["']?\)/)?.[1];
    const bytes = await (await context.request.get(imageURL)).body();
    check(`${label}实际加载已确认素材且保持正方形比例`, createHash('sha256').update(bytes).digest('hex') === approvedHash && metrics.size === '400% 300%' && metrics.width === metrics.height);
    let correct = true;
    for (const [state, expected] of Object.entries(positions)) {
      const actual = await mascot.evaluate((el, value) => { el.dataset.state = value; return getComputedStyle(el).backgroundPosition.split(' ').map(parseFloat); }, state);
      correct &&= actual.every((value, index) => Math.abs(value - expected[index]) < .001);
    }
    check(`${label}十四种状态对应正确动作格`, correct);
    await mascot.evaluate(el => { el.dataset.state = 'happy'; });
    const before = await mascot.evaluate(el => getComputedStyle(el).transform);
    await page.waitForTimeout(180);
    check(`${label}动作实际随时间变化`, before !== await mascot.evaluate(el => getComputedStyle(el).transform));
    await mascot.evaluate(el => { el.dataset.state = 'pet'; });
    const petBefore = await mascot.evaluate(el => getComputedStyle(el).transform);
    await page.waitForTimeout(180);
    check(`${label}摸头动作在独立样式中也能播放`, petBefore !== await mascot.evaluate(el => getComputedStyle(el).transform));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(`${label}减少动效开关有效`, await mascot.evaluate(el => getComputedStyle(el).animationName === 'none'));
    await mascot.evaluate(el => { el.dataset.state = 'idle'; });
    await page.screenshot({ path: path.join(output, `${label}.png`) });
    check(`${label}没有页面异常`, errors.length === 0); await context.close();
  }

  for (const scenario of ['fallback', 'stalled', 'no-cloud', 'cancel-start']) {
    const context = await browser.newContext({ viewport: { width: 393, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
    await context.route('https://**/*', route => route.abort());
    await context.addInitScript(({ scenario }) => {
      const useCloud = ['fallback', 'stalled'].includes(scenario);
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock', keys: useCloud ? { qwen: 'TEST_ONLY_NOT_A_SECRET' } : {}, stt: { engine: 'auto' }, voice: { engine: 'browser', fx: 'none', cues: false } }));
      const nativeEvents = {}, qwenEvents = new Set();
      window.__voiceProbe = { starts: 0, stops: 0, pcm: 0, models: [], closed: 0, sent: false };
      const probe = window.__voiceProbe;
      window.__jarvisSpeech = {
        available: async () => ({ available: true, service: true }),
        checkPermissions: async () => {
          if (scenario === 'cancel-start' && !probe.authorized) return new Promise(resolve => { probe.authorize = () => { probe.authorized = true; resolve({ speechRecognition: 'granted' }); }; });
          return { speechRecognition: 'granted' };
        },
        addListener: async (event, fn) => { nativeEvents[event] = fn; return { remove: () => { delete nativeEvents[event]; } }; },
        start: async () => {
          probe.starts++;
          if (scenario === 'stalled' || scenario === 'cancel-start') return new Promise(() => {});
          throw new Error(scenario === 'no-cloud' ? 'No speech' : '系统语音启动失败（测试）');
        },
        stop: async () => { probe.stops++; }
      };
      window.__jarvisQwenSocket = {
        addListener: async (_, fn) => { qwenEvents.add(fn); return { remove: () => qwenEvents.delete(fn) }; },
        connect: async ({ model }) => { probe.models.push(model); },
        send: async ({ id, data }) => {
          const event = JSON.parse(data);
          const emit = value => { for (const fn of qwenEvents) fn({ id, phase: 'message', data: JSON.stringify(value) }); };
          if (event.type === 'session.update') queueMicrotask(() => emit({ type: 'session.updated' }));
          if (event.type === 'input_audio_buffer.append') {
            probe.pcm++;
            if (!probe.sent && probe.submit) {
              probe.sent = true;
              queueMicrotask(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'voice-recovery', transcript: '你好，未央' }));
            }
          }
        },
        close: async () => { probe.closed++; }
      };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [], addEventListener() {}, cancel() {}, speak(u) { u.onstart?.(); setTimeout(() => u.onend?.(), 20); } } });
    }, { scenario });
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/mobile/'); await page.waitForFunction(() => window.__jarvis);
    await page.click('#btn-call');
    if (scenario === 'no-cloud') {
      await page.waitForFunction(() => document.querySelector('#voice-call-panel').hidden && document.querySelector('#toast').textContent.includes('检查麦克风'));
      check('无识别结果且没有云配置时给出原因并停止循环', await page.evaluate(() => window.__voiceProbe.starts === 3));
    } else if (scenario === 'cancel-start') {
      await page.waitForFunction(() => window.__voiceProbe.authorize);
      await page.click('#btn-call-end'); await page.evaluate(() => window.__voiceProbe.authorize()); await page.waitForTimeout(450);
      check('授权返回前挂断不会重新启动收音', await page.evaluate(() => window.__voiceProbe.starts === 0 && document.querySelector('#voice-call-panel').hidden));
      await page.click('#btn-call'); await page.waitForFunction(() => window.__voiceProbe.starts === 1);
      check('取消启动后仍能再次开启语音', await page.locator('#voice-call-panel').isVisible());
      await page.click('#btn-call-end');
    } else {
      await page.waitForFunction(() => window.__voiceProbe.pcm > 0, null, { timeout: 18000 });
      check(`${scenario}系统失败后实际发送实时PCM而非文件转写`, await page.evaluate(() => window.__voiceProbe.models.length === 1 && window.__voiceProbe.models[0] === 'qwen3-asr-flash-realtime'));
      await page.evaluate(() => { window.__voiceProbe.submit = true; });
      await page.waitForFunction(() => document.querySelector('#transcript .msg.user')?.textContent.includes('你好，未央'));
      check(`${scenario}识别结果进入真实发送链`, true);
      await page.waitForFunction(() => document.querySelector('#transcript .msg.agent:not(.streaming)'));
      check(`${scenario}能收到回复且通话继续`, await page.locator('#voice-call-panel').isVisible());
      await page.screenshot({ path: path.join(output, `voice-${scenario}.png`) });
      await page.click('#btn-call-end'); await page.waitForTimeout(150);
      check(`${scenario}挂断关闭实时连接`, await page.evaluate(() => window.__voiceProbe.closed > 0 && document.querySelector('#voice-call-panel').hidden));
    }
    check(`语音${scenario}没有页面异常`, errors.length === 0); await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await context.route('https://**/*', route => route.abort());
  await context.addInitScript(() => {
    window.__openedRelease = 0;
    window.jarvisDesktop = { version: '1.0.382', onUpdate() {}, onWallpaperRequest() {}, invoke: async method => {
      if (method === 'updateState') return { packaged: true, state: 'error', current: '1.0.382', error: '公开更新暂时不可用' };
      if (method === 'openReleases') window.__openedRelease++;
      return {};
    } };
  });
  const page = await context.newPage(); await page.goto(base + '/desktop/');
  await page.waitForFunction(() => window.__jarvis); await page.evaluate(() => window.__jarvis.showPanel('settings'));
  const advanced = page.locator('#row-version').locator('xpath=ancestor::details[1]');
  if (!await advanced.evaluate(el => el.open)) await advanced.locator(':scope > summary').click();
  await page.locator('#btn-update-manual').click();
  check('Windows检查更新失败时有可用的官方下载入口', await page.evaluate(() => window.__openedRelease === 1));
  await context.close();
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ realDevices: false, realServices: false, checks }, null, 2));
}
console.log(`客户端恢复 ${checks.filter(c => c.ok).length}/${checks.length} 通过`);
if (checks.some(c => !c.ok)) process.exitCode = 1;
