/**
 * 浏览器冒烟测试（Playwright + Chromium）：npm run build && npm run server 后执行
 *   node e2e/smoke.mjs [截图输出目录]
 */
import { chromium } from 'playwright';

const BASE = process.env.JARVIS_URL || 'http://127.0.0.1:8787';
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
});

// ---------- 1. 正常模式 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1672, height: 941 }, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 20, null, { timeout: 30000 });
  const stats = await page.evaluate(() => {
    const s = window.__jarvis.stage.stats;
    return { vertices: s.vertices, drawCalls: s.drawCalls, isWebGL2: s.isWebGL2, fps: s.fps, bloom: s.bloom, style: s.style };
  });
  check('WebGL 主视觉启动', true, JSON.stringify(stats));
  check('默认“光核”样式，胸像网格已加载', stats.vertices > 8000 && stats.style === 'orb', `${stats.style} / ${stats.vertices} 顶点`);
  check('泛光开启时 draw calls ≤ 12', stats.bloom === true && stats.drawCalls <= 12, `bloom=${stats.bloom} calls=${stats.drawCalls}`);

  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01-holo.png` });

  // 显示样式：胸像 / 线框 / 光核
  for (const style of ['holo', 'wire', 'orb']) {
    await page.click(`[data-style="${style}"]`);
    await page.waitForTimeout(500);
    const cur = await page.evaluate(() => ({ s: window.__jarvis.stage.stats.style, saved: window.__jarvis.settings.look, calls: window.__jarvis.stage.stats.drawCalls }));
    check(`切换样式：${style}`, cur.s === style && cur.saved === style && cur.calls <= 12, JSON.stringify(cur));
    if (style !== 'orb') await page.screenshot({ path: `${OUT}/02-${style}.png` });
  }

  // 对话：关键词/提示驱动情绪
  await page.fill('#prompt', '最近压力好大');
  const listening = await page.evaluate(() => window.__jarvis.machine.state);
  check('开始输入 → 聆听', listening === '聆听', listening);
  const seen = new Set();
  const watcher = setInterval(async () => { try { seen.add(await page.evaluate(() => window.__jarvis.machine.state)); } catch {} }, 60);
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => window.__jarvis.machine.task === 'done', null, { timeout: 20000 });
  clearInterval(watcher);
  check('请求发出 → 专注', seen.has('专注'), [...seen].join(','));
  check('回复 emotion_hint → 安抚', seen.has('安抚'), [...seen].join(','));
  const after = await page.evaluate(() => window.__jarvis.machine.state);
  check('回合结束 → 亲和', after === '亲和', after);
  await page.screenshot({ path: `${OUT}/04-chat.png` });
  await page.waitForTimeout(3200);
  const calm = await page.evaluate(() => window.__jarvis.machine.state);
  check('3 秒后回落平静', calm === '平静', calm);

  // 工具调用 → 指标问答
  await page.fill('#prompt', '电脑现在状态怎么样');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => window.__jarvis.machine.task === 'done', null, { timeout: 20000 });
  const lastMsg = await page.locator('.msg.agent').last().textContent();
  check('工具调用回复', /CPU/.test(lastMsg), lastMsg.slice(0, 40));

  // 手动覆盖
  await page.click('#emotion-btn');
  await page.click('[data-emotion="警觉"]');
  await page.waitForTimeout(500);
  check('手动锁定警觉', await page.evaluate(() => window.__jarvis.machine.state === '警觉'));
  await page.screenshot({ path: `${OUT}/05-alert.png` });
  await page.click('#emotion-btn');
  await page.click('[data-emotion="auto"]');

  // 仪表视差 / 倾斜
  await page.mouse.move(1500, 300, { steps: 5 });
  await page.waitForTimeout(400);
  const tilt = await page.evaluate(() => document.querySelector('.dash-tilt').style.transform);
  check('指针靠近仪表 → 倾斜', /rotateY\((?!0\.000)/.test(tilt), tilt);
  await page.mouse.move(10, 10);
  await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
  await page.waitForTimeout(1200);
  const rest = await page.evaluate(() => document.querySelector('.dash-tilt').style.transform);
  const angles = [...rest.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Math.abs(Number(m[0])));
  check('移出后归位', angles.length === 2 && angles.every((a) => a < 0.05), rest);

  // 后台暂停
  const reqs = [];
  page.on('request', (r) => { if (r.url().includes('/api/local/metrics')) reqs.push(Date.now()); });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const f1 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  const n0 = reqs.length;
  await page.waitForTimeout(7000);
  const f2 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  check('隐藏后渲染循环停止', f1 === f2 && !(await page.evaluate(() => window.__jarvis.stage.running)), `${f1} → ${f2}`);
  check('隐藏后指标轮询停止', reqs.length === n0, `${reqs.length - n0} 次请求`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(800);
  const f3 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  check('返回后恢复渲染', f3 > f2, `${f2} → ${f3}`);

  // 专注视图
  await page.click('#btn-focus');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/06-focus.png` });
  const fa = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  await page.waitForTimeout(2000);
  const fb = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  check('专注视图降频到 ~20fps', (fb - fa) / 2 <= 22, `${((fb - fa) / 2).toFixed(1)} fps`);
  await page.click('#btn-focus');

  // —— 升级功能：打断、快捷键、画质、记忆
  await page.evaluate(() => { window.__barge = window.__jarvis.send('最近压力好大'); });
  await page.waitForFunction(() => document.querySelector('.msg.agent.streaming .body')?.textContent.length > 3, null, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const barge = await page.evaluate(() => ({
    streaming: document.querySelectorAll('.msg.agent.streaming').length,
    meta: [...document.querySelectorAll('.msg.agent .meta')].at(-1)?.textContent,
    gen: document.body.classList.contains('generating')
  }));
  check('Esc 打断生成', barge.streaming === 0 && barge.meta === '已打断' && !barge.gen, JSON.stringify(barge));

  await page.keyboard.press('Alt+Digit2');
  check('Alt+2 切到对话视图', await page.evaluate(() => document.body.classList.contains('view-chat')));
  await page.keyboard.press('Alt+Digit1');
  await page.keyboard.press('/');
  check('/ 聚焦输入框', await page.evaluate(() => document.activeElement.id === 'prompt'));
  await page.evaluate(() => document.activeElement.blur());

  const who = await page.locator('.msg.agent .who').first().textContent();
  check('消息带发送者与时间', /^贾维斯 · \d{2}:\d{2}$/.test(who), who);

  await page.click('[data-view="settings"]');
  await page.selectOption('#set-quality', 'eco');
  const e0 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  await page.waitForTimeout(2000);
  const e1 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  const eco = await page.evaluate(() => ({ bloom: window.__jarvis.stage.stats.bloom, q: window.__jarvis.quality }));
  check('省电档：关泛光、≤ 24fps', !eco.bloom && eco.q.fps === 24 && (e1 - e0) / 2 <= 25, `${((e1 - e0) / 2).toFixed(1)}fps`);
  await page.selectOption('#set-quality', 'auto');
  await page.click('[data-view="settings"]');

  // 上下文丢失恢复
  const restored = await page.evaluate(async () => {
    const gl = window.__jarvis.stage.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) return 'no-ext';
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    ext.restoreContext();
    const before = window.__jarvis.stage.stats.frames;
    while (window.__jarvis.stage.stats.frames <= before + 2 && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    return Math.round(performance.now() - t0);
  });
  check('WebGL 上下文丢失后恢复 ≤ 500ms', typeof restored === 'number' && restored <= 500, `${restored}ms`);

  check('无页面错误', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------- 1b. 记忆跨会话保存 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.click('[data-view="memory"]');
  await page.check('#set-persist');
  await page.fill('#prompt', '现在几点');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => window.__jarvis.machine.task === 'done', null, { timeout: 20000 });
  await page.reload();
  await page.click('[data-view="memory"]');
  const mem = await page.textContent('#memory-list');
  check('开启保存后刷新仍保留记忆，按天分组', mem.includes('今天') && mem.includes('现在几点'), mem.slice(0, 60));
  await page.click('#btn-clear-memory');
  await page.reload();
  await page.click('[data-view="memory"]');
  check('清空后不再保留', (await page.textContent('#memory-list')).includes('暂无'));
  await ctx.close();
}

