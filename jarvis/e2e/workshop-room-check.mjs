import assert from 'node:assert/strict';
import path from 'node:path';

// 从实际聊天和房间控件操作，在同一个页面核对时钟、灯与角色，不向模型发请求。
export async function checkWorkshopRoom({ page, enter, send, output }) {
  const room = page.locator('.work-studio:visible');
  const scene = room.locator('.ws-scene');
  const when = activity => room.locator(`.ws-scene[data-life-activity="${activity}"]`).waitFor();
  const choose = async action => {
    await room.locator('[data-room-action="menu"]').click();
    await room.locator(`[data-room-action="${action}"]`).click();
    await when(action);
  };
  await page.clock.setFixedTime(new Date('2026-11-20T12:10:00+08:00'));
  await enter(page);
  await when('eat');
  await send(page, '未央，你在干嘛？');
  await page.locator('#transcript .msg.agent').filter({ hasText: '午饭' }).waitFor();
  await send(page, '请打开工作台的台灯');
  await room.locator('.ws-scene[data-lamp="on"]').waitFor();
  await room.locator('[data-room-action="light"]').click();
  await room.locator('.ws-scene[data-lamp="off"]').waitFor();
  await send(page, '去泡杯咖啡吧');
  await when('coffee');
  await page.screenshot({ path: path.join(output, 'pc-room-coffee.png') });
  for (const action of ['tv', 'think', 'rest', 'shred']) await choose(action);
  assert.equal(await room.locator('[data-entry-id]').filter({ hasText: '移入回收站' }).count(), 0, '桌面废纸没有产生文件变更');
  // 记录真正启动的 Web Audio 节点，不替换合成器；普通自动作息不会主动播放。
  await page.evaluate(() => {
    window.playedWorkshopNotes = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function(...args) {
      window.playedWorkshopNotes++;
      return start.apply(this, args);
    };
  });
  await choose('sing');
  assert.ok(await page.evaluate(() => window.playedWorkshopNotes >= 2), '点唱启动了真实音高序列');
  await page.locator('.wb-tabs button').first().click();
  await page.clock.setFixedTime(new Date('2026-11-21T02:10:00+08:00'));
  await enter(page);
  await when('sleep');
  await send(page, '你现在在做什么？');
  await page.locator('#transcript .msg.agent').filter({ hasText: '睡' }).waitFor();
  await page.screenshot({ path: path.join(output, 'pc-room-night.png') });
  assert.equal(await scene.getAttribute('data-lamp'), 'off');
}
