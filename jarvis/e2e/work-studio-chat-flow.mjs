import assert from 'node:assert/strict';
import { checkNestControls, openTaskFloor } from './workshop-test-view.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const roomQuestion = '列出工作区文件，然后告诉我是否已核对。';
const followUp = '请用一句话总结刚才的核对结果。';

// Uses the actual mobile build, local workspace tool and composer queue. Only the model is a fixture.
export async function checkWorkshopChat({ page, base, requests, finishReply, shotDir }) {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__jarvis?.send && document.body.classList.contains('compact'));
  const sheet = page.locator('#mobile-work-studio');
  const chat = sheet.locator('.mobile-studio-chat');
  const prompt = chat.locator('#prompt');
  const reply = chat.locator('.msg.agent .body');
  const transcript = await page.locator('#transcript').elementHandle();
  const originalPrompt = await page.locator('#prompt').elementHandle();
  const sessionId = await page.evaluate(() => window.__jarvis.sessionId);
  const shot = async (name, clip) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, name), clip });
  };
  async function submit(text) {
    await prompt.fill(text);
    await chat.locator('#btn-send').click();
  }
  async function assertSharedChat() {
    assert(await chat.locator('#transcript').evaluate((node, old) => node === old, transcript));
    assert(await prompt.evaluate((node, old) => node === old, originalPrompt));
    assert.equal(await page.locator('#transcript').count(), 1);
    assert.equal(await page.locator('#inputbar').count(), 1);
    assert.equal(await page.evaluate(() => window.__jarvis.sessionId), sessionId);
  }
  async function checkVisibleLayout(landscape = false) {
    const rect = await sheet.evaluate(async el => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const bounds = sel => el.querySelector(sel).getBoundingClientRect().toJSON();
      const actor = el.querySelector('.ws-actor');
      const box = actor.getBoundingClientRect();
      const visibleAt = (x, y, selector) => Boolean(document.elementFromPoint(x, y)?.closest(selector));
      const prompt = bounds('#prompt');
      const transcript = bounds('#transcript');
      return {
        actor: box.toJSON(), scene: bounds('.ws-scene'), prompt, transcript, chat: bounds('.mobile-studio-chat'),
        width: innerWidth, height: visualViewport.height, actorVisible: getComputedStyle(actor).visibility === 'visible',
        stageAtActor: visibleAt(box.left + box.width / 2, box.top + box.height / 2, '.ws-scene'),
        historyVisible: visibleAt(transcript.left + transcript.width / 2, transcript.top + transcript.height / 2, '#transcript'),
        promptTouchable: visibleAt(prompt.left + prompt.width / 2, prompt.top + prompt.height / 2, '#inputbar')
      };
    });
    assert(rect.actorVisible && rect.actor.width > 8 && rect.stageAtActor, '真实工作角色应在屏幕内可见 ' + JSON.stringify(rect));
    assert(rect.historyVisible && rect.transcript.height >= 36, '回复区至少应能阅读一行 ' + JSON.stringify(rect));
    assert(rect.promptTouchable && rect.prompt.top >= 0 && rect.prompt.bottom <= rect.height + 1, '输入框应可见并能点击 ' + JSON.stringify(rect));
    if (landscape) assert(rect.scene.right <= rect.chat.left + 2, '横屏车间和对话应左右并排 ' + JSON.stringify(rect));
    else assert(rect.scene.bottom <= rect.prompt.top + 1, '竖屏输入时车间应该仍在输入框上方');
  }

  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: '未央工作台', exact: true }).click();
  await prompt.waitFor();
  await assertSharedChat();
  await submit(roomQuestion);
  await chat.locator('.msg.user').filter({ hasText: roomQuestion }).waitFor();
  await reply.filter({ hasText: '正在整理你的要求' }).waitFor();
  assert(requests().some(request => request.messages.some(m => m.role === 'tool' && m.tool_call_id === 'room-files')), '真实文件工具结果必须返回模型');
  await sheet.locator('.ws-row').filter({ hasText: '列出文件' }).waitFor({ state: 'attached' });
  await submit(followUp);
  const queue = chat.getByRole('region', { name: '待发送问题' });
  await queue.locator('li').filter({ hasText: followUp }).waitFor();
  assert.equal(requests().length, 2, '第一轮结束前追问仍在队列');
  assert.equal(await chat.locator('.msg.user').count(), 1);
  await prompt.fill('保留草稿');
  await checkNestControls(page, sheet);
  await queue.locator('li').filter({ hasText: followUp }).waitFor();
  await prompt.fill('');
  await openTaskFloor(sheet);
  await checkVisibleLayout();
  await shot('mobile-room-chat.png');
  await prompt.focus();
  // Android WebView can shrink only the visual viewport. Exercise the real resize/focus handler.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 480 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.body.classList.contains('wy-keyboard-open'));
  await checkVisibleLayout();
  await shot('mobile-room-chat-short.png', { x: 0, y: 0, width: 390, height: 480 });
  await page.evaluate(() => {
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
    document.activeElement.blur();
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await checkVisibleLayout(true);
  await shot('mobile-room-chat-landscape.png');
  await page.setViewportSize({ width: 390, height: 844 });

  await sheet.getByRole('button', { name: '返回对话' }).click();
  await sheet.waitFor({ state: 'hidden' });
  await page.getByRole('region', { name: '待发送问题' }).getByText(followUp).waitFor();
  await page.getByRole('button', { name: '看未央工作', exact: true }).click();
  await queue.locator('li').filter({ hasText: followUp }).waitFor();
  await assertSharedChat();
  assert.equal(requests().length, 2, '运行中切换显示不应重新开始任务');
  finishReply();
  await reply.filter({ hasText: '工作区文件已经核对。' }).waitFor();
  await chat.locator('.msg.user').filter({ hasText: followUp }).waitFor();
  await reply.nth(1).filter({ hasText: '正在整理你的要求' }).waitFor();
  assert.equal(requests().length, 3);
  const history = requests()[2].messages;
  assert(history.some(m => m.role === 'user' && m.content === roomQuestion));
  assert(history.some(m => m.role === 'assistant' && m.content?.includes('工作区文件已经核对。')));
  assert.equal(history.at(-1).content, followUp);
  finishReply();
  await reply.nth(1).filter({ hasText: '本次任务已完成。' }).waitFor();
  await page.waitForFunction(() => !document.body.classList.contains('generating'));
  await assertSharedChat();
  assert.equal(await queue.isVisible(), false);
  const stored = await page.evaluate(async id => (await window.__jarvis.sessionGet(id)).messages, sessionId);
  assert.deepEqual(stored.filter(m => m.role === 'user').map(m => m.content), [roomQuestion, followUp]);
  await prompt.fill('下次继续的草稿');
  await sheet.getByRole('button', { name: '返回对话' }).click();
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#prompt').inputValue(), '下次继续的草稿');
  assert.equal(await page.locator('#transcript > .msg').count(), 4);
  await page.getByRole('button', { name: '看未央工作', exact: true }).click();
  await prompt.waitFor();
  await assertSharedChat();
  assert.equal(await prompt.inputValue(), '下次继续的草稿');
  assert.equal(await chat.locator('#transcript > .msg').count(), 4);
  assert.equal(requests().length, 3);
  assert.deepEqual(errors, []);
  console.log('通过：手机工作台里真实发送、执行文件工具、同会话排队追问、回看和草稿保留；竖屏、短高度和横屏都能同时看小未央和输入框。');
}
