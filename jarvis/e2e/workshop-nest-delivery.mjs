import assert from 'node:assert/strict';
import { clickViewControl } from './workshop-test-view.mjs';

// 接着上一步实际写出的 Word。只通过小窝里能点到的家具找成品，并接着编辑同一份文件。
export async function checkNewsDeliveryInNest(page, room, filename, headline) {
  await clickViewControl(room, room.locator('[data-action="work-floor"]'));
  const scene = room.locator('.ws-scene[data-room-view="nest"]');
  await scene.waitFor();
  await page.getByRole('button', { name: '打开成品 ' + filename, exact: true }).waitFor();
  await scene.locator('[data-furniture="folder"]').click();
  const group = room.getByRole('group', { name: '本次任务成品' });
  await group.waitFor();
  const file = group.locator('button[data-path]').filter({ hasText: filename });
  assert.equal(await file.count(), 1, '同一份任务成品在文件夹里只列一次');
  assert.equal(await file.getAttribute('data-path'), filename, '继续修改必须引用本轮写入的工作区路径');
  await file.click();
  const preview = page.getByRole('dialog', { name: '任务成品预览' });
  await preview.getByText(headline, { exact: false }).first().waitFor();
  await preview.getByRole('button', { name: '返回小窝', exact: true }).click();
  await group.waitFor();
  await group.getByRole('button', { name: '继续修改 ' + filename, exact: true }).click();
  const prompt = page.locator('#prompt');
  assert((await prompt.inputValue()).includes(filename), '生成简报后可从原房间继续修改文件');
  assert(await prompt.evaluate(el => el === document.activeElement), '继续修改后焦点回到当前输入框');
  assert(await scene.isVisible(), '继续修改后房间仍可见');
}
