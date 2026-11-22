import assert from 'node:assert/strict';

// 走正式云会话导入、最近对话和分页按钮。每条放不同的正文，检查翻页确实读到了另一段历史。
export async function checkNestHistory(page, client) {
  const now = Date.now();
  const session = {
    id: 'qa-nest-reading', title: '小窝旧对话翻页验收', titleSet: true, updatedAt: now,
    messages: Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: '小窝手记第 ' + (i + 1) + ' 条', ts: now - 80000 + i * 1000
    }))
  };
  assert.equal((await client.importSession(session)).imported, true);
  await page.reload();
  await page.locator('.wb-history-list').getByRole('button', { name: session.title }).click();
  const tabs = page.locator('.wb-tabs');
  await tabs.getByRole('button', { name: '工作台', exact: true }).click();
  const chat = page.locator('.wb-desk-chat');
  const prompt = chat.locator('#prompt');
  const transcript = chat.locator('#transcript');
  const first = transcript.getByText(session.messages[0].content, { exact: true });
  const last = transcript.getByText(session.messages.at(-1).content, { exact: true });
  await last.waitFor();
  assert.equal(await first.count(), 0, '进入长会话只挂载最近的一页');
  assert.equal(await transcript.locator('.wy-history-pages:visible').count(), 0, '缩略消息为输入留出空间');
  await chat.getByRole('button', { name: '展开对话' }).click();
  await transcript.getByRole('button', { name: /查看更早的对话/ }).click();
  await first.waitFor();
  assert.equal(await last.count(), 0);
  await transcript.getByRole('button', { name: '回到最近对话' }).last().click();
  await last.waitFor();
  assert.equal(await first.count(), 0);
  const draft = '先把本周的手记留在这里';
  await prompt.fill(draft);
  await prompt.evaluate(el => el.setSelectionRange(2, 6));
  await prompt.press('Escape');
  await chat.getByRole('button', { name: '展开对话' }).waitFor();
  await tabs.getByRole('button', { name: '对话', exact: true }).click();
  await tabs.getByRole('button', { name: '工作台', exact: true }).click();
  assert.equal(await prompt.inputValue(), draft);
  assert.deepEqual(await prompt.evaluate(el => [el.selectionStart, el.selectionEnd]), [2, 6], '回到小窝保留编辑位置');
  assert.equal(await page.locator('#prompt').count(), 1);
  await last.waitFor();
  assert.equal((await client.getSession(session.id)).messages.length, session.messages.length);
}