// ---------- 2. 减少动画 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.goto(BASE);
  await page.waitForTimeout(2500);
  const loaded3d = urls.filter((u) => /stage-|bust-mesh|three/.test(u));
  check('reduced-motion 不加载 3D 资源', loaded3d.length === 0, loaded3d.join(','));
  check('reduced-motion 显示 CSS 背景', await page.evaluate(() => document.body.classList.contains('reduced-motion') && !window.__jarvis.stage));
  await page.evaluate(() => window.__jarvis.machine.setManual('亲和'));
  await page.waitForTimeout(600);
  const hue = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--hue').trim());
  check('reduced-motion 仍以颜色表达情绪', hue === '35', `--hue=${hue}`);
  await page.screenshot({ path: `${OUT}/07-reduced.png` });
  await ctx.close();
}

// ---------- 3. 窄屏 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(3000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('手机宽度无横向溢出', !overflow);
  await page.screenshot({ path: `${OUT}/08-mobile.png` });
  await ctx.close();
}

// ---------- 4. 人脸跟随 / 直接对话（假摄像头、假麦克风；画面里没有人脸） ----------
{
  const b2 = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });
  const ctx = await b2.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outbound = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(BASE).origin || r.method() !== 'GET') outbound.push(`${r.method()} ${r.url().slice(0, 80)}`);
  });
  await page.goto(BASE);
  await page.waitForTimeout(1500);
  outbound.length = 0;
  page.on('request', () => {});

  await page.click('[data-view="settings"]');
  await page.check('#set-face');
  await page.waitForFunction(() => /跟随中|未检测到|降至/.test(document.querySelector('#face-status').textContent), null, { timeout: 30000 });
  check('人脸跟随启动（Worker + 本地模型）', true, await page.textContent('#face-status'));
  await page.waitForFunction(() => document.querySelector('#face-status').textContent.includes('未检测到人脸'), null, { timeout: 45000 });
  check('连续未检测到人脸 → 轻量提示', true);
  const camOn = await page.evaluate(() => [...document.querySelectorAll('video')].length === 0); // 视频元素不挂到 DOM
  check('摄像头画面不显示/不挂载到页面', camOn);
  await page.uncheck('#set-face');
  await page.waitForTimeout(300);
  check('关闭人脸跟随', (await page.textContent('#face-status')) === '');

  await page.check('#set-voice');
  await page.waitForFunction(() => /已开启|按下说话/.test(document.querySelector('#voice-status').textContent), null, { timeout: 30000 });
  const vs = await page.textContent('#voice-status');
  check('直接对话：VAD 模型加载', vs.includes('已开启'), vs);
  await page.uncheck('#set-voice');

  // 只统计“上传类”请求：POST/PUT 或发往外部域名的请求
  const uploads = outbound.filter((x) => !x.startsWith('GET http://127.0.0.1') && !x.includes('/api/chat'));
  check('感知期间无数据外发', uploads.length === 0, uploads.join(' | '));
  check('感知流程无页面错误', errors.length === 0, errors.join(' | '));
  await b2.close();
}

// ---------- 5. 不支持 SpeechRecognition（模拟 Firefox） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(1000);
  check('无语音识别时隐藏麦克风按钮', await page.isHidden('#btn-mic'));
  await page.fill('#prompt', '你好');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => window.__jarvis.machine.task === 'done', null, { timeout: 20000 });
  check('文本输入仍可用', (await page.locator('.msg.agent').count()) === 1);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
