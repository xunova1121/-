/** 仅核对独立设计稿，不作为正式App的功能验收。离线生成2×截图和原创SVG图标。 */
import { chromium } from '../../../jarvis/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || '/workspace/artifacts/agent-square-20261105';
await fs.mkdir(out, { recursive: true });
// 管理环境的浏览器禁用file导航；只把本设计文件提供给回环地址，不暴露其他文件。
const html = await fs.readFile(path.join(here, 'index.html'));
const server = http.createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/index.html') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const tab = await ctx.newPage(), errors = [], requests = [], results = [];
tab.on('pageerror', error => errors.push(error.message));
tab.on('request', req => { if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== base) requests.push(req.url()); });
const url = (page, theme = 'light', extras = {}) => base + '/index.html?' + new URLSearchParams({ page, theme, capture: '1', ...extras });
const check = (label, pass, details) => { results.push({ label, pass, ...(details && { details }) }); if (!pass) console.log('FAIL ' + label + ' ' + JSON.stringify(details)); };
try {
  await tab.goto(url('square'));
  const pages = await tab.evaluate(() => window.design.pages.map(([id]) => id));
  for (const theme of ['light', 'dark']) {
    for (const page of pages) {
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.goto(url(page, theme));
      await tab.screenshot({ path: path.join(out, page + '-' + theme + '.png'), fullPage: page !== 'drawer' });
      for (const width of [320, 390, 412]) {
        await tab.setViewportSize({ width, height: 844 });
        for (const scale of [1, 1.3]) {
          const size = await tab.evaluate(scale => {
            document.documentElement.style.fontSize = (16 * scale) + 'px';
            const root = document.documentElement;
            return { actual: root.scrollWidth, viewport: root.clientWidth };
          }, scale);
          check(`${page}/${theme}/${width}/${scale} 无横向溢出`, size.actual <= size.viewport + 1, size);
          if (scale === 1 && width !== 390) await tab.screenshot({ path: path.join(out, `${page}-${theme}-${width}.png`), fullPage: page !== 'drawer' });
        }
      }
      await tab.evaluate(() => { document.documentElement.style.fontSize = ''; });
    }
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.goto(url('gongwen-form', theme, { kind: '述职报告' }));
    await tab.screenshot({ path: path.join(out, 'gongwen-report-' + theme + '.png'), fullPage: true });
    await tab.goto(url('square', theme, { state: 'loading' }));
    check('广场加载态/' + theme, await tab.locator('[aria-busy="true"]').count() === 1 && await tab.locator('[data-agent]').count() === 0);
    await tab.screenshot({ path: path.join(out, 'square-loading-' + theme + '.png'), fullPage: true });
    for (const page of ['square', 'chat']) {
      await tab.setViewportSize({ width: 1280, height: 900 });
      await tab.goto(url(page, theme));
      await tab.screenshot({ path: path.join(out, 'desktop-' + page + '-' + theme + '.png'), fullPage: true });
    }
  }
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.goto(url('square'));
  await tab.locator('.search-mobile [data-search]').fill('找不到的智能体');
  check('搜索空状态', await tab.locator('.empty h3').innerText() === '暂时没有找到');
  await tab.screenshot({ path: path.join(out, 'square-empty-light.png'), fullPage: true });
  await tab.goto(url('start'));
  await tab.locator('[data-starter]').first().click();
  check('推荐问题只填入，不自动发送', await tab.locator('#composer-input').inputValue() === '帮我看懂这份体检报告' && await tab.locator('.user-message').count() === 0);
  await tab.locator('[data-send]').click();
  check('起始页发送后保留智能体身份和问题', await tab.locator('#topbar h1').innerText() === '健康顾问' && await tab.locator('.user-message').innerText() === '帮我看懂这份体检报告');
  await tab.goto(url('templates'));
  await tab.locator('[data-template="2"]').click();
  await tab.locator('[data-slide="1"]').click();
  const slideText = await tab.locator('#preview-slide svg text').allTextContents();
  check('模板可预览数据页', JSON.stringify(slideText) === JSON.stringify(['关键进展，一目了然', '3 个重点', '阶段成果 / 下一步']), slideText);
  await tab.locator('button[data-go="ppt"]').last().click();
  check('选模板返回制作页并保留选择', (await tab.locator('.form-card').innerText()).includes('已选：经营数据分析'));
  await tab.goto(url('complete'));
  check('最终文件突出，过程稿默认折叠', await tab.locator('.final-file').count() === 1 && !(await tab.locator('.other-files').evaluate(el => el.open)));
  await tab.locator('.other-files summary').click();
  check('过程稿可展开', await tab.locator('.other-files').evaluate(el => el.open));
  await tab.goto(url('mine'));
  await tab.locator('[data-step-up="1"]').click();
  check('步骤可调整顺序', (await tab.locator('.step-text').first().innerText()).startsWith('整理 5 条要点'));
  await tab.goto(url('gongwen'));
  await tab.getByRole('button', { name: '更多文种' }).click();
  check('更多文种展开职场四类', JSON.stringify(await tab.locator('#kind-list button').allTextContents()) === JSON.stringify(['方案', '周报', '邮件', '致辞']));
  await tab.goto(url('square'));
  const paths = await tab.evaluate(() => window.design.paths);
  const groups = { agents: ['ppt', 'gongwen', 'research', 'poster', 'ocr', 'health', 'weather', 'market'], functions: ['poster', 'removebg', 'portrait', 'restore', 'ocr', 'caption'] };
  for (const [group, names] of Object.entries(groups)) {
    await fs.mkdir(path.join(here, 'icons', group), { recursive: true });
    for (const name of names) await fs.writeFile(path.join(here, 'icons', group, name + '.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/></svg>\n`);
  }
  check('没有脚本错误', errors.length === 0, errors);
  check('设计稿无外部网络请求', requests.length === 0, requests);
  const cards = [
    ['drawer', '01 / 随时回到对话', '入口收紧，历史记录轻量排列'],
    ['square', '02 / 找到合适的帮手', '两列卡片，按要做的事情选择'],
    ['start', '03 / 直接开始', '能力说明、三句引导、单行输入'],
    ['ppt', '04 / 把资料变成作品', '主题、页数、场景和版式一页完成'],
  ];
  const frames = await Promise.all(cards.map(async ([page, title, caption]) => {
    const png = await fs.readFile(path.join(out, page + '-light.png'));
    return `<section><h2>${title}</h2><p>${caption}</p><div class="phone"><img src="data:image/png;base64,${png.toString('base64')}"></div></section>`;
  }));
  await tab.setViewportSize({ width: 1600, height: 1070 });
  await tab.setContent(`<html lang="zh-CN"><style>*{box-sizing:border-box}body{margin:0;padding:50px 56px;background:#f1f1fa;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:#252730}header{display:flex;align-items:end;justify-content:space-between;margin-bottom:38px}h1{font-size:32px;margin:0 0 10px;font-weight:600}header p{font-size:15px;margin:0;color:#73748a}small{color:#6c667e;font-size:14px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:26px}h2{font-size:17px;font-weight:600;margin:0 0 8px}section p{font-size:13px;margin:0 0 17px;color:#73748a}.phone{height:742px;border:6px solid #fff;border-radius:30px;overflow:hidden;box-shadow:0 16px 30px #47416410;background:#eeecfc}.phone img{width:100%;display:block}footer{font-size:13px;color:#73748a;margin-top:25px}</style><header><div><h1>未央 · 让每件事，都有合适的帮手</h1><p>智能体广场 / 手机端主流程 · 第一版设计</p></div><small>WEIYANG AI · 2026.11</small></header><div class="grid">${frames.join('')}</div><footer>柔和渐变 · 紧凑信息 · 单行输入 · 沿用未央小精灵　｜　设计预览，尚未接入正式应用</footer></html>`);
  await tab.screenshot({ path: path.join(out, 'overview.png') });
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ prototypeOnly: true, actualAppTest: false, results }, null, 2));
  console.log(`设计稿检查 ${results.filter(x => x.pass).length}/${results.length}；截图：${out}`);
  if (results.some(x => !x.pass)) process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
