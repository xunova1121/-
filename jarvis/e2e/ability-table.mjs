/**
 * 模型页“每项能力用哪个模型”（宽屏版；真正的 build:mobile 产物）：
 *   填了 DeepSeek、智谱、OpenAI 的 Key → 看图、向量自动排智谱，画图排 GPT；改常用、关备用、关向量能存下来
 * 用法：npm run build:mobile && node e2e/ability-table.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http'; import path from 'node:path'; import { readFile } from 'node:fs/promises'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-mobile');
const server = http.createServer(async (req, res) => { const p = new URL(req.url, 'http://x').pathname; try { const f = path.resolve(ROOT, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1))); res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); } catch { res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const CONFIG = { provider: 'deepseek', models: { deepseek: 'deepseek-v4-pro' }, keys: { deepseek: 'sk-test', zhipu: 'zp-test', openai: 'sk-o' }, baseURLs: {}, favoriteModels: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'deepseek', model: 'deepseek-v4-flash' }, { provider: 'zhipu', model: 'glm-ocr' }] };
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch(); // 宽屏（电脑、平板）用这张能力表；手机窄屏是另一套卡片界面（mobileAbilityTable，见 model-library.mjs）
const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
await ctx.addInitScript((c) => { if (window.top !== window) return; localStorage.setItem('jarvis.llm.v1', c); localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })); }, JSON.stringify(CONFIG));
const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__jarvis); await page.waitForTimeout(1200);
await page.evaluate(() => window.__jarvis.showPanel('models')); await page.waitForTimeout(800);
const dump = () => page.evaluate(() => [...document.querySelectorAll('.ml-ability')].map((r) => ({ name: r.querySelector('strong').textContent, main: r.querySelectorAll('select')[0].selectedOptions[0]?.textContent, mainOpts: r.querySelectorAll('select')[0].options.length, backup: r.querySelectorAll('select')[1].selectedOptions[0]?.textContent, now: r.querySelector('.ml-ability-now').textContent })));
const first = await dump();
const row = (rows, name) => rows.find((r) => r.name === name);
check('日常对话、思考、写代码都是 DeepSeek', ['日常对话', '深度思考 / 写作', '写代码'].every((n) => row(first, n).now.includes('deepseek-v4-pro')) && row(first, '日常对话').main.includes('deepseek-v4-pro'));
check('看图自动排智谱，出错换 OpenAI', row(first, '看图').now === '现在：智谱 GLM · glm-4.5v；出错换 OpenAI · gpt-4.1-mini', row(first, '看图').now);
check('画图自动排 GPT，出错换智谱', row(first, '画图').now === '现在：OpenAI · gpt-image-1；出错换 智谱 GLM · cogview-4', row(first, '画图').now);
check('文字识别自动用智谱 GLM-OCR', row(first, '文字识别')?.now.startsWith('现在：智谱 GLM · glm-ocr'), row(first, '文字识别')?.now);
check('记忆向量自动排智谱', row(first, '记忆向量').now.startsWith('现在：智谱 GLM · embedding-3'), row(first, '记忆向量').now);
// 看图改成 OpenAI、日常对话不用备用、向量关掉
const vision = page.getByLabel('看图 常用', { exact: true });
const opts = await vision.evaluate((s) => [...s.options].map((o) => o.textContent));
await vision.selectOption({ label: opts.find((t) => t.startsWith('OpenAI')) });
await page.waitForTimeout(600);
await page.getByLabel('记忆向量 常用', { exact: true }).selectOption('off'); await page.waitForTimeout(600);
await page.getByLabel('日常对话 备用', { exact: true }).selectOption('none'); await page.waitForTimeout(600);
const after = await dump();
const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('jarvis.llm.v1')));
check('看图改成 OpenAI：备用自动换成智谱，并存下来', row(after, '看图').now === '现在：OpenAI · gpt-4.1-mini；出错换 智谱 GLM · glm-4.5v' && saved.abilities.vision.main.provider === 'openai', row(after, '看图').now);
check('日常对话选“不用备用”：存成 null', saved.abilities.chat.backup === null && row(after, '日常对话').now.endsWith('没有备用'));
check('记忆向量选“不用”：关掉向量', saved.embedding.engine === 'off' && row(after, '记忆向量').now.includes('只按关键字'));
// 收藏的型号不按名字猜：glm-ocr 名字不像看图模型，收藏了也能在看图里选
const visionOptions = await page.getByLabel('看图 常用', { exact: true }).evaluate((s) => [...s.options].map((o) => o.textContent));
check('收藏的型号不按名字筛：看图下拉里有 glm-ocr', visionOptions.includes('智谱 GLM · glm-ocr'), visionOptions.join('、'));
// 手动填写型号：选“手动填写型号…”→ 选服务商、填型号 → 确定
await page.getByLabel('画图 备用', { exact: true }).selectOption('manual');
await page.getByLabel('画图 手动填写的服务商', { exact: true }).selectOption('zhipu');
await page.getByLabel('画图 手动填写的型号', { exact: true }).fill('cogview-4-250304');
await page.locator('.ml-ability-manual:not([hidden])').getByRole('button', { name: '确定' }).click();
await page.waitForTimeout(600);
const manualSaved = JSON.parse(await page.evaluate(() => localStorage.getItem('jarvis.llm.v1'))).abilities.image;
const imageRow = row(await dump(), '画图');
check('手动填写的型号存下来，并显示在下拉框里', manualSaved.backup?.model === 'cogview-4-250304' && manualSaved.backup.provider === 'zhipu' && imageRow.backup === '智谱 GLM · cogview-4-250304' && imageRow.now.endsWith('出错换 智谱 GLM · cogview-4-250304'), JSON.stringify(manualSaved) + ' ' + imageRow.now);
// 对话框里的模型按钮：最上面“智能”，点一个模型就固定用它，点“智能”切回来
await page.evaluate(() => window.__jarvis.showPanel?.('chat'));
await page.evaluate(() => document.getElementById('model-chip').click());
await page.waitForSelector('.ml-picker-smart');
check('对话框模型按钮：最上面是“智能”，默认选中', await page.locator('.ml-picker-smart').evaluate((b) => b.classList.contains('selected') && b.textContent.includes('智能 · 按能力表选')));
await page.locator('.ml-picker-item').filter({ hasText: 'deepseek-v4-flash' }).click();
await page.waitForFunction(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).pinModel === true);
const pinnedChip = await page.evaluate(() => document.getElementById('model-chip-text').textContent);
check('点一个模型：固定用它，输入框只显示型号', pinnedChip.includes('deepseek-v4-flash') && !pinnedChip.includes('智能'), pinnedChip);
await page.evaluate(() => document.getElementById('model-chip').click());
await page.locator('.ml-picker-smart').click();
await page.waitForFunction(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).pinModel === false);
const smartChip = await page.evaluate(() => document.getElementById('model-chip-text').textContent);
check('点“智能”切回按能力表，输入框显示“智能”', smartChip.includes('智能 · deepseek-v4-flash'), smartChip);
// 其他服务的 Key：本机也能在模型页填
await page.evaluate(() => window.__jarvis.showPanel('models'));
await page.waitForTimeout(600);
await page.locator('.ml-service-keys summary').click();
await page.getByLabel('博查搜索 Key', { exact: true }).fill('sk-bocha-local-9876');
await page.locator('.ml-service-keys').getByRole('button', { name: '保存到本机' }).click();
await page.waitForFunction(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).bochaKey === 'sk-bocha-local-9876');
check('其他服务的 Key 在模型页就能填（本机）', true);
check('宽屏不左右滑、没有页面错误', (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) && errs.length === 0, errs.join('；'));
await browser.close(); server.close();
console.log(`${results.filter(Boolean).length}/${results.length} 能力表通过`);
process.exit(results.every(Boolean) ? 0 : 1);
