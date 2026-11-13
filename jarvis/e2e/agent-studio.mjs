/** 正式构建第二版：真实表单、原上传入口、个人配置持久化；所有外部请求阻断，不调用模型。 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const out = process.argv[2] || '/tmp/weiyang-agent-studio';
await mkdir(out, { recursive: true });
const results = [];
const check = (label, ok) => { results.push({ label, ok }); console.log(`${ok ? '✓' : '✗'} ${label}`); };
const root = path.resolve('.');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const p = path.resolve(root, '.' + (pathname.startsWith('/assets/') ? '/dist' + pathname : pathname));
    if (!p.startsWith(root + path.sep)) throw new Error('path');
    const bytes = await readFile(p.endsWith('/') ? p + 'index.html' : p);
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const ids = ['ppt-maker', 'gongwen-writer', 'poster-designer', 'health-advisor', 'deep-researcher', 'image-reader', 'travel-weather', 'market-quotes'];
ids.push('business-intelligence');
async function checkReadingLayout(page, id, tag, width) {
  // 走真实发送/消息渲染链路，默认内置演示模型；本测试的所有外网请求已阻断。
  await page.evaluate(() => window.__jarvis.send('这是一条用于检查阅读边距的示例消息，请简单回答。'));
  await page.waitForSelector('.msg.agent:not(.streaming)');
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('#transcript');
    const panel = root.getBoundingClientRect();
    const answer = root.querySelector('.msg.agent .body').getBoundingClientRect();
    const user = root.querySelector('.msg.user').getBoundingClientRect();
    const padding = getComputedStyle(root);
    return {
      left: parseFloat(padding.paddingLeft), right: parseFloat(padding.paddingRight),
      answerLeft: answer.left - panel.left, answerRight: panel.right - answer.right,
      userRight: panel.right - user.right,
      introHidden: !root.querySelector('.wy-studio-start') || getComputedStyle(root.querySelector('.wy-studio-start')).display === 'none',
      noOverflow: root.scrollWidth <= root.clientWidth && document.documentElement.scrollWidth <= innerWidth
    };
  });
  const inset = width < 800 ? 20 : 12;
  check(`${tag} ${id} 发消息后起始页收起`, metrics.introHidden);
  check(`${tag} ${id} 对话区恢复阅读边距`, metrics.left >= inset && metrics.right >= inset);
  check(`${tag} ${id} 用户与回答都不贴边`, metrics.answerLeft >= inset && metrics.answerRight >= inset && metrics.userRight >= inset);
  check(`${tag} ${id} 对话无横向溢出`, metrics.noOverflow);
  if (id === 'market-quotes') await page.screenshot({ path: `${out}/reading-${tag}.png` });
}
try {
  for (const [width, theme, zoom] of [[320, 'day', false], [390, 'day', false], [412, 'night', false], [390, 'day', true], [1280, 'day', false]]) {
    const tag = `${width}-${theme}${zoom ? '-big' : ''}`;
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: width < 800 });
    await ctx.route('https://**/*', r => r.abort());
    await ctx.addInitScript(theme => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false })), theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const build = width < 800 ? 'dist-mobile' : 'dist';
    await page.goto(`${base}/${build}/index.html`);
    await page.waitForFunction(() => window.__jarvis?.agents);
    await page.evaluate(() => document.querySelector('#app-splash')?.remove());
    if (zoom) await page.addStyleTag({ content: 'html {font-size:130% !important}' });
    await page.evaluate(() => window.__jarvis.agents.openSquare());
    await page.waitForSelector('.wy-studio-square:not([hidden]) .wy-agent-card');
    check(`${tag} 真实广场9个智能体（原8项加企业招投标）和两个作品入口`, await page.locator('.wy-agent-card[data-agent]').count() === 9 && await page.locator('.wy-studio-feature').count() === 2);
    await page.screenshot({ path: `${out}/square-${tag}.png` });
    await page.evaluate(() => window.__jarvis.agents.square.close());
    for (const id of ids) {
      await page.evaluate(async id => {
        const app = window.__jarvis;
        document.querySelector('#prompt').value = '';
        await app.agents.start(await app.agents.profileOf(id));
        document.activeElement?.blur();
      }, id);
      await page.waitForSelector(`.wy-studio-start[data-agent="${id}"]`);
      check(`${tag} ${id} 无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.wy-studio-start').scrollWidth <= document.querySelector('#transcript').clientWidth));
      check(`${tag} ${id} 保留3条原推荐和上传入口`, await page.locator('.wy-agent-starter').count() === 3 && await page.locator('.wy-agent-upload').count() === 1);
      if (id === 'gongwen-writer') {
        await page.click('.wy-studio-document-types button[data-value="通知"]');
        await page.fill('[aria-label="主题"].wy-studio-text', '季度项目会议');
        await page.fill('[aria-label="内容要点"].wy-studio-text', '周五十点，研发部会议室。');
        check(`${tag} 公文文种和事实重画后保留`, await page.evaluate(() => {
          window.__jarvis.agents.renderStart();
          return document.querySelector('[data-field="kind"] select').value === '通知' && document.querySelector('[aria-label="内容要点"]').value.includes('周五十点');
        }));
      }
      if (id === 'poster-designer') {
        await page.click('[data-studio-tab="create"]');
        await page.click('.wy-studio-styles button[data-value="国风美学"]');
        await page.click('.wy-studio-ratios button[data-value="9:16"]');
        await page.fill('[aria-label="需要出现的文字"].wy-studio-text', '春日有约');
        check(`${tag} 海报风格/比例/标题重画后保留`, await page.evaluate(() => {
          window.__jarvis.agents.renderStart();
          return document.querySelector('[data-field="style"] select').value === '国风美学' && document.querySelector('[data-field="ratio"] select').value === '9:16' && document.querySelector('[aria-label="需要出现的文字"]').value === '春日有约';
        }));
        await page.click('.wy-studio-posters button >> nth=0');
        check(`${tag} 灵感只填草稿，不发送`, (await page.inputValue('#prompt')).includes('自然主题') && await page.locator('#transcript .msg').count() === 0);
        await page.screenshot({ path: `${out}/poster-create-${tag}.png` });
        await page.click('[data-studio-tab="tools"]');
        await page.click('.wy-studio-tools button[data-value="抠图（透明背景）"]');
        check(`${tag} 图片处理选项保留原图编辑要求`, await page.inputValue('[data-field="operation"] select') === '抠图（透明背景）');
        await page.screenshot({ path: `${out}/image-tools-${tag}.png` });
        await page.click('[data-studio-tab="inspiration"]');
      }
      if (id === 'image-reader') {
        await page.click('.wy-studio-tools button[data-value="保留表格"]');
        const chooser = page.waitForEvent('filechooser');
        await page.click('.wy-agent-upload');
        await chooser;
        check(`${tag} OCR复用真实文件选择入口`, await page.evaluate(() => {
          window.__jarvis.agents.renderStart();
          return document.querySelector('[data-field="format"] select').value === '保留表格';
        }));
      }
      await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#transcript').scrollTop = 0; });
      await page.screenshot({ path: `${out}/${id}-${tag}.png` });
      await checkReadingLayout(page, id, tag, width);
    }
    // 真实本地注册表保存→重开→修改→删除；不以静态成功提示代替结果。
    await page.evaluate(() => window.__jarvis.agents.openSquare());
    await page.click('.wy-studio-new');
    check(`${tag} 广场返回入口仍在隐藏编辑器之前`, await page.evaluate(() => !!document.querySelector('.wy-agents-back')?.closest('.wy-studio-square')));
    await page.fill('.wy-studio-editor [aria-label="名称"]', '我的简报助手');
    await page.fill('.wy-studio-editor [aria-label="一句话介绍"]', '核对来源，再整理简报');
    await page.fill('.wy-studio-editor textarea', '1.检索资料\n2.核对日期\n3.形成摘要');
    for (let i = 1; i <= 3; i++) await page.fill(`.wy-studio-editor [aria-label="推荐问题 ${i}"]`, `帮我整理第${i}类资讯`);
    // 现成的工作流：套用后有 3 步，删掉再自己加
    await page.selectOption('[aria-label="套用现成的工作流"]', 'qingshi');
    check(`${tag} 套用现成工作流得到 3 步`, (await page.locator('.wy-flow-step').count()) === 3 && (await page.locator('.wy-flow-step').nth(1).locator('[aria-label="做完怎么检查"]').inputValue()) === 'gongwen');
    while (await page.locator('.wy-flow-step').count()) await page.locator('.wy-flow-step').first().locator('[aria-label="删除这一步"]').click();
    // 工作流步骤：加两步，第二步交给公文写作并做公文体检
    await page.click('.wy-flow-add');
    await page.click('.wy-flow-add');
    const steps = page.locator('.wy-flow-step');
    await steps.nth(0).locator('[aria-label="步骤名称"]').fill('检索资料');
    await steps.nth(0).locator('[aria-label="这一步要做什么"]').fill('按主题检索最近一周的资料');
    await steps.nth(1).locator('[aria-label="步骤名称"]').fill('写成简报');
    await steps.nth(1).locator('[aria-label="这一步要做什么"]').fill('整理成一页简报');
    await steps.nth(1).locator('[aria-label="交给哪个智能体"]').selectOption('gongwen-writer');
    await steps.nth(1).locator('[aria-label="做完怎么检查"]').selectOption('gongwen');
    await steps.nth(1).locator('[aria-label="执行条件"]').fill('有新资料');
    check(`${tag} 工作流步骤第一步不能上移、最后一步不能下移`, await page.evaluate(() => { const b = [...document.querySelectorAll('.wy-flow-step .wy-flow-move')]; return b[0].disabled && b[4].disabled; }));
    check(`${tag} 工作流编辑区不横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await page.screenshot({ path: `${out}/personal-${tag}.png` });
    await page.click('.wy-studio-save');
    await page.waitForSelector('.wy-studio-editor[hidden]', { state: 'attached' });
    await page.click('.wy-agents-chip[data-category="mine"]');
    await page.waitForSelector('.wy-studio-personal-card');
    check(`${tag} 个人智能体真实保存到本人列表`, (await page.locator('.wy-studio-personal-card').innerText()).includes('我的简报助手'));
    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.agents);
    await page.evaluate(() => { document.querySelector('#app-splash')?.remove(); window.__jarvis.agents.openSquare(); });
    await page.click('.wy-agents-chip[data-category="mine"]');
    await page.waitForSelector('.wy-studio-personal-card');
    check(`${tag} 刷新后仍能读取个人配置`, await page.locator('.wy-studio-personal-card').count() === 1);
    await page.click('.wy-studio-edit');
    check(`${tag} 工作要求回填未丢`, (await page.inputValue('.wy-studio-editor textarea')).includes('核对日期'));
    check(`${tag} 工作流步骤保存后回填`, (await page.locator('.wy-flow-step').count()) === 2 && (await page.locator('.wy-flow-step').nth(1).locator('[aria-label="交给哪个智能体"]').inputValue()) === 'gongwen-writer' && (await page.locator('.wy-flow-step').nth(1).locator('[aria-label="做完怎么检查"]').inputValue()) === 'gongwen');
    check(`${tag} 执行条件保存后回填`, (await page.locator('.wy-flow-step').nth(1).locator('[aria-label="执行条件"]').inputValue()) === '有新资料');
    await page.fill('.wy-studio-editor [aria-label="名称"]', '修改后的简报助手');
    await page.click('.wy-studio-save');
    await page.waitForSelector('.wy-studio-editor[hidden]', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('.wy-studio-personal-card')?.textContent.includes('修改后的'));
    await page.click('.wy-studio-edit');
    await page.click('.wy-studio-remove');
    check(`${tag} 删除需要第二次确认`, await page.locator('.wy-studio-editor').isVisible());
    await page.click('.wy-studio-remove');
    await page.waitForSelector('.wy-studio-editor[hidden]', { state: 'attached' });
    await page.waitForSelector('.wy-agents-empty');
    check(`${tag} 删除后本人列表为空`, await page.locator('.wy-studio-personal-card').count() === 0);
    check(`${tag} 无页面脚本错误`, errors.length === 0);
    await ctx.close();
  }
} finally { await browser.close(); await new Promise(r => server.close(r)); }
await writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2));
console.log(`${results.filter(x => x.ok).length}/${results.length} 通过`);
if (results.some(x => !x.ok)) process.exitCode = 1;
