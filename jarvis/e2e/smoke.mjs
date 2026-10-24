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
import { BUILTIN_SKILLS, MORE_BUILTIN_SKILLS } from '../src/agent/skillCatalog.js';

const SKILLS = BUILTIN_SKILLS.length + MORE_BUILTIN_SKILLS.length; // 首次启动预置的内置技能数

const BASE = process.env.JARVIS_URL || 'http://127.0.0.1:8787';
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};

/** 工作台：功能页是整页打开的（对话区隐藏），用测试接口直接打开 / 关闭 */
const openPanel = (page, name) => page.evaluate((n) => window.__jarvis.showPanel(n), name);
const closeSide = (page) => page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
/** 工作台的“对话 / 工作室”切换：粒子舞台只在工作室里显示 */
const studio = async (page, on) => { await closeSide(page); await page.click(`.wb-tabs button:nth-child(${on ? 2 : 1})`); await page.waitForTimeout(300); };

/** 发一条消息并等这一轮结束 */
async function ask(page, q, timeout = 40000) {
  const before = await page.locator('#transcript .msg.agent').count();
  if (await page.isVisible('#prompt')) {
    await page.fill('#prompt', q);
    await page.press('#prompt', 'Enter');
  } else {
    // 功能页整页打开时输入框被隐藏：直接提交，功能页保持打开（后面的检查要读面板内容）
    await page.evaluate((text) => { const p = document.querySelector('#prompt'); p.value = text; p.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#inputbar').requestSubmit(); }, q);
  }
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout });
  await page.waitForTimeout(150);
  return page.locator('#transcript .msg.agent').last().innerText();
}

