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
  const before = await page.locator('#transcript .msg.agent').count();
  await page.fill('#prompt', q);
  await page.press('#prompt', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout });
  await page.waitForTimeout(150);
  return page.locator('#transcript .msg.agent').last().innerText();
}

/** 本地假语音服务（OpenAI 兼容 /audio/speech）：返回一段 0.8 秒的 WAV；fail=true 时返回 500 */
function fakeTTS({ fail = false } = {}) {
  const seen = [];
  const rate = 24000;
  const n = Math.floor(rate * 0.8);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.5 * 32767 * (0.6 + 0.4 * Math.sin(i / 900))), 44 + i * 2);
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      if (fail) return res.writeHead(500, { ...cors, 'Content-Type': 'application/json' }).end('{"error":{"message":"boom"}}');
      res.writeHead(200, { ...cors, 'Content-Type': 'audio/wav' }).end(wav);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
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
  // 故意返回 500 的假语音服务会产生一条资源加载错误，不计入
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !(/status of 500/.test(m.text()) && /audio\/speech/.test(m.location().url))) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 10, null, { timeout: 30000 });
  const stats = await page.evaluate(() => { const s = window.__jarvis.stage.stats; return { form: s.form, particles: s.particles, calls: s.drawCalls, bloom: s.bloom, gl2: s.isWebGL2 }; });
  check('主视觉启动（粒子体 · 光核）', stats.form === 'core' && stats.particles >= 6000 && /光核/.test(await page.textContent('#hud-form')), JSON.stringify(stats));
  check('泛光开启时 draw calls ≤ 12', stats.bloom && stats.calls <= 12, String(stats.calls));
  await page.waitForFunction(() => window.__jarvis.gateway, null, { timeout: 5000 }).catch(() => {});
  check('识别到本机网关', await page.evaluate(() => Boolean(window.__jarvis.gateway)), await page.textContent('#gw-badge'));

  check('没有手动切换形态的按钮', (await page.locator('[data-style]').count()) === 0);
  // —— 白天 / 夜间
  const th0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#btn-theme');
  const th1 = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, stage: getComputedStyle(document.querySelector('.stage')).getPropertyValue('--text').trim() }));
  check('顶栏一键切换白天 / 夜间', th0 && th1.t !== th0, `${th0} → ${th1.t}`);
  await page.click('#btn-theme');
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await page.click('#set-theme [data-v="day"]');
  const day = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, text: getComputedStyle(document.body).color, stageText: getComputedStyle(document.querySelector('.stage')).getPropertyValue('--text').trim() }));
  check('白天界面：正文深色，舞台仍是深色显示屏（浅色字）', day.t === 'light' && day.text === 'rgb(20, 34, 48)' && day.stageText === '#d9e7f2', JSON.stringify(day));
  await page.screenshot({ path: `${OUT}/light-theme.png` });
  await page.click('#set-theme [data-v="night"]');
  check('夜间界面', await page.evaluate(() => document.documentElement.dataset.theme) === 'dark');

  // —— 欢迎页、HUD
  check('欢迎页与快捷任务', (await page.locator('.welcome .quick').count()) === 7 && /我是贾维斯/.test(await page.textContent('.welcome h1')));
  check('HUD 时钟与模型', /^\d{2}:\d{2}:\d{2}$/.test(await page.textContent('#hud-time')) && (await page.textContent('#hud-model')).length > 0);

  // —— 技能：首次启动预置常用技能；卸载后可从推荐里重装 → “/” 自动补全 → 点名使用
  await page.evaluate(() => window.__jarvis.showPanel('skills'));
  await page.waitForFunction(() => document.querySelectorAll('#skill-list .skill').length >= 16, null, { timeout: 5000 }).catch(() => {});
  check('首次启动预置 16 个常用技能', (await page.locator('#skill-list .skill').count()) === 16 && /16 \/ 16 个启用/.test(await page.textContent('#skill-count')), await page.textContent('#skill-count'));
  const wr = page.locator('#skill-list .skill', { hasText: '/weekly-report' });
  await wr.getByRole('button', { name: '卸载' }).click();
  await wr.getByRole('button', { name: '确认卸载' }).click();
  await page.waitForTimeout(200);
  await page.locator('.skill-tile', { hasText: '/weekly-report' }).locator('button').click();
  await page.waitForFunction(() => document.querySelectorAll('#skill-list .skill').length === 16, null, { timeout: 5000 }).catch(() => {});
  check('卸载后可从推荐里重新安装', (await page.locator('#skill-list .skill', { hasText: '/weekly-report' }).count()) === 1);
  await page.fill('#prompt', '/wee');
  await page.waitForTimeout(150);
  check('输入 / 弹出技能补全', await page.isVisible('#slash-menu') && /weekly-report/.test(await page.textContent('#slash-menu')));
  await page.press('#prompt', 'Enter');
  check('回车选中补全项', (await page.inputValue('#prompt')) === '/weekly-report ');
  await page.type('#prompt', '本周完成登录模块');
  const before = await page.locator('#transcript .msg.agent').count();
  await page.press('#prompt', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout: 20000 });
  const skillReply = await page.locator('#transcript .msg.agent').last().innerText();
  check('“/技能名”让智能体先读取技能说明', /使用技能/.test(skillReply) && /已加载技能「weekly-report」/.test(skillReply), skillReply.slice(0, 80));
  check('欢迎页在开始对话后收起', (await page.locator('.welcome').count()) === 0);
  await page.locator('#skill-list .skill', { hasText: '/weekly-report' }).locator('.switch').click();
  await page.waitForTimeout(200);
  check('停用技能', /15 \/ 16 个启用/.test(await page.textContent('#skill-count')));

  // —— 命令面板
  await page.keyboard.press('Control+k');
  check('Ctrl+K 打开命令面板', await page.isVisible('.palette'));
  await page.keyboard.type('设置');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('命令面板执行“打开设置”', !(await page.isVisible('.palette')) && await page.isVisible('[data-pane="settings"]'));

  // —— 光核旁的建议标注：虚线连到光核；悬停时光核看向它；点击即执行，回答后换一组
  await page.evaluate(() => window.__jarvis.interrupt());
  await page.waitForFunction(() => window.__jarvis.callouts.visible, null, { timeout: 5000 }).catch(() => {});
  const cl = await page.evaluate(() => ({ n: document.querySelectorAll('.callout:not([hidden])').length, d: [...document.querySelectorAll('.cl-line')].map((x) => x.getAttribute('d')) }));
  check('光核旁有 3 条建议，各自有虚线连到光核', cl.n === 3 && cl.d.every((d) => /^M[\d.]+,[\d.]+ L/.test(d || '')), JSON.stringify(cl.d[0]));
  await page.hover('.callout:nth-child(1)');
  await page.waitForTimeout(250);
  check('悬停建议：虚线变亮、光核看向它', await page.evaluate(() => document.querySelector('.cl-g.hot') !== null && window.__jarvis.live.glance.yaw > 3));
  await page.mouse.move(5, 500);
  const nBefore = await page.locator('#transcript .msg.agent').count();
  const target = await page.evaluate(() => window.__jarvis.callouts.items[1].prompt);
  const beforeTitles = await page.evaluate(() => window.__jarvis.callouts.items.map((x) => x.title).join(' / '));
  await page.click('.callout:nth-child(2)');
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), nBefore, { timeout: 20000 });
  check('点击建议即发送', (await page.locator('.msg.user').last().innerText()).includes(target), target);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__jarvis.callouts.items.map((x) => x.title));
  check('回答后换成新的跟进建议', after.length === 3 && after.join(' / ') !== beforeTitles, `${beforeTitles} → ${after.join(' / ')}`);

  // —— 定时任务：一句话创建；面板里立即运行，结果存成一段对话
  let schReply = await ask(page, '每个工作日早上9点帮我总结工作区里的文件');
  check('一句话创建定时任务', /已创建定时任务.*工作日 09:00/.test(schReply), schReply.slice(-80));
  await page.evaluate(() => window.__jarvis.showPanel('system'));
  await page.waitForTimeout(300);
  check('定时任务面板列出任务与下一次时间', /工作日 09:00/.test(await page.textContent('#sched-list')) && /下一次：\d/.test(await page.textContent('#sched-list')));
  await page.locator('#sched-list .sched').first().getByRole('button', { name: '立即运行' }).click();
  await page.waitForFunction(() => /⏰/.test(document.querySelector('#session-list')?.textContent || '') || document.querySelector('.msg.user')?.textContent.includes('总结工作区'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  check('立即运行：结果存为“⏰ 任务名”对话并打开', /总结工作区里的文件/.test(await page.textContent('#transcript')) && (await page.locator('#transcript .msg.agent').count()) >= 1);
  await page.evaluate(() => window.__jarvis.showPanel('system'));
  await page.click('#sched-add summary');
  await page.fill('#sched-form [name=title]', '喝水提醒');
  await page.fill('#sched-form [name=prompt]', '提醒我起来活动一下、喝杯水');
  await page.selectOption('#sched-form [name=kind]', 'interval');
  await page.fill('#sched-form [name=every]', '45');
  await page.click('#sched-form button[type=submit]');
  await page.waitForTimeout(300);
  check('表单新建定时任务（每隔 45 分钟）', /每 45 分钟/.test(await page.textContent('#sched-list')) && (await page.locator('#sched-list .sched').count()) === 2);
  await page.evaluate(() => window.__jarvis.showPanel('sessions'));
  await page.waitForTimeout(200);
  await page.click('#btn-new-session');

  // —— 智能体：写网页 → 预览
  const histBefore = await page.evaluate(() => window.__jarvis.director.history.length);
  let reply = await ask(page, '帮我写一个网页');
  const formsUsed = await page.evaluate((n) => window.__jarvis.director.history.slice(n), histBefore);
  check('粒子体按任务自动变形（写网页 → 晶格）', formsUsed.includes('lattice'), formsUsed.join(' → '));
  const sats = await page.evaluate(() => [...document.querySelectorAll('.oh-sat text')].map((t) => t.textContent));
  check('轨道 HUD：这一轮用到的工具显示为卫星节点', sats.includes('写入文件'), sats.join('、'));
  const thoughts = await page.locator('.thought-log li').allTextContents();
  check('思考流记录每一步', thoughts.some((t) => /写入文件/.test(t)) && thoughts.some((t) => /完成/.test(t)), thoughts.join(' | '));
  const tools1 = await page.locator('#transcript .msg.agent').last().locator('.tool-card .tn').allTextContents();
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
  const sources = await page.locator('#transcript .msg.agent').last().locator('.sources').textContent().catch(() => '');
  check('回答引用知识库来源', sources.includes('员工手册.txt') && /十天/.test(reply), sources);

  // —— 记忆与教训
  await ask(page, '记住我喜欢简洁的回答');
  await page.click('[data-panel="mind"]');
  await page.waitForTimeout(300);
  check('记忆写入并显示', /我喜欢简洁的回答/.test(await page.textContent('#mind-list')));
  // 同一件事的新说法取代旧的：旧版本进入“已归档”
  await ask(page, '记住我住在上海');
  reply = await ask(page, '记住我住在杭州');
  check('同一属性的新说法自动取代旧记忆', /已更新记忆：「我住在上海」→「我住在杭州」/.test(await page.locator('#transcript .msg.agent').last().locator('.tool-card pre').textContent()));
  await page.evaluate(() => window.__jarvis.showPanel('mind'));
  await page.click('[data-mtab="archived"]');
  await page.waitForTimeout(250);
  check('旧记忆在“已归档”里，可恢复', /我住在上海/.test(await page.textContent('#mind-list')) && (await page.locator('#mind-list button', { hasText: '恢复' }).count()) >= 1);
  await page.click('[data-mtab="memories"]');
  // 核心记忆：编辑后进入每轮上下文
  await page.fill('#core-human', '称呼我老王；产品经理');
  await page.click('#btn-core-save');
  await page.waitForTimeout(200);
  await page.click('[data-mtab="episodes"]');
  await page.click('[data-mtab="memories"]');
  await page.waitForTimeout(200);
  check('核心记忆保存（刷新面板后仍在）', /老王/.test(await page.inputValue('#core-human')));
  // 自动整理：离线规则从对话中抽取事实，并写对话摘要
  await ask(page, '顺便说一下，我叫小林');
  await page.evaluate(() => window.__jarvis.reflectNow({ manual: true }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__jarvis.showPanel('mind'));
  await page.click('[data-mtab="episodes"]');
  await page.waitForTimeout(250);
  check('整理对话：写下对话摘要', /我叫小林/.test(await page.textContent('#mind-list')));
  await page.click('[data-mtab="memories"]');
  await page.waitForTimeout(250);
  check('整理对话：抽取出新记忆（自动）', /用户叫小林/.test(await page.textContent('#mind-list')) && /自动/.test(await page.textContent('#mind-list')));
  const [memDl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-mem-export')]);
  const backup = JSON.parse(await (await import('node:fs')).promises.readFile(await memDl.path(), 'utf8'));
  check('导出记忆备份', backup.format === 'jarvis-memory' && backup.memories.length >= 3 && /老王/.test(backup.core.human), `${backup.memories.length} 条`);
  await ask(page, '今天心情不错');
  await page.locator('#transcript .msg.agent').last().locator('.feedback button').nth(1).click();
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
  // —— 看图：附上图片，作为 image_url 发给 OpenAI 兼容模型
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#file-input', { name: '截图.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#attach-list .has-thumb img', { timeout: 5000 }).catch(() => {});
  check('图片附件显示缩略图', (await page.locator('#attach-list .has-thumb img').count()) === 1);
  const visIdx = fake.seen.length;
  await ask(page, '这张图是什么');
  const visUser = fake.seen[visIdx]?.messages.filter((m) => m.role === 'user').at(-1);
  check('看图：图片随消息发给模型（image_url）', Array.isArray(visUser?.content) && visUser.content.some((p) => p.type === 'image_url' && /^data:image\/jpeg;base64,/.test(p.image_url.url)), JSON.stringify(visUser?.content)?.slice(0, 100));
  check('对话里显示图片缩略图', (await page.locator('.msg.user').last().locator('.msg-images img').count()) === 1);
  // —— 模型分工：闲聊用快模型（并让推理模型少想），写代码用编程模型
  await page.evaluate(() => window.__jarvis.panels.patchConfig((c) => ({ ...c, routing: { enabled: true, provider: 'custom', routes: { chat: 'fast-model', code: 'code-model' } } })));
  let rIdx = fake.seen.length;
  const chatReply = await ask(page, '你好呀');
  check('模型分工：闲聊交给快模型，并带 reasoning_effort=low', fake.seen[rIdx]?.model === 'fast-model' && fake.seen[rIdx]?.reasoning_effort === 'low', `${fake.seen[rIdx]?.model} / ${fake.seen[rIdx]?.reasoning_effort}`);
  check('回答下方标出用了哪个模型', /fast-model（日常对话）/.test(chatReply), chatReply.slice(-80));
  rIdx = fake.seen.length;
  await ask(page, '帮我写个 python 脚本');
  check('模型分工：写代码交给编程模型（不限制思考）', fake.seen[rIdx]?.model === 'code-model' && fake.seen[rIdx]?.reasoning_effort === undefined, fake.seen[rIdx]?.model);
  await page.evaluate(() => window.__jarvis.panels.patchConfig((c) => ({ ...c, routing: { ...c.routing, enabled: false } })));
  rIdx = fake.seen.length;
  await ask(page, '你好呀');
  check('关闭模型分工后用默认模型', fake.seen[rIdx]?.model === 'fake-model', fake.seen[rIdx]?.model);
  fake.server.close();
  await page.click('[data-panel="models"]');
  await page.selectOption('#llm-provider', 'mock');
  await page.click('#btn-llm-save');

  // —— 科幻声线：云端语音（假服务）→ 效果链 → 真实音量驱动光核
  check('默认声线：贾维斯；浏览器声音时效果不可用', await page.evaluate(() => {
    const on = document.querySelector('#tts-fx [aria-checked="true"]');
    return on?.value === 'jarvis' && on.disabled;
  }));
  const tts = await fakeTTS();
  await page.selectOption('#tts-engine', 'custom');
  await page.fill('#tts-url', tts.url);
  await page.press('#tts-url', 'Tab');
  await page.fill('#tts-model', 'fake-tts');
  await page.press('#tts-model', 'Tab');
  check('云端语音可选声线效果', await page.isEnabled('#tts-fx button[value="holo"]'));
  await page.click('#tts-fx button[value="holo"]');
  await page.evaluate(() => {
    window.__peak = 0;
    const tick = () => { const l = window.__jarvis.speaker.level(); if (l) window.__peak = Math.max(window.__peak, l); requestAnimationFrame(tick); };
    tick();
  });
  await ask(page, '你好');
  await page.waitForFunction(() => window.__peak > 0.05, null, { timeout: 15000 }).catch(() => {});
  check('云端语音：请求 /audio/speech 并带上回答文字', tts.seen.some((x) => x.url === '/v1/audio/speech' && x.body.model === 'fake-tts' && x.body.input.length > 0), tts.seen.map((x) => x.body.input).join(' / ').slice(0, 80));
  check('云端语音经效果链播放，光核由真实音量驱动', await page.evaluate(() => window.__peak > 0.05), `峰值 ${(await page.evaluate(() => window.__peak)).toFixed(2)}`);
  await page.waitForFunction(() => !window.__jarvis.speaker.speaking, null, { timeout: 30000 }).catch(() => {});
  tts.server.close();
  const bad = await fakeTTS({ fail: true });
  await page.fill('#tts-url', bad.url);
  await page.press('#tts-url', 'Tab');
  await ask(page, '你好');
  await page.waitForFunction(() => /语音合成失败：500 boom/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  check('语音服务出错时提示并退回浏览器声音', /语音合成失败：500 boom/.test(await page.evaluate(() => document.querySelector('#toast')?.textContent || '')));
  await page.evaluate(() => window.__jarvis.interrupt());
  bad.server.close();
  await page.selectOption('#tts-engine', 'auto');

  // —— 唤醒词：没叫名字的话被忽略；叫了名字后去掉名字再执行；窗口期内可以接着说
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await page.check('#set-wake');
  const userCount = () => page.locator('.msg.user').count();
  const n0 = await userCount();
  await page.evaluate(() => window.__jarvis.voice.onFinal('今天中午吃什么'));
  await page.waitForTimeout(400);
  check('唤醒词：没叫名字时不响应', (await userCount()) === n0);
  await page.evaluate(() => window.__jarvis.voice.onFinal('贾维斯，现在几点'));
  await page.waitForFunction((n) => document.querySelectorAll('.msg.user').length > n && !document.querySelector('#transcript .msg.agent.streaming'), n0, { timeout: 20000 });
  check('唤醒词：叫名字后执行指令（去掉名字）', (await page.locator('.msg.user').last().innerText()).includes('现在几点') && !(await page.locator('.msg.user').last().innerText()).includes('贾维斯'));
  check('唤醒后输入栏发光提示', await page.evaluate(() => new Promise((r) => setTimeout(() => r(document.body.classList.contains('awake')), 400))));
  await page.evaluate(() => window.__jarvis.voice.onFinal('帮我写一个网页'));
  await page.waitForFunction((n) => document.querySelectorAll('.msg.user').length > n + 1, n0, { timeout: 20000 }).catch(() => {});
  check('唤醒词：窗口期内不用再叫名字', (await userCount()) === n0 + 2);
  await page.evaluate(() => window.__jarvis.voice.onFinal('退下'));
  check('说“退下”结束唤醒', await page.evaluate(() => new Promise((r) => setTimeout(() => r(!document.body.classList.contains('awake')), 400))));
  await page.waitForFunction(() => !document.querySelector('#transcript .msg.agent.streaming') && !window.__jarvis.speaker.speaking, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await page.uncheck('#set-wake');
  await page.evaluate(() => window.__jarvis.interrupt());

  // —— 打断、快捷键、画质
  await page.evaluate(() => { window.__barge = window.__jarvis.send('帮我写一个网页'); });
  await page.waitForFunction(() => document.querySelector('#transcript .msg.agent.streaming .body')?.textContent.length > 2, null, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const barge = await page.evaluate(() => ({ streaming: document.querySelectorAll('#transcript .msg.agent.streaming').length, meta: [...document.querySelectorAll('#transcript .msg.agent .meta')].at(-1)?.textContent }));
  check('Esc 打断任务', barge.streaming === 0 && /已打断/.test(barge.meta), JSON.stringify(barge));
  await page.keyboard.press('Alt+Digit3');
  check('Alt+3 打开知识库', await page.isVisible('[data-pane="knowledge"]'));
  await page.keyboard.press('Alt+Digit8');
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

// ---------- 2. 多会话：自动保存、刷新后接着聊、新建 / 切换 / 搜索 / 重命名 / 删除 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  await ask(page, '现在几点');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.msg.user').length >= 1, null, { timeout: 8000 }).catch(() => {});
  check('刷新后自动接着最近的对话', /现在几点/.test(await page.textContent('#transcript')));
  await page.keyboard.press('Control+Shift+O');
  await page.waitForTimeout(300);
  check('Ctrl+Shift+O 新对话：对话区清空、显示欢迎页', (await page.locator('.msg').count()) === 0 && (await page.locator('.welcome').count()) === 1);
  await ask(page, '帮我写一个网页');
  await page.evaluate(() => window.__jarvis.showPanel('sessions'));
  await page.waitForFunction(() => document.querySelectorAll('#session-list .session').length >= 2, null, { timeout: 5000 }).catch(() => {});
  const titles = await page.locator('#session-list .session-title').allTextContents();
  check('对话列表：两段对话、以第一句话为标题', titles.includes('现在几点') && titles.includes('帮我写一个网页'), titles.join(' / '));
  await page.locator('#session-list .session', { hasText: '现在几点' }).click();
  await page.waitForTimeout(400);
  check('切换到旧对话：重放历史消息', /现在几点/.test(await page.textContent('#transcript')) && !/帮我写一个网页/.test(await page.textContent('#transcript')));
  await page.fill('#session-search', '网页');
  await page.waitForTimeout(400);
  check('搜索对话内容', (await page.locator('#session-list .session').count()) === 1 && /帮我写一个网页/.test(await page.textContent('#session-list')));
  await page.fill('#session-search', '');
  await page.waitForTimeout(400);
  const row = page.locator('#session-list .session', { hasText: '帮我写一个网页' });
  await row.hover();
  await row.getByRole('button', { name: '重命名' }).click();
  await page.fill('#session-list .mem-edit', '时钟网页');
  await page.press('#session-list .mem-edit', 'Enter');
  await page.waitForTimeout(300);
  check('重命名对话', (await page.locator('#session-list .session-title').allTextContents()).includes('时钟网页'));
  const r2 = page.locator('#session-list .session', { hasText: '时钟网页' });
  await r2.hover();
  await r2.getByRole('button', { name: '删除' }).click();
  await r2.getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(300);
  check('删除对话', (await page.locator('#session-list .session').count()) === 1);
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

// ---------- 5b. 本机模型（Ollama）：检测、一键下载、切换使用 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  await page.evaluate(() => window.__jarvis.showPanel('models'));
  await page.waitForFunction(() => !/正在检测/.test(document.querySelector('#local-status').textContent) && document.querySelector('#local-status').textContent, null, { timeout: 10000 });
  const st = await page.textContent('#local-status');
  if (!process.env.JARVIS_FAKE_OLLAMA) {
    check('本机模型：未运行时给出安装 / 启动指引', /没有检测到 Ollama|没有运行|运行中/.test(st), st);
  } else {
    check('本机模型：检测到 Ollama', /运行中/.test(st), st);
    check('本机模型：推荐清单与已装模型', (await page.locator('.lm-row').count()) >= 8 && await page.isVisible('[data-use="llama3.2:3b"]'));
    await page.click('[data-pull="qwen3:4b"]');
    await page.waitForSelector('.lm-progress', { timeout: 5000 });
    check('本机模型：下载显示进度条', true, await page.textContent('.lm-pct'));
    await page.screenshot({ path: `${OUT}/local-models.png` });
    await page.waitForFunction(() => document.querySelector('[data-use="qwen3:4b"]')?.textContent === '使用中', null, { timeout: 15000 });
    check('本机模型：下载完成后自动切换使用', (await page.inputValue('#llm-provider')) === 'ollama');
    const r = await ask(page, '你好');
    check('本机模型：经网关对话', /本机模型 qwen3:4b 收到/.test(r), r);
  }
  await ctx.close();
}

// ---------- 5c. 深度调研（内置演示 + 免密钥搜索；网页由测试拦截返回） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const fetched = [];
  await page.route('**/api/fetch?url=*', (route) => {
    const target = new URL(route.request().url()).searchParams.get('url');
    fetched.push(target);
    if (/bing\.com\/search/.test(target)) {
      const q = new URL(target).searchParams.get('q');
      const items = [1, 2, 3].map((i) => `<li class="b_algo"><h2><a href="https://site${i}.example/${encodeURIComponent(q)}">${q} 资料 ${i}</a></h2><div class="b_caption"><p>${q} 的摘要 ${i}</p></div></li>`).join('');
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<ol id="b_results">${items}</ol>` });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body><nav>菜单</nav><article><p>本机大模型可以在自己的电脑上离线运行，数据不出电脑，也不用按调用次数付费，适合处理隐私资料。</p><p>运行本机大模型时，内存和显存决定了能跑多大的模型：8G 内存适合 3B-4B 的模型，16G 内存可以跑 7B-8B 的模型。</p><p>Ollama 是常用的本机大模型运行器，一条命令就能下载模型。</p><p>来源页面：${target}</p></article></body></html>` });
  });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  const r = await ask(page, '深度调研：本机大模型', 60000);
  check('深度调研：完成并给出报告位置', /调研完成，报告在 调研\//.test(r), r.slice(0, 120));
  check('深度调研：先搜索再阅读网页', fetched.some((u) => /bing\.com/.test(u)) && fetched.some((u) => /site\d\.example/.test(u)), fetched.length);
  const card = page.locator('.tool-card').filter({ hasText: '深度调研' });
  check('深度调研：工具卡片显示进度', /搜索：.*\n.*阅读：/s.test(await card.locator('pre').textContent()));
  const md = await page.evaluate(async () => {
    const f = (await window.__jarvis.workspace.list()).find((x) => x.path.startsWith('调研/'));
    return f ? window.__jarvis.workspace.readText(f.path) : '';
  });
  check('深度调研：报告带引用与来源列表', /\[1\]/.test(md) && /## 参考来源\n1\. \[/.test(md) && /Ollama 是常用的本机大模型运行器/.test(md), md.slice(0, 80));
  await page.screenshot({ path: `${OUT}/research.png` });
  await ctx.close();
}

// ---------- 5d. 多助手分工（/团队，内置演示：规则拆步） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  const r = await ask(page, '/团队 记住我喜欢简洁的回答，然后帮我写一个网页', 60000);
  const rows = page.locator('#transcript .team-card li');
  check('团队模式：分工卡片列出每一步与角色', (await rows.count()) === 2 && /工程师/.test(await rows.nth(1).textContent()), await page.locator('#transcript .team-card').innerText().catch(() => ''));
  check('团队模式：每一步都完成', (await page.locator('#transcript .team-card li[data-st="done"]').count()) === 2);
  check('团队模式：各角色用了各自的工具', (await page.locator('#transcript .tool-card .tn').allTextContents()).join(',').match(/记住.*写入文件/) !== null);
  check('团队模式：汇总各步成果', /团队完成了 2 步/.test(r) && /团队 2 步/.test(r), r.slice(0, 100));
  await page.locator('#transcript .team-card li').nth(1).locator('summary').click();
  await page.screenshot({ path: `${OUT}/team.png` });
  await ctx.close();
}

// ---------- 5e. 跨对话：新对话里能接着上次、找到以前说过的内容 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  await ask(page, '我家装修预算 18 万，客厅想用奶油风');
  await page.keyboard.press('Control+Shift+O');
  await page.waitForFunction(() => !document.querySelector('#transcript .msg'));
  await page.waitForFunction(() => /接着上次/.test(document.querySelector('.callouts, #callouts')?.textContent ?? document.body.textContent), null, { timeout: 5000 }).catch(() => {});
  check('跨对话：新对话的建议里有“接着上次”', /接着上次：我家装修预算/.test(await page.textContent('body')));
  const r = await ask(page, '上次我们聊的装修预算是多少');
  check('跨对话：在新对话里找到以前说过的内容', /18 万/.test(r) && /找到了/.test(r), r.slice(0, 120));
  await ctx.close();
}

// ---------- 5f. 主动问好（模拟离开一小时后回来） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  const said = await page.evaluate(() => window.__jarvis.greetOnReturn({ awayMs: 3600_000, reason: 'test' }));
  check('回来时主动问好（对话里出现主动问候）', Boolean(said) && (await page.locator('#transcript .msg.agent.proactive').count()) === 1, said);
  const again = await page.evaluate(() => window.__jarvis.greetOnReturn({ awayMs: 3600_000 }));
  check('40 分钟内不重复问好', again === null);
  await ctx.close();
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
