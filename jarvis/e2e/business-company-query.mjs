/** 正式页面的企业直查交互；真实登录与本机服务器，企业回执为替身，不调用外部API。 */
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-business-company-query'); await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'business-query-ui-'));
const mode = createServerMode({ dataDir: dir, password: 'business-query-fixture', autoTenderRefresh: false }); await mode.ready;
const servers = [createServer({ serverMode: mode, staticDir: path.resolve('dist-mobile') }), createServer({ serverMode: mode, staticDir: path.resolve('dist') })];
for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const results = [];
const check = (label, ok) => { results.push({ label, ok }); console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) throw new Error(label); };
let browser;
try {
  browser = await chromium.launch();
  for (const [width, theme, zoom] of [[320, 'day', false], [390, 'day', false], [412, 'night', true], [1280, 'day', false]]) {
    const base = 'http://127.0.0.1:' + servers[width < 800 ? 0 : 1].address().port;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width < 800 });
    await context.route('https://**/*', route => route.abort());
    await context.addInitScript(({ base, token, theme }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false }));
    }, { base, token: tokenFor('business-query-fixture'), theme });
    const page = await context.newPage();
    const errors = [], calls = [], pending = [];
    let fixture = 'public';
    page.on('pageerror', error => errors.push(error.message));
    const publicReceipt = company => ({ company, section: 'basic', source: '公开资料', state: 'unverified', dataRetrieved: true,
      retrievedAt: '2026-11-12T04:00:00Z', items: [{ title: company + '简介', url: 'https://company.example.com/about', snippet: '<img src=x onerror=alert(1)>本地测试资料，不是真实企业信息。', evidence: 'search_summary', registrationVerified: false }],
      leads: [{ title: '待核实的母公司资料', url: 'https://parent.example.com/about', reason: '尚未读取原文' }], warnings: [] });
    await page.route('**/api/server/company-query', async route => {
      const args = route.request().postDataJSON(); calls.push(args);
      if (fixture === 'pending') { pending.push(route); return; }
      if (fixture === 'error') { await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '查询来源暂时不可用', code: 'COMPANY_QUERY_FAILED' }) }); return; }
      const receipt = fixture === 'qibook'
        ? { company: args.company, section: args.section, source: '企百科', state: 'ok', dataRetrieved: true, rows: [{ 股东名称: '测试股东（夹具）', 出资比例: '30%', access_key: 'never-render-this-key' }] }
        : fixture === 'empty' ? { company: args.company, source: '公开资料', state: 'empty', dataRetrieved: false, items: [], leads: [] }
          : publicReceipt(args.company);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(receipt) });
    });
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.agents && window.__jarvisServerClient);
    await page.evaluate(async () => {
      document.querySelector('#app-splash')?.remove();
      const app = window.__jarvis; await app.agents.start(await app.agents.profileOf('business-intelligence'));
    });
    if (zoom) await page.addStyleTag({ content: 'html{font-size:130% !important}' });
    const start = page.locator('.wy-agent-start[data-agent="business-intelligence"]');
    await start.getByRole('tab', { name: '查企业', exact: true }).waitFor();
    const name = start.getByLabel('你想查哪家公司？', { exact: true });
    const query = start.getByRole('button', { name: '查询企业', exact: true });
    if (width === 390) {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const firstScreen = await page.evaluate(() => {
        const button = document.querySelector('.wy-business-query-submit');
        const rect = button.getBoundingClientRect();
        const transcript = document.querySelector('#transcript').getBoundingClientRect();
        const composer = document.querySelector('#inputbar').getBoundingClientRect();
        const field = document.querySelector('.wy-business-company-form > [data-field="company_source"]');
        const label = field.querySelector('span').getBoundingClientRect();
        const select = field.querySelector('select').getBoundingClientRect();
        const corners = [[rect.left + 12, rect.top + 12], [rect.right - 12, rect.bottom - 12]];
        return { height: innerHeight, scrollTop: document.querySelector('#transcript').scrollTop, buttonTop: rect.top, buttonBottom: rect.bottom, composerTop: composer.top,
          visible: rect.top >= transcript.top && rect.bottom <= Math.min(transcript.bottom, composer.top, innerHeight)
            && corners.every(([x, y]) => button.contains(document.elementFromPoint(x, y))),
          sourceInline: label.right <= select.left && Math.max(label.top, select.top) < Math.min(label.bottom, select.bottom) };
      });
      check('390×844 默认首页无需滚动即可完整点击查询按钮，底部输入栏不遮挡', firstScreen.height === 844 && firstScreen.scrollTop === 0 && firstScreen.visible);
      check('390×844 来源标签和选择框同一行，保留费用说明', firstScreen.sourceInline && await start.locator('.wy-business-source-note').isVisible());
      await writeFile(out + '/company-390x844-first-screen.json', JSON.stringify(firstScreen, null, 2));
      await page.screenshot({ path: `${out}/company-390x844-first-screen.png` });
      await page.setViewportSize({ width, height: 1000 });
    }
    check(`${width} 默认查企业和公开来源，无打开即付费查询`, await start.getByRole('tab', { name: '查企业', exact: true }).getAttribute('aria-selected') === 'true'
      && await start.locator('[data-field="company_source"] select').inputValue() === '公开来源' && calls.length === 0);
    check(`${width} 旧推荐和草稿入口保留但默认折叠`, await start.locator('.wy-agent-starter').count() === 3 && await start.locator('.wy-business-action').count() === 4
      && !(await start.locator('.wy-business-advanced').evaluate(node => node.open)) && !(await start.locator('.wy-business-more').evaluate(node => node.open)));
    await query.click();
    await start.getByText('请先填写企业名称或统一社会信用代码。', { exact: true }).waitFor();
    check(`${width} 空输入不请求，并给出输入提示`, calls.length === 0);
    await name.fill('测试企业有限公司');
    await start.getByRole('button', { name: '股东股权', exact: true }).click();
    check(`${width} 切换资料类型不查询`, calls.length === 0);
    await start.getByRole('button', { name: '企业概况', exact: true }).click();
    await query.click();
    await start.locator('.wy-business-source-card').first().waitFor();
    check(`${width} 一次明确点击调用直查而非普通模型任务`, calls.length === 1 && calls[0].company === '测试企业有限公司'
      && calls[0].section === 'basic' && calls[0].source === 'public' && mode.runner.list().length === 0);
    check(`${width} 公开来源与待核实卡真实展示，HTML仅作文字`, (await start.locator('.wy-business-results').textContent()).includes('未核实原文')
      && (await start.locator('.wy-business-results').textContent()).includes('待核实的母公司资料') && await start.locator('.wy-business-results img').count() === 0);
    await start.getByRole('button', { name: '继续分析', exact: true }).click();
    check(`${width} 继续分析只填草稿并带来源，不自动发送`, (await page.locator('#prompt').inputValue()).includes('https://company.example.com/about')
      && await page.locator('#transcript .msg').count() === 0 && mode.runner.list().length === 0);
    const countBeforeMode = calls.length;
    await start.getByRole('tab', { name: '找招标', exact: true }).click();
    await start.locator('[data-business-tenders]').waitFor({ state: 'visible' });
    await start.getByRole('tab', { name: '查企业', exact: true }).click();
    check(`${width} 两主入口切换不重复请求企业资料且保留输入`, calls.length === countBeforeMode && await name.inputValue() === '测试企业有限公司');
    fixture = 'qibook';
    await start.locator('[data-field="company_source"] select').selectOption('企百科（需配置，可能计费）');
    await start.getByRole('button', { name: '股东股权', exact: true }).click();
    check(`${width} 显式选择企百科显示费用说明，选择本身不请求`, (await start.locator('.wy-business-source-note').textContent()).includes('可能产生服务费用') && calls.length === countBeforeMode);
    await query.click();
    await start.getByText('测试股东（夹具）', { exact: true }).waitFor();
    check(`${width} 企百科字段卡按真实回执渲染，不显示额外密钥`, calls.at(-1).source === 'qibook' && calls.at(-1).section === 'shareholders'
      && (await start.locator('.wy-business-results').textContent()).includes('30%') && !(await start.textContent()).includes('never-render-this-key'));
    await start.locator('[data-field="company_source"] select').selectOption('公开来源');
    fixture = 'empty'; await query.click();
    await start.getByText(/这不代表企业不存在/).waitFor();
    check(`${width} 空回执显示资料不足，不保留上次股东结果冒充成功`, await start.locator('.wy-business-data-card').count() === 0 && !(await start.textContent()).includes('测试股东（夹具）'));
    fixture = 'error'; await query.click();
    await start.getByText(/查询未完成：.*查询来源暂时不可用/).waitFor();
    check(`${width} 错误保留输入，可直接重试`, await name.inputValue() === '测试企业有限公司' && await query.isEnabled());
    fixture = 'pending'; await query.click();
    await start.getByRole('button', { name: '停止查询', exact: true }).waitFor();
    check(`${width} 查询中防重复提交，停止入口可见`, !(await query.isEnabled()));
    await start.getByRole('button', { name: '停止查询', exact: true }).click();
    await start.getByText('已停止查询，输入内容已保留。', { exact: true }).waitFor();
    for (const route of pending.splice(0)) await route.fulfill({ contentType: 'application/json', body: JSON.stringify(publicReceipt('迟到的错误企业')) }).catch(() => {});
    check(`${width} 停止后的迟到结果不能覆盖页面`, !(await start.textContent()).includes('迟到的错误企业') && await query.isEnabled());
    await page.evaluate(() => window.__jarvis.agents.renderStart());
    check(`${width} 重绘仍保留公司名称和查询类型`, await name.inputValue() === '测试企业有限公司'
      && await start.getByRole('button', { name: '股东股权', exact: true }).getAttribute('aria-pressed') === 'true');
    await start.locator('.wy-business-advanced > summary').click();
    for (const label of ['找招标', '查企业', '读公告', '跟踪项目']) await start.getByRole('button', { name: new RegExp('^' + label) }).click();
    check(`${width} 四个旧快捷方式仍只填草稿`, (await page.locator('#prompt').inputValue()).length > 8 && mode.runner.list().length === 0);
    await start.locator('.wy-business-advanced > summary').click();
    await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#transcript').scrollTop = 0; });
    check(`${width} 简洁界面在日夜大字下无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && document.querySelector('.wy-agent-start').scrollWidth <= document.querySelector('#transcript').clientWidth));
    check(`${width} 主查询与四类选择满足44像素触控`, await start.locator('.wy-business-tabs button,.wy-business-section-choices button,.wy-business-query-submit').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 44)));
    await page.screenshot({ path: `${out}/company-${width}-${theme}${zoom ? '-large' : ''}.png`, fullPage: true });
    const nextRequest = page.waitForRequest('**/api/server/company-query');
    await query.click();
    await nextRequest;
    await start.getByRole('button', { name: '停止查询', exact: true }).waitFor();
    await page.evaluate(async () => {
      const app = window.__jarvis; await app.agents.start(await app.agents.profileOf('health-advisor'));
    });
    await page.waitForSelector('.wy-agent-start[data-agent="health-advisor"]');
    for (const route of pending.splice(0)) await route.fulfill({ contentType: 'application/json', body: JSON.stringify(publicReceipt('其他会话的迟到企业')) }).catch(() => {});
    check(`${width} 切换智能体会话后撤销查询，不把迟到企业资料写入新会话`, await page.locator('.wy-business-results').count() === 0
      && !(await page.locator('#transcript').textContent()).includes('其他会话的迟到企业') && mode.runner.list().length === 0);
    check(`${width} 无页面异常`, errors.length === 0);
    await context.close();
  }
} finally {
  await browser?.close(); await mode.tenders.stop(); await mode.runner.settled();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  useBackend(null); await rm(dir, { recursive: true, force: true });
  await writeFile(out + '/results.json', JSON.stringify(results, null, 2));
}
console.log(`通过 ${results.length} 项`);