/** 本地假语音服务（OpenAI 兼容 /audio/speech）：返回一段 0.8 秒的 WAV；fail=true 时返回 500 */
/** 假的“免费在线声音”：拦下本机网关的 /api/tts/edge，回一段 0.8 秒的正弦波（不真的连微软） */
async function fakeTTS(page, { fail = false } = {}) {
  const seen = [];
  const rate = 24000;
  const n = Math.floor(rate * 0.8);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.5 * 32767 * (0.6 + 0.4 * Math.sin(i / 900))), 44 + i * 2);
  await page.unroute('**/api/tts/edge').catch(() => {});
  await page.route('**/api/tts/edge', (route) => {
    seen.push({ url: new URL(route.request().url()).pathname, body: JSON.parse(route.request().postData() || '{}') });
    if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  return { seen, close: () => page.unroute('**/api/tts/edge') };
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
  // 故意让语音服务出错的那一步会有 500（见“语音服务出错时提示”）；真连不上微软时网关回 502
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !(/status of (500|502)/.test(m.text()) && /\/api\/tts\/edge/.test(m.location().url))) errors.push(m.text()); });
  await page.goto(BASE);
  // 电脑版的更新按钮（重启以更新 / 下载进度）在工作台顶栏里要能显示出来
  check('工作台：顶栏的更新按钮能显示', await page.evaluate(() => { const p = document.querySelector('#update-pill'); p.hidden = false; p.dataset.state = 'ready'; p.textContent = '重启以更新到 1.0.99'; const r = p.getBoundingClientRect(); const ok = getComputedStyle(p).display !== 'none' && r.width > 40 && r.top < 80; p.hidden = true; return ok; }));
  check('工作台：左侧导航、对话 / 工作室切换', await page.isVisible('.rail .wb-nav .wb-new') && (await page.locator('.wb-tabs button').count()) === 2);
  check('工作台：导航分组，最近对话保留独立区域',await page.evaluate(()=>{const rail=document.querySelector('.rail'),recent=document.querySelector('.wb-recent').getBoundingClientRect(),foot=document.querySelector('.wb-bottom').getBoundingClientRect();return document.querySelectorAll('.wb-nav-secondary button').length===4&&recent.height>=200&&foot.bottom<=innerHeight&&getComputedStyle(rail).overflowY==='hidden'&&getComputedStyle(document.querySelector('.wb-history-list')).overflowY==='visible';}));
  const interactionSpeech = await page.evaluate(() => { const s = window.__jarvis.speaker, enabled = s.enabled; s.enabled = false; return enabled; });
  await page.locator('.wb-mark').click();
  check('点击左上角未央，居中打开互动面板', await page.locator('.wy-companion').evaluate(d => d.open));
  await page.locator('.wy-companion').evaluate(d=>Promise.all(d.getAnimations().map(a=>a.finished.catch(()=>{}))));
  const initialPanelHeight=await page.locator('.wy-companion').evaluate(d=>d.getBoundingClientRect().height);
  await page.getByRole('button',{name:'更多表情',exact:true}).click();
  check('PC 更多表情分页展示，不拉长弹窗或出现粗滚动条',await page.locator('.wy-companion').evaluate((d,height)=>{const r=d.getBoundingClientRect(),close=d.querySelector('.wy-close').getBoundingClientRect();return !d.querySelector('.wy-extra-actions').hidden&&d.querySelector('.wy-primary-actions').hidden&&Math.abs(r.height-height)<4&&d.scrollHeight<=d.clientHeight+1&&r.top>=20&&r.bottom<=innerHeight-20&&close.top>=r.top;},initialPanelHeight),JSON.stringify(await page.locator('.wy-companion').evaluate((d,height)=>({before:height,after:d.getBoundingClientRect().height,scroll:d.scrollHeight,client:d.clientHeight,top:d.getBoundingClientRect().top,bottom:d.getBoundingClientRect().bottom}),initialPanelHeight)));
  await page.getByRole('button',{name:'常用表情',exact:true}).click();
  await page.getByRole('button', { name: '比个心', exact: true }).click();
  check('互动面板执行可爱动作', await page.locator('.wy-companion .wy-mascot').getAttribute('data-state') === 'love');
  await page.getByRole('button',{name:'切换文字输入',exact:true}).click();
  await page.locator('.wy-companion input').fill('转个圈');
  await page.locator('.wy-companion form button').click();
  check('文字动作指令能执行', await page.locator('.wy-companion .wy-mascot').getAttribute('data-state') === 'spin');
  await page.getByRole('button', { name: '关闭未央', exact: true }).click();
  check('互动面板可关闭，返回原对话', !await page.locator('.wy-companion').evaluate(d => d.open));
  for(const size of [{width:1366,height:768},{width:1024,height:600}]){
    await page.setViewportSize(size);
    check(`PC ${size.height}px 高度下最近对话不被菜单挤掉`,await page.evaluate(()=>{const recent=document.querySelector('.wb-recent').getBoundingClientRect(),foot=document.querySelector('.wb-bottom').getBoundingClientRect(),nav=document.querySelector('.wb-nav').getBoundingClientRect();return recent.height>=150&&recent.top>=nav.bottom&&foot.bottom<=innerHeight;}));
    await page.locator('.wb-mark').click();await page.getByRole('button',{name:'更多表情',exact:true}).click();
    check(`PC ${size.height}px 高度下陪伴面板操作完整可见`,await page.locator('.wy-companion').evaluate(d=>{const r=d.getBoundingClientRect(),end=d.querySelector('.wy-companion-end').getBoundingClientRect();return r.top>=20&&r.bottom<=innerHeight-20&&d.scrollHeight<=d.clientHeight+1&&end.bottom<=r.bottom-8;}));
    await page.screenshot({path:`${OUT}/pc-layout-${size.height}.png`});
    await page.getByRole('button',{name:'常用表情',exact:true}).click();await page.getByRole('button',{name:'关闭未央',exact:true}).click();
  }
  await page.setViewportSize({width:1600,height:960});
  await page.locator('.wb-mark').click();await page.locator('.wy-hologram-entry').click();
  check('PC 可进入全息陪伴，原有动作面板正常收起',await page.locator('.holo-dialog').evaluate(d=>d.open)&&!await page.locator('.wy-companion').evaluate(d=>d.open));
  await page.locator('.holo-pet').click();await page.locator('.holo-pet').click();await page.locator('.holo-pet').click();
  check('连续摸头会害羞并有短时触碰反馈',await page.locator('.holo-pet .wy-mascot').getAttribute('data-state')==='shy'&&await page.locator('.wy-hologram').evaluate(el=>el.classList.contains('holo-touched')));
  await page.locator('.holo-form input').fill('转个圈');await page.locator('.holo-form button').click();
  check('全息场景的文字动作指令直接响应',await page.locator('.holo-pet .wy-mascot').getAttribute('data-state')==='spin'&&await page.locator('.holo-message.user').last().textContent()==='转个圈');
  await page.locator('.holo-collapse').click();
  check('收起全息陪伴后回到原会话',!await page.locator('.holo-dialog').evaluate(d=>d.open)&&await page.locator('#prompt').isVisible());
  await page.evaluate(enabled => { window.__jarvis.speaker.enabled = enabled; }, interactionSpeech);
  await page.evaluate(() => {
    const v = window.__jarvis.voice;
    window.__testVoiceMethods = { enable: v.enable, disable: v.disable };
    v.enable = async () => { v.mode = 'vad'; v.onMode?.('vad'); return 'vad'; };
    v.disable = () => { v.mode = 'off'; v.onMode?.('off'); };
  });
  await page.locator('#btn-call').click();
  await page.waitForFunction(() => document.querySelector('#btn-call').getAttribute('aria-pressed') === 'true');
  check('语音按钮点击后展示通话反馈', await page.locator('#voice-call-panel').isVisible());
  check('临时语音通话不写入开机自动录音设置', await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.settings.v1')).directVoice === false));
  await page.locator('#btn-call-end').click();
  await page.waitForFunction(() => document.querySelector('#btn-call').getAttribute('aria-pressed') === 'false');
  check('结束语音后通话面板关闭', !await page.locator('#voice-call-panel').isVisible());
  await page.evaluate(() => { Object.assign(window.__jarvis.voice, window.__testVoiceMethods); delete window.__testVoiceMethods; });

  await studio(page, true);
  await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 10, null, { timeout: 30000 });
  // 显式高画质仍需覆盖泛光渲染；自动档在软件渲染器上应降至标准。
  await page.evaluate(() => { const s = document.querySelector('#set-quality'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => window.__jarvis.stage.stats.bloom, null, { timeout: 10000 });
  await page.waitForTimeout(100);
  const stats = await page.evaluate(() => { const s = window.__jarvis.stage.stats; return { form: s.form, particles: s.particles, calls: s.drawCalls, bloom: s.bloom, gl2: s.isWebGL2 }; });
  check('主视觉启动（粒子体 · 光核）', stats.form === 'core' && stats.particles >= 6000 && /光核/.test(await page.textContent('#hud-form')), JSON.stringify(stats));
  check('泛光开启时 draw calls ≤ 12', stats.bloom && stats.calls <= 12, String(stats.calls));
  await page.evaluate(() => { const s = document.querySelector('#set-quality'); s.value = 'auto'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  check('自动画质适配软件渲染器', await page.evaluate(() => { const j = window.__jarvis; return j.stage.stats.softwareRenderer ? j.quality.tier === 'standard' && !j.quality.bloom : j.quality.tier === 'high'; }));
  check('软件渲染标准档保留主体，减少装饰程序重建',await page.evaluate(()=>{const s=window.__jarvis.stage.stats;return !s.softwareRenderer||s.simpleScene===true&&s.particles>=6000;}));
  check('软件渲染限制实际像素以减少恢复负担', await page.evaluate(()=>{const s=window.__jarvis.stage,gl=s.renderer.getContext();return !s.stats.softwareRenderer || Math.max(gl.drawingBufferWidth,gl.drawingBufferHeight)<=540;}));
  await page.waitForFunction(() => window.__jarvis.gateway, null, { timeout: 5000 }).catch(() => {});
  check('识别到本机网关', await page.evaluate(() => Boolean(window.__jarvis.gateway)), await page.textContent('#gw-badge'));

  check('没有手动切换形态的按钮', (await page.locator('[data-style]').count()) === 0);
  // —— 工作台固定浅色；工作室里的粒子舞台仍是深色显示屏
  const day = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, stageBg: getComputedStyle(document.querySelector('#stage-wrap')).backgroundColor }));
  check('工作台浅色界面，工作室舞台是深色显示屏', day.bg === 'rgb(255, 255, 255)' && day.stageBg === 'rgb(7, 18, 30)', JSON.stringify(day));
  await page.screenshot({ path: `${OUT}/workbench-studio.png` });

  // —— 欢迎页、HUD
  check('HUD 时钟与模型', /^\d{2}:\d{2}:\d{2}$/.test(await page.textContent('#hud-time')) && (await page.textContent('#hud-model')).length > 0);
  await studio(page, false);
  check('首页：大标题 + 四张建议卡片', (await page.locator('.wb-landing .wb-card').count()) === 4 && /我是未央/.test(await page.textContent('.wb-landing h1')));
  await page.click('.wb-card:nth-child(1)');
  check('点建议卡片只填进输入框，不直接发送', (await page.inputValue('#prompt')).length > 5 && (await page.locator('.msg').count()) === 0);
  await page.fill('#prompt', '');
  await page.screenshot({ path: `${OUT}/workbench-home.png` });

  // —— 技能：首次启动预置常用技能；卸载后可从推荐里重装 → “/” 自动补全 → 点名使用
  await page.evaluate(() => window.__jarvis.showPanel('skills'));
  await page.waitForFunction((n) => document.querySelectorAll('#skill-list .skill').length >= n, SKILLS, { timeout: 5000 }).catch(() => {});
  check(`首次启动预置 ${SKILLS} 个常用技能`, (await page.locator('#skill-list .skill').count()) === SKILLS && (await page.textContent('#skill-count')).includes(`${SKILLS} / ${SKILLS} 个启用`), await page.textContent('#skill-count'));
  const wr = page.locator('#skill-list .skill', { hasText: '/weekly-report' });
  await wr.getByRole('button', { name: '卸载' }).click();
  await wr.getByRole('button', { name: '确认卸载' }).click();
  await page.waitForTimeout(200);
  await page.click('.wb-library-tabs button:nth-child(2)'); // “发现技能”
  await page.locator('.skill-tile', { hasText: '/weekly-report' }).locator('button').click();
  await page.click('.wb-library-tabs button:nth-child(1)'); // 回到“我的技能”
  await page.waitForFunction((n) => document.querySelectorAll('#skill-list .skill').length === n, SKILLS, { timeout: 5000 }).catch(() => {});
  check('卸载后可从推荐里重新安装', (await page.locator('#skill-list .skill', { hasText: '/weekly-report' }).count()) === 1);
  // 搜索已安装技能、多选删除
  await page.fill('.skill-search', '会议纪要');
  const shownSkills = () => page.evaluate(() => [...document.querySelectorAll('#skill-list > .skill')].filter((e) => !e.hidden).map((e) => e.dataset.name));
  check('搜索已安装技能（中文标题也能搜）', JSON.stringify(await shownSkills()) === '["meeting-minutes"]', JSON.stringify(await shownSkills()));
  await page.fill('.skill-search', '');
  await page.click('.skill-bulk button:has-text("多选")');
  for (const n of ['meeting-minutes', 'code-review']) await page.locator(`#skill-list > .skill[data-name="${n}"] .skill-pick input`).check();
  await page.click('.skill-bulk-delete');
  check('删除要再点一次确认', (await page.textContent('.skill-bulk-delete')).includes('确认删除 2 个'));
  await page.click('.skill-bulk-delete');
  await page.waitForFunction((n) => document.querySelectorAll('#skill-list > .skill').length === n, SKILLS - 2, { timeout: 5000 }).catch(() => {});
  check('多选一次删掉两个技能', (await page.locator('#skill-list > .skill').count()) === SKILLS - 2 && !(await page.isVisible('#skill-list .skill-pick')));
  await page.click('.wb-library-tabs button:nth-child(2)');
  for (const n of ['meeting-minutes', 'code-review']) await page.locator('.skill-tile', { hasText: `/${n}` }).locator('button').click();
  await page.click('.wb-library-tabs button:nth-child(1)');
  await page.waitForFunction((n) => document.querySelectorAll('#skill-list > .skill').length === n, SKILLS, { timeout: 5000 }).catch(() => {});
  await closeSide(page);
  await page.fill('#prompt', '/wee');
  await page.waitForTimeout(150);
  check('输入 / 弹出技能补全', await page.isVisible('#slash-menu') && /weekly-report/.test(await page.textContent('#slash-menu')));
  await page.press('#prompt', 'Enter');
  check('回车选中补全项', (await page.inputValue('#prompt')) === '/weekly-report ');
  await page.type('#prompt', '本周完成登录模块');
  const before = await page.locator('#transcript .msg.agent').count();
  await page.press('#prompt', 'Enter');
  const spun = await page.waitForSelector('.wb-recent .wb-chat.running .wb-run', { timeout: 8000 }).then(() => true, () => false);
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout: 20000 });
  await page.waitForTimeout(600);
  check('最近对话：回答中的那条转圈，答完停下', spun && (await page.locator('.wb-recent .wb-chat.running').count()) === 0);
  check('PC 回答只保留左侧一个表情头像，没有重复图标', await page.evaluate(() => { const m=[...document.querySelectorAll('#transcript .msg.agent')].at(-1), who=m.querySelector('.who'), avatar=who.querySelector('.wy-mascot'), name=who.querySelector('.who-name'); return getComputedStyle(m).borderLeftWidth==='0px' && m.querySelectorAll('.wy-mascot').length===1 && getComputedStyle(who,'::before').content==='none' && avatar.getBoundingClientRect().right<=name.getBoundingClientRect().left+2 && (!who.querySelector('.wy-reply-greeting') || getComputedStyle(who.querySelector('.wy-reply-greeting')).display==='none'); }));
  check('PC 左上角未央图标放大', await page.locator('.wb-brand .wb-mark').evaluate(el=>{const r=el.getBoundingClientRect();return r.width>=60 && r.height>=64;}));
  const skillReply = await page.locator('#transcript .msg.agent').last().innerText();
  check('“/技能名”让智能体先读取技能说明', /使用技能/.test(skillReply) && /已加载技能「weekly-report」/.test(skillReply), skillReply.slice(0, 80));
  check('首页在开始对话后收起', await page.evaluate(() => document.querySelector('.wb-landing').hidden));
  await openPanel(page, 'skills');
  await page.locator('#skill-list .skill', { hasText: '/weekly-report' }).locator('.switch').click();
  await page.waitForTimeout(200);
  check('停用技能', (await page.textContent('#skill-count')).includes(`${SKILLS - 1} / ${SKILLS} 个启用`));

  // —— 命令面板
  await page.keyboard.press('Control+k');
  check('Ctrl+K 打开命令面板', await page.isVisible('.palette'));
  await page.keyboard.type('设置');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('命令面板执行“打开设置”', !(await page.isVisible('.palette')) && await page.isVisible('[data-pane="settings"]'));

  // —— 光核旁的建议标注：虚线连到光核；悬停时光核看向它；点击即执行，回答后换一组
  await page.evaluate(() => window.__jarvis.interrupt());
  // 有对话后：舞台收成迷你状态条（光核还在），建议改到输入框上方；点“展开”恢复大舞台
  await page.waitForTimeout(300);
  const mini = await page.evaluate(() => ({ mini: document.body.classList.contains('stage-mini'), h: document.querySelector('#stage-wrap').getBoundingClientRect().height, chips: document.querySelectorAll('.chip-bar:not([hidden]) .chip').length }));
  check('对话视图：不显示舞台，建议在输入框上方', mini.mini && mini.h === 0 && mini.chips === 3, JSON.stringify(mini));
  await studio(page, true);
  await page.waitForTimeout(300);
  check('切到工作室：大舞台，建议回到光核旁', await page.evaluate(() => !document.body.classList.contains('stage-mini') && document.querySelector('.chip-bar').hidden));
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
  await studio(page, false); // 回到对话视图
  await page.waitForTimeout(300);

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
  await studio(page, true); // 轨道 HUD 只在工作室的舞台上画
  await page.waitForTimeout(200);
  const sats = await page.evaluate(() => [...document.querySelectorAll('.oh-sat text')].map((t) => t.textContent));
  await studio(page, false);
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
  // 对话里生成的文件：点一下在工作区打开
  await openPanel(page, 'workspace');
  await page.locator('[data-category="sheet"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#file-list li').length===1 && /示例.xlsx/.test(document.querySelector('#file-list').textContent));
  check('工作区按表格分类', (await page.locator('#file-list li').count()) === 1 && /示例.xlsx/.test(await page.textContent('#file-list')));
  await page.click('.ws-list-toggle');
  check('工作区文件列表可以收起', await page.locator('#file-list').evaluate(el=>el.hidden));
  await page.click('.ws-list-toggle');
  await page.locator('[data-category="all"]').click();
  await page.waitForFunction(()=>/示例.docx/.test(document.querySelector('#file-list').textContent));
  await closeSide(page);
  await page.locator('#transcript .file-link', { hasText: '示例.docx' }).first().click();
  await page.waitForFunction(() => /示例\.docx/.test(document.querySelector('#viewer-name')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check('对话里的文件可点击，在工作区打开', /示例\.docx/.test(await page.textContent('#viewer-name')));
  await page.locator('#file-list li', { hasText: '示例.docx' }).click();
  // Word 按真实样式排版（渲染在 Shadow DOM 里的 A4 页面）
  const docxText = () => page.evaluate(() => document.querySelector('#viewer-body .docx-view')?.shadowRoot?.querySelector('section.docx')?.textContent || '');
  await page.waitForFunction(() => /项目周报/.test(document.querySelector('#viewer-body .docx-view')?.shadowRoot?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('Word 在工作区里按真实样式预览', /项目周报/.test(await docxText()));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#btn-v-download')]);
  // 无头 Chromium 会把非 ASCII 的下载文件名替换成 “download”（桌面版 Chrome / Edge 正常保留中文名），所以这里校验内容：docx 是 ZIP，以 PK 开头
  const fs = await import('node:fs');
  const head = dl ? fs.readFileSync(await dl.path()).subarray(0, 2).toString() : '';
  check('工作区文件可下载（docx 内容完整）', head === 'PK', dl?.suggestedFilename());

  // —— 运行代码
  reply = await ask(page, '运行一段代码');
  check('沙箱运行 JavaScript', /1\.\.10 的平方/.test(reply) && /返回值：55/.test(reply), reply.slice(0, 100));

  // —— 知识库：TXT 与真实 PDF
  await openPanel(page, 'knowledge');
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
  await openPanel(page, 'mind');
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
  await closeSide(page);
  await page.locator('#transcript .msg.agent').last().locator('.feedback button').nth(1).click();
  await page.fill('.lesson-box input', '回答太长了');
  await page.press('.lesson-box input', 'Enter');
  await openPanel(page, 'mind');
  await page.click('[data-mtab="lessons"]');
  await page.waitForTimeout(300);
  check('👎 反馈记为教训', /回答太长了/.test(await page.textContent('#mind-list')));
  const lv = await page.textContent('#mind-level');
  check('进化等级随积累增长', /XP/.test(lv) && Number(lv.match(/(\d+) XP/)[1]) > 5, lv);
  await page.screenshot({ path: `${OUT}/e2e-02-mind.png` });

  // —— 缺少密钥时引导到模型面板
  await openPanel(page, 'models');
  await page.locator('#model-advanced').evaluate(element => element.open = true);
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
  await openPanel(page, 'workspace');
  check('假模型写的文件出现在工作区', (await page.locator('#file-list li', { hasText: 'notes/hello.md' }).count()) === 1);
  // —— 看图：附上图片，作为 image_url 发给 OpenAI 兼容模型
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#file-input', { name: '截图.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#attach-list .has-thumb img', { timeout: 5000 }).catch(() => {});
  check('图片附件显示缩略图', (await page.locator('#attach-list .has-thumb img').count()) === 1);
  await closeSide(page);
  await page.locator('#attach-list .image-open').click();
  await page.locator('dialog.image-preview').waitFor({state:'visible'});
  check('发送前点击附件查看图片', await page.locator('dialog.image-preview').isVisible());
  await page.getByRole('button',{name:'关闭图片预览',exact:true}).click();
  const visIdx = fake.seen.length;
  await ask(page, '这张图是什么');
  const visUser = fake.seen[visIdx]?.messages.filter((m) => m.role === 'user').at(-1);
  check('看图：图片随消息发给模型（image_url）', Array.isArray(visUser?.content) && visUser.content.some((p) => p.type === 'image_url' && /^data:image\/jpeg;base64,/.test(p.image_url.url)), JSON.stringify(visUser?.content)?.slice(0, 100));
  check('对话里显示图片缩略图', (await page.locator('.msg.user').last().locator('.msg-images img').count()) === 1);
  check('上传消息使用简短工作区回执', /已上传工作区/.test(await page.locator('.msg.user').last().textContent()) && !/已上传到工作区：/.test(await page.locator('.msg.user').last().textContent()));
  await page.locator('.msg.user').last().locator('.msg-images .image-open').click();
  await page.locator('dialog.image-preview').waitFor({state:'visible'});
  check('历史上传图片可以点开查看', await page.locator('dialog.image-preview').isVisible());
  await page.getByRole('button',{name:'关闭图片预览',exact:true}).click();
  // 追问时提到图片：之前的图片再带给模型；不提图片的闲聊不带
  const followIdx = fake.seen.length;
  await ask(page, '再看看上面那张图片');
  const followMsgs = fake.seen[followIdx]?.messages.filter((m) => m.role === 'user') ?? [];
  check('追问图片：之前发的图片重新带给模型', followMsgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')), followMsgs.length);
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
  await openPanel(page, 'models');
  await page.locator('#model-advanced').evaluate(element => element.open = true);
  await page.selectOption('#llm-provider', 'mock');
  await page.click('#btn-llm-save');

  // —— 科幻声线：云端语音（假服务）→ 效果链 → 真实音量驱动光核
  check('有本机网关、没有百炼密钥时，自动选免费在线声音', /当前使用：免费在线声音/.test(await page.textContent('#tts-note')) && (await page.locator('#tts-voice option').count()) >= 8, await page.textContent('#tts-note'));
  await page.selectOption('#tts-engine', 'browser');
  check('默认声线：温柔童声；浏览器声音时效果不可用', await page.evaluate(() => {
    const on = document.querySelector('#tts-fx [aria-checked="true"]');
    return on?.value === 'gentle' && on.disabled;
  }));
  const tts = await fakeTTS(page);
  await page.selectOption('#tts-engine', 'edge');
  check('云端语音可选声线效果', await page.isEnabled('#tts-fx button[value="holo"]'));
  await page.click('#tts-fx button[value="holo"]');
  await page.evaluate(() => {
    window.__peak = 0;
    const tick = () => { const l = window.__jarvis.speaker.level(); if (l) window.__peak = Math.max(window.__peak, l); requestAnimationFrame(tick); };
    tick();
  });
  // 打字提问默认不念（只在语音对话、说话提问时念）
  await page.waitForFunction(() => !window.__jarvis.speaker.speaking, null, { timeout: 15000 }).catch(() => {}); // 点声线效果时会试听一句
  const heard = tts.seen.length;
  await ask(page, '你好');
  await page.waitForTimeout(800);
  check('打字提问默认不朗读回答', tts.seen.length === heard, `多了 ${tts.seen.length - heard} 次语音请求`);
  // 打开“打字提问也朗读回答”后再测云端语音
  await page.evaluate(() => { const c = document.querySelector('#set-tts'); if (!c.checked) c.click(); });
  await ask(page, '你好');
  await page.waitForFunction(() => window.__peak > 0.05, null, { timeout: 15000 }).catch(() => {});
  check('云端语音：请求免费在线声音并带上回答文字', tts.seen.some((x) => x.url === '/api/tts/edge' && x.body.text?.length > 0 && x.body.voice), tts.seen.map((x) => x.body.text).join(' / ').slice(0, 80));
  check('云端语音经效果链播放，光核由真实音量驱动', await page.evaluate(() => window.__peak > 0.05), `峰值 ${(await page.evaluate(() => window.__peak)).toFixed(2)}`);
  await page.waitForFunction(() => !window.__jarvis.speaker.speaking, null, { timeout: 30000 }).catch(() => {});
  await tts.close();
  const bad = await fakeTTS(page, { fail: true });
  await ask(page, '你好');
  await page.waitForFunction(() => /语音合成失败：boom/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  check('语音服务出错时提示并退回浏览器声音', /语音合成失败：boom/.test(await page.evaluate(() => document.querySelector('#toast')?.textContent || '')));
  await page.evaluate(() => window.__jarvis.interrupt());
  await bad.close();
  await page.evaluate(() => { const c = document.querySelector('#set-tts'); if (c.checked) c.click(); });
  await page.selectOption('#tts-engine', 'auto');

  // —— 唤醒词：没叫名字的话被忽略；叫了名字后去掉名字再执行；窗口期内可以接着说
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await page.check('#set-wake');
  const userCount = () => page.locator('.msg.user').count();
  const n0 = await userCount();
  await page.evaluate(() => window.__jarvis.voice.onFinal('今天中午吃什么'));
  await page.waitForTimeout(400);
  check('唤醒词：没叫名字时不响应', (await userCount()) === n0);
  await page.evaluate(() => window.__jarvis.voice.onFinal('未央，现在几点'));
  await page.waitForFunction((n) => document.querySelectorAll('.msg.user').length > n && !document.querySelector('#transcript .msg.agent.streaming'), n0, { timeout: 20000 });
  check('唤醒词：叫名字后执行指令（去掉名字）', (await page.locator('.msg.user').last().innerText()).includes('现在几点') && !(await page.locator('.msg.user').last().innerText()).includes('未央'));
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
  await page.evaluate(() => { document.getElementById('settings-advanced').open = true; }); // 画质在“高级”里，默认收起
  await page.selectOption('#set-quality', 'eco');
  await page.waitForTimeout(400);
  const eco = await page.evaluate(() => ({ bloom: window.__jarvis.stage.stats.bloom, fps: window.__jarvis.quality.fps }));
  check('省电档：关泛光、24fps', !eco.bloom && eco.fps === 24, JSON.stringify(eco));
  await page.selectOption('#set-quality', 'auto');
  await closeSide(page);
  await page.click('#prompt');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('/');
  check('/ 聚焦输入框', await page.evaluate(() => document.activeElement.id === 'prompt'));

  // —— 后台暂停与恢复（粒子舞台在“工作室”里）
  await studio(page, true);
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
    let tEvent = 0;
    window.__jarvis.stage.renderer.domElement.addEventListener('webglcontextrestored', () => { tEvent = performance.now(); }, { once: true });
    const t0 = performance.now();
    ext.restoreContext();
    const before = window.__jarvis.stage.stats.frames;
    while (window.__jarvis.stage.stats.frames <= before + 2 && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    const end = performance.now();
    // total：从要求恢复到重新画出 3 帧；app：浏览器发出“已恢复”之后，未央自己重建、画出 3 帧用了多久
    return { total: Math.round(end - t0), app: tEvent ? Math.round(end - tEvent) : null };
  });
  const recovery = await page.evaluate(()=>({parallel:window.__jarvis.stage.stats.parallelCompile,compile:window.__jarvis.stage.stats.restoreCompileMs,event:window.__jarvis.stage.stats.restoreEventMs,draws:window.__jarvis.stage.stats.restoreDrawMs,simple:window.__jarvis.stage.stats.simpleScene,aa:window.__jarvis.stage.renderer.getContext().getContextAttributes()?.antialias}));
  // 浏览器自己恢复画布的时间随机器快慢变化很大（CI 的软件渲染要 0.4–0.6 秒），不是未央能控制的：
  // 未央自己的恢复工作严格要求 ≤ 300ms；总时间只防明显卡死（≤ 1.5 秒）
  check('WebGL 上下文丢失后恢复：未央自己 ≤ 300ms，总计 ≤ 1.5s', restored?.app !== null && restored?.app <= 300 && restored?.total <= 1500, `${JSON.stringify(restored)} · ${JSON.stringify(recovery)}`);
  check('无页面错误', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------- 滚动条完全隐藏、四条最近对话与查看更多 ----------
{
  const ctx=await browser.newContext({viewport:{width:1024,height:600},reducedMotion:'reduce'}),page=await ctx.newPage();
  await page.goto(BASE);await page.waitForFunction(()=>window.__jarvis);
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('jarvis');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const now=Date.now(),long=Array.from({length:24},(_,i)=>`第 ${i+1} 段：这里是一段用于检查滚动的完整回复，所有内容都应可以用滚轮阅读。`).join('\n\n');
    await new Promise((resolve,reject)=>{const t=db.transaction('sessions','readwrite'),store=t.objectStore('sessions');for(let i=0;i<7;i++)store.put({id:'scroll-check-'+i,title:'最近对话检查 '+i,titleSet:true,createdAt:now-1000,updatedAt:now-i,pinned:false,messages:[{role:'user',content:'滚动检查 '+i,ts:now-1000},{role:'assistant',content:long,ts:now-900}]});t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
  });
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.wb-history-list .wb-chat').length===4&&document.querySelectorAll('#transcript .msg').length===2);
  check('最近对话只显示最新四条，其余显示查看更多',await page.evaluate(()=>{const rows=[...document.querySelectorAll('.wb-history-list .wb-chat')];return rows.length===4&&rows.every((b,i)=>b.dataset.id==='scroll-check-'+i)&&!document.querySelector('.wb-recent-more').hidden&&getComputedStyle(document.querySelector('.wb-history-list')).overflowY==='visible';}));
  check('四条记录与查看更多都在侧栏内可见',await page.evaluate(()=>{const rows=[...document.querySelectorAll('.wb-history-list .wb-chat')],more=document.querySelector('.wb-recent-more').getBoundingClientRect(),footer=document.querySelector('.wb-bottom').getBoundingClientRect();return rows.at(-1).getBoundingClientRect().bottom<=more.top&&more.bottom<=footer.top;}));
  await page.locator('#transcript').hover();
  check('对话区悬停时也完全隐藏滚动条',await page.locator('#transcript').evaluate(el=>getComputedStyle(el).scrollbarWidth==='none'&&getComputedStyle(el,'::-webkit-scrollbar').display==='none'));
  await page.evaluate(()=>{const el=document.getElementById('transcript');el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});await page.mouse.wheel(0,400);await page.waitForFunction(()=>document.getElementById('transcript').scrollTop>100);
  check('隐藏滚动条后仍可使用鼠标滚轮向下阅读',await page.locator('#transcript').evaluate(el=>el.scrollTop>100));
  await page.mouse.wheel(0,-400);await page.waitForFunction(()=>document.getElementById('transcript').scrollTop<100);
  check('对话也可用鼠标滚轮向上阅读',await page.locator('#transcript').evaluate(el=>el.scrollTop<100));
  await page.locator('.wb-recent-more').click();await page.waitForFunction(()=>document.querySelectorAll('#session-list .session').length===7);
  check('查看更多打开全部七条对话，没有丢弃历史',await page.isVisible('[data-pane=sessions]')&&await page.locator('#session-list .session').count()===7);
  await page.locator('.wb-new').click();await page.waitForFunction(()=>!document.querySelector('.wb-landing').hidden);
  await page.locator('.wb-landing').hover();
  check('新建会话页悬停后也不显示滚动条',await page.locator('.wb-landing').evaluate(el=>getComputedStyle(el).scrollbarWidth==='none'&&getComputedStyle(el,'::-webkit-scrollbar').display==='none'));
  await page.mouse.wheel(0,300);await page.waitForFunction(()=>document.querySelector('.wb-landing').scrollTop>0);
  check('新建会话页溢出时仍能滚动查看完整内容',await page.locator('.wb-landing').evaluate(el=>el.scrollTop>0));
  await page.screenshot({path:`${OUT}/pc-no-scrollbars.png`});await ctx.close();
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
  check('Ctrl+Shift+O 新对话：对话区清空、显示欢迎页', (await page.locator('.msg').count()) === 0 && await page.evaluate(() => !document.querySelector('.wb-landing').hidden));
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
  await openPanel(page, 'workspace');
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
  await openPanel(page, 'settings');
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
  await closeSide(page);
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

// —— 干活时插话不打断、切换对话后任务在后台做完、回答中显示转圈和在做什么
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.waitForFunction(() => window.__jarvis?.send);
  await p.evaluate(() => { window.__jarvis.send('做一个 PPT'); });
  await p.waitForSelector('#transcript .msg.agent.streaming');
  const st = await p.$eval('#transcript .msg.agent.streaming', (el) => ({ s: el.dataset.status, bg: getComputedStyle(el, '::after').backgroundImage }));
  check('回答中末尾是转圈加“在做什么”，不是闪烁的竖线', Boolean(st.s) && /svg/.test(st.bg), st.s);
  await p.evaluate(() => { window.__jarvis.send('好了吗'); });
  await p.waitForFunction(() => [...document.querySelectorAll('#transcript .msg.agent')].some((m) => /还在做，已经/.test(m.innerText)), null, { timeout: 5000 });
  check('干活时问“好了吗”：马上回进度，正在做的任务不停', await p.locator('#transcript .msg.agent.streaming').count() === 1);
  await p.waitForFunction(() => !document.querySelector('#transcript .msg.agent.streaming'), null, { timeout: 40000 });
  const all = await p.locator('#transcript').innerText();
  check('问完进度，任务照常做完、文件照常给出（没有“已打断”）', !all.includes('已打断') && await p.locator('#transcript .file-link').count() >= 1);

  await p.evaluate(() => { window.__jarvis.send('做一个 Excel 表格'); });
  await p.waitForSelector('#transcript .msg.agent.streaming');
  const sid = await p.evaluate(() => window.__jarvis.sessionId);
  await p.evaluate(() => window.__jarvis.newSession());
  await p.waitForFunction((old) => window.__jarvis.sessionId !== old, sid, { timeout: 10000 }); // 切换时先整理旧对话的记忆，再换界面
  await p.waitForTimeout(300);
  check('切到新对话：新对话里没有别的对话正在写的回答', await p.locator('#transcript .msg.agent.streaming').count() === 0);
  await p.waitForFunction(async (id) => (await window.__jarvis.sessionGet(id))?.messages.some((m) => m.role === 'assistant' && m.files?.some((f) => /\.xlsx$/.test(f))), sid, { timeout: 40000 });
  check('原来的任务在后台做完，回答和 Excel 文件记回原来的对话', true);
  check('文件卡片没有跑到新对话里', await p.locator('#transcript .file-link').count() === 0);
  await p.evaluate((id) => window.__jarvis.openSession(id), sid);
  await p.waitForTimeout(400);
  check('切回原来的对话能看到做好的 Excel', /\.xlsx/.test(await p.locator('#transcript').innerText()));
  await ctx.close();
}


// —— 对话布局边界：长内容不能撑歪消息，头像与正文正常占位，隐藏滚动条仍能滚动
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.waitForFunction(() => window.__jarvis?.send);
  await ask(p, '你好');
  await p.evaluate(() => {
    const body = document.querySelector('#transcript .msg.agent:last-child .body');
    body.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.textContent = 'https://example.com/' + 'very-long-unbroken-content'.repeat(80);
    const code = document.createElement('pre');
    code.textContent = 'const value = "' + 'abcdef'.repeat(200) + '";';
    const wrap = document.createElement('div'); wrap.className = 'table-wrap';
    const table = document.createElement('table'), row = table.insertRow();
    for (let i = 0; i < 15; i++) { const cell = row.insertCell(); cell.textContent = '宽表格字段' + i; cell.style.whiteSpace = 'nowrap'; }
    wrap.append(table); body.append(paragraph, code, wrap);
  });
  for (const width of [900, 1280, 1920]) {
    await p.setViewportSize({ width, height: 860 });
    await p.waitForTimeout(350);
    const layout = await p.evaluate(() => {
      const el = document.querySelector('#transcript .msg.agent:last-child');
      const r = x => x.getBoundingClientRect();
      const msg = r(el), head = r(el.querySelector('.who')), mascot = r(el.querySelector('.who-mood')), name = r(el.querySelector('.who-name')), body = r(el.querySelector('.body'));
      const transcript = document.querySelector('#transcript'), t = r(transcript), composer = r(document.querySelector('#inputbar'));
      const contained = x => { const b = r(x); return b.left >= msg.left - 1 && b.right <= msg.right + 1; };
      return {
        avatar: mascot.right <= name.left + 1 && mascot.bottom <= body.top + 1 && head.bottom <= body.top + 1,
        content: [...el.querySelectorAll('.body, pre, .table-wrap')].every(contained) && transcript.scrollWidth <= transcript.clientWidth + 1,
        composer: composer.top >= t.bottom - 1 && composer.right <= innerWidth && composer.left >= 0,
        scroll: getComputedStyle(transcript).scrollbarWidth === 'none' || getComputedStyle(transcript, '::-webkit-scrollbar').display === 'none'
      };
    });
    check(width + 'px：头像不遮昵称与正文，长链接/代码/表格不撑破对话', layout.avatar && layout.content, JSON.stringify(layout));
    check(width + 'px：输入区不遮消息，滚动条隐藏', layout.composer && layout.scroll);
  }
  // 覆盖用户截图中的生成中状态：伪元素必须在正文列，工具卡不挤压状态文字。
  await p.evaluate(() => {
    const el = document.querySelector('#transcript .msg.agent:last-child');
    el.classList.add('streaming'); el.dataset.status = '正在帮你找资料…';
    const card = document.createElement('details'); card.className = 'tool-group'; card.open = true;
    const summary = document.createElement('summary'); summary.textContent = '执行步骤 第 1 步 fact_check';
    card.append(summary); el.append(card);
  });
  for (const width of [900, 1280, 1920]) {
    await p.setViewportSize({ width, height: 860 });
    const state = await p.evaluate(() => {
      const el = document.querySelector('#transcript .msg.agent:last-child'), after = getComputedStyle(el, '::after');
      const body = el.querySelector('.body').getBoundingClientRect(), card = el.querySelector('.tool-group').getBoundingClientRect();
      return { column: after.gridColumnStart, width: parseFloat(after.width), height: parseFloat(after.height), bodyWidth: body.width, aligned: Math.abs(body.left - card.left) < 2 };
    });
    check(width + 'px：生成中状态横排，工具卡与正文对齐', state.column === '2' && state.width > 200 && state.height < 50 && state.aligned, JSON.stringify(state));
  }
  const scrolls = await p.evaluate(() => {
    const t = document.querySelector('#transcript'), msg = t.querySelector('.msg.agent');
    for (let i = 0; i < 8; i++) t.append(msg.cloneNode(true));
    t.scrollTop = 0; t.scrollTop = 160;
    return t.scrollTop > 0;
  });
  check('隐藏滚动条后仍可上下滚动长对话', scrolls);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
