/**
 * 浏览器端到端测试（Playwright + Chromium）：npm run build && npm run server 后执行
 *   node e2e/smoke.mjs [截图输出目录]
 *
 * 覆盖：渲染与表情、智能体执行任务（写网页 + 预览、生成文档、运行代码）、知识库（TXT / PDF）、
 * 记忆与教训、OpenAI 兼容接口（本地假服务端，含流式工具调用）、打断与快捷键、画质、
 * 后台暂停、上下文恢复、减少动画、窄屏、人脸 / 语音（假设备）、隐私、Firefox 式降级。
 */
import { chromium } from 'playwright';
import http from 'node:http';

const BASE = process.env.JARVIS_URL || 'http://127.0.0.1:8787';
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};

/** 发一条消息并等这一轮结束 */
async function ask(page, q, timeout = 40000) {
  const before = await page.locator('.msg.agent').count();
  await page.fill('#prompt', q);
  await page.press('#prompt', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.msg.agent').length > n && !document.querySelector('.msg.agent.streaming'), before, { timeout });
  await page.waitForTimeout(150);
  return page.locator('.msg.agent').last().innerText();
}

/** 本地假 OpenAI 兼容服务端：第一次请求返回流式工具调用，第二次返回文本 */
function fakeOpenAI() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push(j);
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const hasResult = j.messages.some((m) => m.role === 'tool');
      if (!hasResult) {
        send({ choices: [{ delta: { content: '<emotion>专注</emotion>我来写个文件。' } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes/hel' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'lo.md","content":"# 你好\\n来自假模型"}' } }] }, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: '<emotion>愉悦</emotion>已写好 notes/hello.md。' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// ---------- 1. 主流程 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 10, null, { timeout: 30000 });
  const stats = await page.evaluate(() => { const s = window.__jarvis.stage.stats; return { style: s.style, calls: s.drawCalls, bloom: s.bloom, gl2: s.isWebGL2 }; });
  check('主视觉启动（光核）', stats.style === 'orb', JSON.stringify(stats));
  check('泛光开启时 draw calls ≤ 12', stats.bloom && stats.calls <= 12, String(stats.calls));
  await page.waitForFunction(() => window.__jarvis.gateway, null, { timeout: 5000 }).catch(() => {});
  check('识别到本机网关', await page.evaluate(() => Boolean(window.__jarvis.gateway)), await page.textContent('#gw-badge'));

  for (const s of ['holo', 'wire', 'orb']) {
    await page.click(`[data-style="${s}"]`);
    await page.waitForTimeout(300);
    const cur = await page.evaluate(() => ({ s: window.__jarvis.stage.stats.style, calls: window.__jarvis.stage.stats.drawCalls }));
    check(`形态切换：${s}`, cur.s === s && cur.calls <= 12, JSON.stringify(cur));
  }

  // —— 智能体：写网页 → 预览
  let reply = await ask(page, '帮我写一个网页');
  const tools1 = await page.locator('.msg.agent').last().locator('.tool-card .tn').allTextContents();
  check('智能体写网页：写入文件 → 打开预览', tools1.join(',') === '写入文件,打开预览', tools1.join(','));
  const frame = page.frameLocator('#viewer-body iframe');
  await page.waitForTimeout(800);
  const clock = await frame.locator('#t').textContent().catch(() => '');
  check('网页在沙箱 iframe 里运行', /\d{1,2}:\d{2}:\d{2}/.test(clock), clock);
  check('回答里没有残留表达标签', !reply.includes('<emotion>'), reply.slice(0, 60));
  await page.screenshot({ path: `${OUT}/e2e-01-webpage.png` });

  // —— 生成 Word / PPT / Excel
  for (const [q, ext] of [['生成一份Word周报', 'docx'], ['做一个PPT', 'pptx'], ['做一个Excel表格', 'xlsx']]) {
    await ask(page, q);
    const listed = await page.locator('#file-list li', { hasText: `示例.${ext}` }).count();
    check(`生成 ${ext} 并出现在工作区`, listed === 1);
  }
  await page.locator('#file-list li', { hasText: '示例.docx' }).click();
  await page.waitForFunction(() => /项目周报/.test(document.querySelector('#viewer-body')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('Word 在工作区里可预览（解析出文字）', /项目周报/.test(await page.textContent('#viewer-body')));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#btn-v-download')]);
  // 无头 Chromium 会把非 ASCII 的下载文件名替换成 “download”（桌面版 Chrome / Edge 正常保留中文名），所以这里校验内容：docx 是 ZIP，以 PK 开头
  const fs = await import('node:fs');
  const head = dl ? fs.readFileSync(await dl.path()).subarray(0, 2).toString() : '';
  check('工作区文件可下载（docx 内容完整）', head === 'PK', dl?.suggestedFilename());

  // —— 运行代码
  reply = await ask(page, '运行一段代码');
  check('沙箱运行 JavaScript', /1\.\.10 的平方/.test(reply) && /返回值：55/.test(reply), reply.slice(0, 100));

  // —— 知识库：TXT 与真实 PDF
  await page.click('[data-panel="knowledge"]');
  await page.setInputFiles('#kb-input', { name: '员工手册.txt', mimeType: 'text/plain', buffer: Buffer.from('第三章 假期\n\n年假规定：入职满一年的员工每年享有带薪年假十天。\n\n病假需提供医院证明。') });
  await page.waitForFunction(() => document.querySelectorAll('#kb-list li:not(.empty)').length >= 1, null, { timeout: 10000 });
  const pdfPage = await ctx.newPage();
  await pdfPage.setContent('<h1>Quarterly Report</h1><p>Revenue grew 23 percent this quarter.</p><p>报销流程：先在系统提交，再由部门经理审批。</p>');
  const pdf = await pdfPage.pdf({ format: 'A4' });
  await pdfPage.close();
  await page.setInputFiles('#kb-input', { name: '季度报告.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => document.querySelectorAll('#kb-list li:not(.empty)').length >= 2, null, { timeout: 20000 }).catch(() => {});
  const kbItems = await page.locator('#kb-list li .fn').allTextContents();
  check('知识库导入 TXT 与 PDF（本地解析）', kbItems.includes('员工手册.txt') && kbItems.includes('季度报告.pdf'), kbItems.join(','));
  await page.fill('#kb-query', 'Revenue');
  await page.press('#kb-query', 'Enter');
  await page.waitForTimeout(300);
  const hitsText = await page.textContent('#kb-hits');
  check('PDF 文字可检索', /23 percent/.test(hitsText), hitsText);
  reply = await ask(page, '根据知识库，年假有几天？');
  const sources = await page.locator('.msg.agent').last().locator('.sources').textContent().catch(() => '');
  check('回答引用知识库来源', sources.includes('员工手册.txt') && /十天/.test(reply), sources);

  // —— 记忆与教训
  await ask(page, '记住我喜欢简洁的回答');
  await page.click('[data-panel="mind"]');
  await page.waitForTimeout(300);
  check('记忆写入并显示', /我喜欢简洁的回答/.test(await page.textContent('#mind-list')));
  await ask(page, '今天心情不错');
  await page.locator('.msg.agent').last().locator('.feedback button').nth(1).click();
  await page.fill('.lesson-box input', '回答太长了');
  await page.press('.lesson-box input', 'Enter');
  await page.click('[data-mtab="lessons"]');
  await page.waitForTimeout(300);
  check('👎 反馈记为教训', /回答太长了/.test(await page.textContent('#mind-list')));
  const lv = await page.textContent('#mind-level');
  check('进化等级随积累增长', /XP/.test(lv) && Number(lv.match(/(\d+) XP/)[1]) > 5, lv);
  await page.screenshot({ path: `${OUT}/e2e-02-mind.png` });

  // —— 缺少密钥时引导到模型面板
  await page.click('[data-panel="models"]');
  await page.selectOption('#llm-provider', 'deepseek');
  await page.fill('#llm-key', '');
  await page.click('#btn-llm-save');
  reply = await ask(page, '你好');
  check('未填密钥时给出明确提示', /API Key/.test(reply), reply.slice(0, 60));

  // —— OpenAI 兼容接口（本地假服务端）：流式文本 + 分片工具调用 + 第二轮回传
  const fake = await fakeOpenAI();
  await page.selectOption('#llm-provider', 'custom');
  await page.fill('#llm-base', fake.url);
  await page.fill('#llm-model', 'fake-model');
  await page.fill('#llm-key', 'sk-test');
  await page.click('#btn-llm-save');
  check('模型标签更新', /fake-model/.test(await page.textContent('#model-chip-text')));
  reply = await ask(page, '写个笔记');
  const req = fake.seen[0];
  check('OpenAI 兼容：请求带工具定义与系统提示', req?.stream === true && req.tools?.some((t) => t.function.name === 'write_file') && req.messages[0].role === 'system', `${req?.tools?.length} 个工具`);
  check('OpenAI 兼容：第二轮回传 tool 结果', fake.seen[1]?.messages.some((m) => m.role === 'tool' && /已写入 notes\/hello.md/.test(m.content)));
  check('OpenAI 兼容：流式文本到达界面', /已写好/.test(reply), reply.slice(-40));
  await page.click('[data-panel="workspace"]');
  check('假模型写的文件出现在工作区', (await page.locator('#file-list li', { hasText: 'notes/hello.md' }).count()) === 1);
  fake.server.close();
  await page.click('[data-panel="models"]');
  await page.selectOption('#llm-provider', 'mock');
  await page.click('#btn-llm-save');

  // —— 打断、快捷键、画质
  await page.evaluate(() => { window.__barge = window.__jarvis.send('帮我写一个网页'); });
  await page.waitForFunction(() => document.querySelector('.msg.agent.streaming .body')?.textContent.length > 2, null, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const barge = await page.evaluate(() => ({ streaming: document.querySelectorAll('.msg.agent.streaming').length, meta: [...document.querySelectorAll('.msg.agent .meta')].at(-1)?.textContent }));
  check('Esc 打断任务', barge.streaming === 0 && /已打断/.test(barge.meta), JSON.stringify(barge));
  await page.keyboard.press('Alt+Digit2');
  check('Alt+2 打开知识库', await page.isVisible('[data-pane="knowledge"]'));
  await page.keyboard.press('Alt+Digit6');
  await page.selectOption('#set-quality', 'eco');
  await page.waitForTimeout(400);
  const eco = await page.evaluate(() => ({ bloom: window.__jarvis.stage.stats.bloom, fps: window.__jarvis.quality.fps }));
  check('省电档：关泛光、24fps', !eco.bloom && eco.fps === 24, JSON.stringify(eco));
  await page.selectOption('#set-quality', 'auto');
  await page.click('#prompt');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('/');
  check('/ 聚焦输入框', await page.evaluate(() => document.activeElement.id === 'prompt'));

  // —— 后台暂停与恢复
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const f1 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  await page.waitForTimeout(1500);
  const f2 = await page.evaluate(() => window.__jarvis.stage.stats.frames);
  check('隐藏后渲染循环停止', f1 === f2, `${f1} → ${f2}`);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(800);
  check('返回后恢复渲染', (await page.evaluate(() => window.__jarvis.stage.stats.frames)) > f2);

  // —— 上下文丢失恢复
  const restored = await page.evaluate(async () => {
    const ext = window.__jarvis.stage.renderer.getContext().getExtension('WEBGL_lose_context');
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

// ---------- 2. 对话记录跨会话保存 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.click('[data-panel="mind"]');
  await page.click('[data-mtab="history"]');
  await page.check('#set-persist');
  await ask(page, '现在几点');
  await page.reload();
  await page.evaluate(() => window.__jarvis.showPanel('mind'));
  await page.click('[data-mtab="history"]');
  await page.waitForFunction(() => /现在几点/.test(document.querySelector('#mind-list').textContent), null, { timeout: 5000 }).catch(() => {});
  check('对话记录刷新后仍在', /现在几点/.test(await page.textContent('#mind-list')));
  await ctx.close();
}

// ---------- 3. 减少动画 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.goto(BASE);
  await page.waitForTimeout(2000);
  check('reduced-motion 不加载 3D 资源', !urls.some((u) => /stage-|bust-mesh|three/.test(u)));
  await page.evaluate(() => window.__jarvis.machine.setManual('亲和'));
  await page.waitForTimeout(600);
  check('reduced-motion 仍以颜色表达', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--hue').trim())) === '35');
  await ctx.close();
}

// ---------- 4. 手机宽度 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(2500);
  check('手机宽度无横向溢出', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await page.click('[data-panel="workspace"]');
  check('手机上面板以全屏抽屉打开', await page.isVisible('[data-pane="workspace"]'));
  await page.screenshot({ path: `${OUT}/e2e-03-mobile.png` });
  await ctx.close();
}

// ---------- 5. 人脸跟随 / 直接对话（假设备） ----------
{
  const b2 = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await b2.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const outbound = [];
  await page.goto(BASE);
  await page.waitForTimeout(1500);
  page.on('request', (r) => { if (r.method() !== 'GET' || !r.url().startsWith(BASE)) outbound.push(`${r.method()} ${r.url().slice(0, 80)}`); });
  await page.click('[data-panel="settings"]');
  await page.check('#set-face');
  await page.waitForFunction(() => /跟随中|未检测到|降至/.test(document.querySelector('#face-status').textContent), null, { timeout: 30000 });
  check('人脸跟随启动（本地模型）', true, await page.textContent('#face-status'));
  await page.waitForFunction(() => document.querySelector('#face-status').textContent.includes('未检测到人脸'), null, { timeout: 45000 });
  check('无人脸时轻量提示', true);
  await page.uncheck('#set-face');
  await page.check('#set-voice');
  await page.waitForFunction(() => /已开启|按下说话/.test(document.querySelector('#voice-status').textContent), null, { timeout: 30000 });
  check('直接对话：VAD 模型加载', (await page.textContent('#voice-status')).includes('已开启'));
  await page.uncheck('#set-voice');
  const uploads = outbound.filter((x) => !/fonts\.(googleapis|gstatic)/.test(x));
  check('感知期间无数据外发', uploads.length === 0, uploads.join(' | '));
  await b2.close();
}

// ---------- 6. 不支持语音识别（模拟 Firefox） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(800);
  check('无语音识别时隐藏麦克风', await page.isHidden('#btn-mic'));
  check('文本对话仍可用', /离线演示模式/.test(await ask(page, '你好')));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
