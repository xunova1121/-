/** 实际手机构建的统一主题验收；使用假天气，不调用真实模型。 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-mobile');
const output = process.argv[2] || '/tmp/weiyang-mobile-theme';
await mkdir(output, { recursive: true });
const checks = [];
function check(label, passed, detail = '') {
  checks.push(passed);
  console.log(`${passed ? '✓' : '✗'} ${label} ${detail}`);
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};
const server = http.createServer(async (req, res) => {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const target = path.resolve(root, requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath.slice(1)));
  try {
    if (!target.startsWith(root + path.sep)) throw new Error('路径越界');
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const startupContext = await browser.newContext({ viewport: { width: 393, height: 740 }, isMobile: true, hasTouch: true });
  await startupContext.addInitScript(() => {
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
  });
  await startupContext.route('https://**/*', (route) => route.abort());
  let releaseEntry;
  const entryGate = new Promise((resolve) => {
    releaseEntry = resolve;
  });
  await startupContext.route('**/*.js', async (route) => {
    await entryGate;
    await route.continue();
  });
  const startupPage = await startupContext.newPage();
  await startupPage.goto(base, { waitUntil: 'commit' });
  await startupPage.waitForSelector('#app-splash', { state: 'attached' });
  await startupPage.waitForFunction(() => getComputedStyle(document.querySelector('#app-splash .as-logo')).backgroundImage.includes('mascot-startup'));
  check(
    '模拟原生桥延迟时首帧是浅色眨眼页，旧骨架始终隐藏',
    await startupPage.evaluate(() => {
      const splash = document.querySelector('#app-splash');
      return (
        getComputedStyle(document.querySelector('.app')).visibility === 'hidden' &&
        getComputedStyle(splash).backgroundImage.includes('238, 240, 255') &&
        getComputedStyle(document.querySelector('#boot')).display === 'none' &&
        !document.body.classList.contains('compact')
      );
    })
  );
  // 首帧阶段主脚本刻意挂起，普通screenshot会等document.fonts.ready而互锁。
  // CDP直接记录当前画面，不等待加载完成，也不提前放开主脚本。
  const capture = await startupContext.newCDPSession(startupPage);
  const firstFrame = await capture.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, 'theme-real-first-paint.png'), Buffer.from(firstFrame.data, 'base64'));
  await capture.detach();
  releaseEntry();
  await startupPage.waitForFunction(() => document.documentElement.classList.contains('mobile-ui-ready'));
  await startupPage.waitForFunction(() => !document.querySelector('#app-splash'));
  check(
    '原生桥恢复后才揭开已初始化首页，角色不透明缺失',
    await startupPage.evaluate(
      () =>
        document.body.classList.contains('compact') &&
        getComputedStyle(document.querySelector('.app')).visibility === 'visible' &&
        !document.body.classList.contains('mascot-unavailable') &&
        Boolean(document.querySelector('.home-reference'))
    )
  );
  await startupContext.close();
  for (const width of [320, 390, 412]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 320 ? 640 : 740 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce'
    });
    await context.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition: (success) => success({ coords: { latitude: 31.234, longitude: 121.474 } }) }
      });
    });
    await context.route('https://**/*', (route) => route.abort());
    await context.route('https://api.open-meteo.com/**', (route) => {
      const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      return route.fulfill({
        json: {
          utc_offset_seconds: 28800,
          current: { temperature_2m: 22, weather_code: 0, is_day: 1, time: today + 'T12:00' },
          daily: { time: [today], temperature_2m_min: [16], temperature_2m_max: [24], weather_code: [0], precipitation_probability_max: [0] }
        }
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel && document.querySelector('.home-reference'));
    await page.waitForFunction(() => document.querySelector('#app-splash')?.hidden !== false);
    if (width === 390) {
      // 真实构建的启动样式：夜间设置下也保持浅底，素材可读取，角色不旋转。
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const startup = await page.evaluate(async () => {
        const root = document.documentElement;
        const previous = root.dataset.theme;
        root.dataset.theme = 'dark';
        const preview = document.createElement('div');
        preview.id = 'app-splash';
        preview.innerHTML =
          '<div class="as-inner"><div class="as-logo"></div><div class="as-name">未央</div><div class="as-sub">我在，和你一起开始。</div></div>';
        document.body.append(preview);
        const logo = preview.querySelector('.as-logo');
        const style = getComputedStyle(logo);
        const source = style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
        const image = new Image();
        const loaded = await new Promise((resolve) => {
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = source || '';
        });
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const drawing = canvas.getContext('2d');
        if (loaded) drawing.drawImage(image, 0, 0, 128, 64);
        const pixels = drawing.getImageData(0, 0, 128, 64).data;
        const visiblePixels = pixels.some((value, index) => index % 4 === 3 && value > 128);
        const motion = logo.getAnimations()[0];
        motion.pause();
        motion.currentTime = 0;
        const firstFrame = getComputedStyle(logo).backgroundPosition;
        motion.currentTime = 650;
        const blinkFrame = getComputedStyle(logo).backgroundPosition;
        const result = {
          framesMove: firstFrame !== blinkFrame,
          visiblePixels,
          background: getComputedStyle(preview).backgroundImage,
          animation: style.animationName,
          transform: style.transform,
          loaded,
          bootHidden: !document.querySelector('#boot') || getComputedStyle(document.querySelector('#boot')).display === 'none'
        };
        root.dataset.theme = previous;
        return result;
      });
      check(
        '启动页浅底、眨眼挥手、不旋转，屏蔽旧黑色自检',
        startup.background.includes('238, 240, 255') &&
          startup.animation === 'startup-wave-blink' &&
          startup.transform === 'none' &&
          startup.loaded &&
          startup.visiblePixels &&
          startup.framesMove &&
          startup.bootHidden,
        JSON.stringify(startup)
      );
      await page.screenshot({ path: path.join(output, 'theme-startup-390.png') });
      await page.evaluate(() => document.querySelector('#app-splash')?.remove());
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    const metrics = await page.evaluate(() => {
      const home = document.querySelector('.home-reference');
      const model = document.querySelector('#model-chip').getBoundingClientRect();
      const input = document.querySelector('#inputbar').getBoundingClientRect();
      return {
        background: getComputedStyle(document.body).getPropertyValue('--bg').trim(),
        titleSize: parseFloat(getComputedStyle(home.querySelector('h1')).fontSize),
        count: home.querySelectorAll('.home-suggestion').length,
        width: document.documentElement.scrollWidth,
        composerFits: input.left >= 0 && input.right <= innerWidth && input.bottom <= innerHeight,
        modelFits: model.top >= input.top && model.bottom <= input.bottom,
        image: getComputedStyle(home.querySelector('.wy-mascot')).backgroundImage
      };
    });
    check(`${width} 首页参考配色与字号`, metrics.background === '#eef0ff' && metrics.titleSize >= 15 && metrics.titleSize <= 17 && metrics.count === 3);
    check(`${width} 输入区与模型标签可见且无横向溢出`, metrics.width <= width && metrics.composerFits && metrics.modelFits, JSON.stringify(metrics));
    check(`${width} 使用批准的新未央形象`, metrics.image.includes('mascot-approved'));
    check(
      `${width} 原生可用高度下首页一屏完整、无内容被输入区遮挡`,
      await page.evaluate(() => {
        const transcript = document.querySelector('#transcript');
        const files = document.querySelector('.home-files').getBoundingClientRect();
        const suggestions = document.querySelector('.home-suggestions').getBoundingClientRect();
        const input = document.querySelector('#inputbar').getBoundingClientRect();
        return transcript.scrollHeight <= transcript.clientHeight + 2 && files.bottom <= input.top && suggestions.bottom <= files.top + 2;
      })
    );
    check(
      `${width} 天气集中右侧且图标与位置开关不重叠`,
      await page.evaluate(() => {
        const icon = document.querySelector('.home-weather-details').getBoundingClientRect();
        const position = document.querySelector('.home-weather-location').getBoundingClientRect();
        const date = document.querySelector('.home-date').getBoundingClientRect();
        const summary = document.querySelector('.home-weather-summary').getBoundingClientRect();
        return (
          icon.left >= innerWidth / 2 - 12 &&
          icon.right <= position.left &&
          position.right <= innerWidth - 16 &&
          summary.right <= position.right + 4 &&
          date.right <= icon.left + 2
        );
      })
    );
    await page.screenshot({ path: path.join(output, `theme-home-${width}.png`) });
    for (const pane of ['sessions', 'workspace', 'knowledge', 'mind', 'skills', 'models', 'system', 'settings']) {
      await page.evaluate((value) => window.__jarvis.showPanel(value), pane);
      await page.waitForTimeout(150);
      const panelMetrics = await page.evaluate((value) => {
        const panel = document.querySelector('#panel');
        const content = panel.querySelector(`[data-pane="${value}"]`);
        return {
          width: panel.scrollWidth,
          doc: document.documentElement.scrollWidth,
          visible: !content.hidden,
          background: getComputedStyle(panel).backgroundImage,
          font: getComputedStyle(content).fontFamily
        };
      }, pane);
      check(
        `${width} ${pane}统一主题且不撑宽`,
        panelMetrics.visible &&
          panelMetrics.width <= width &&
          panelMetrics.doc <= width &&
          panelMetrics.background.includes('gradient') &&
          panelMetrics.font.includes('HarmonyOS'),
        JSON.stringify(panelMetrics)
      );
      await page.screenshot({ path: path.join(output, `theme-${pane}-${width}.png`) });
      if (width === 390) {
        // 不只看首屏：滚到面板底部检查长表单和页尾入口。
        const bottomMetrics=await page.evaluate((value)=>{
          const content=document.querySelector(`[data-pane="${value}"]`);
          const panel=document.querySelector('#panel');
          for(const el of [panel,content]) el.scrollTop=el.scrollHeight;
          return {width:panel.scrollWidth,doc:document.documentElement.scrollWidth,title:parseFloat(getComputedStyle(content.querySelector('h2')||content).fontSize)};
        },pane);
        check(`${pane} 页尾保持统一字号且无横向溢出`,bottomMetrics.width<=width&&bottomMetrics.doc<=width&&bottomMetrics.title<=18,JSON.stringify(bottomMetrics));
        await page.screenshot({path:path.join(output,`theme-${pane}-bottom-${width}.png`)});
      }

    }
    await page.click('#btn-theme');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    check(
      `${width} 夜间仍使用深色令牌`,
      await page.evaluate(
        () =>
          getComputedStyle(document.body).getPropertyValue('--bg').trim() === '#191b2b' &&
          getComputedStyle(document.querySelector('#panel')).color === 'rgb(240, 239, 250)'
      )
    );
    await page.screenshot({ path: path.join(output, `theme-dark-${width}.png`) });
    await page.click('#btn-theme');
    await page.click('#btn-side-back');
    await page.locator('.brand-mark').click();
    const companion = await page.locator('.wy-companion').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { width: box.width, left: box.left, right: box.right, title: parseFloat(getComputedStyle(el.querySelector('h2')).fontSize) };
    });
    check(`${width} 陪伴完整页和参考字号`, companion.left >= 0 && companion.right <= width && companion.title <= 22);
    await page.screenshot({ path: path.join(output, `theme-companion-${width}.png`) });
    await page.getByRole('button', { name: '摸摸头', exact: true }).click();
    check(
      `${width} 摸头真实更新形态与对白`,
      (await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')) === 'pet' &&
        /温柔/.test(await page.locator('.wy-companion-say').textContent())
    );
    await page.getByRole('button', { name: '关闭未央', exact: true }).click();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    check(
      `${width} 大字体仍可滚动且输入可见`,
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#inputbar').getBoundingClientRect().bottom <= innerHeight
      )
    );
    check(`${width} 无页面脚本异常`, errors.length === 0, errors.join(';'));
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`统一主题 ${checks.filter(Boolean).length}/${checks.length}`);
if (checks.some((item) => !item)) process.exitCode = 1;
