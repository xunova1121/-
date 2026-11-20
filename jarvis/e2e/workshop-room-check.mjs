import assert from 'node:assert/strict';
import path from 'node:path';
import { checkWorkshopHum } from './workshop-hum.mjs';

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
  await page.clock.setFixedTime(new Date('2026-11-20T08:30:00+08:00'));
  await enter(page);
  await when('plan');
  const desk = scene.locator('.ws-floorplan > .ws-actor .ws-sprite');
  await room.locator('.ws-scene[data-station="bench"][data-work-phase="working"][data-operation="write"]').waitFor();
  assert.match(await desk.evaluate(el => getComputedStyle(el).animationName), /ws-write-frames/);
  assert.match(await scene.locator('.ws-pen-mark').evaluate(el => getComputedStyle(el).animationName), /ws-ink-stroke/);

  // 同一房间的个人作息和真实任务记录独立。调到下午，主动按当下时间恢复作息。
  await page.clock.setFixedTime(new Date('2026-11-20T14:08:00+08:00'));
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="auto"]').click();
  await when('tidy');
  await room.locator('.ws-scene[data-station="archive"][data-work-phase="working"][data-operation="archive"]').waitFor();
  assert.match(await scene.locator('.ws-rack-folder').evaluate(el => getComputedStyle(el).animationName), /ws-unfile/);
  await page.clock.setFixedTime(new Date('2026-11-20T15:18:00+08:00'));
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="auto"]').click();
  await when('study');
  await room.locator('.ws-scene[data-station="review"][data-work-phase="working"][data-operation="type"]').waitFor();
  assert.match(await scene.locator('.ws-key-row:nth-child(2) .ws-key:nth-child(4)').evaluate(el => getComputedStyle(el).animationName), /ws-keypress/);
  assert.equal(await room.locator('[data-entry-id]').count(), 0);

  await page.clock.setFixedTime(new Date('2026-11-20T12:10:00+08:00'));
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="auto"]').click();
  await when('eat');
  await send(page, '未央，你在干嘛？');
  await page.locator('#transcript .msg.agent').filter({ hasText: '午饭' }).waitFor();
  await send(page, '请打开工作台的台灯');
  await room.locator('.ws-scene[data-lamp="on"]').waitFor();
  await room.locator('[data-room-action="light"]').click();
  await room.locator('.ws-scene[data-lamp="off"]').waitFor();
  const deskLamp = scene.getByRole('button', { name: '控制桌上的台灯' });
  await deskLamp.click();
  await room.locator('.ws-scene[data-lamp="on"]').waitFor();
  await deskLamp.press('Enter');
  await room.locator('.ws-scene[data-lamp="off"]').waitFor();
  await scene.getByRole('button', { name: '坐到沙发上休息' }).click();
  await when('rest');
  await scene.getByRole('button', { name: '去茶水桌泡咖啡' }).click();
  await when('coffee');
  await send(page, '去泡杯咖啡吧');
  await when('coffee');
  await page.screenshot({ path: path.join(output, 'pc-room-coffee.png') });
  for (const action of ['tv', 'think', 'rest', 'shred']) {
    await choose(action);
    if (action === 'tv') await room.getByRole('button', { name: '返回房间' }).click();
  }
  assert.equal(await room.locator('[data-entry-id]').filter({ hasText: '移入回收站' }).count(), 0, '桌面废纸没有产生文件变更');
  await checkWorkshopHum(page, room, choose);
  await page.clock.setFixedTime(new Date('2026-11-21T02:10:00+08:00'));
  await enter(page);
  await when('sleep');
  const quilt = scene.locator('.ws-life-pose');
  const winterSheet = await quilt.evaluate(async el => {
    const style = getComputedStyle(el);
    const image = new Image();
    image.src = style.backgroundImage.slice(5, -2);
    await image.decode();
    return [image.naturalWidth, image.naturalHeight, style.backgroundSize, style.animationName];
  });
  assert.deepEqual(winterSheet.slice(0, 3), [512, 256, '200% 100%'], '寒夜使用两帧厚被睡姿');
  assert.match(winterSheet[3], /ws-life-breath/);
  await send(page, '你现在在做什么？');
  await page.locator('#transcript .msg.agent').filter({ hasText: '睡' }).waitFor();
  await page.screenshot({ path: path.join(output, 'pc-room-night.png') });
  assert.equal(await scene.getAttribute('data-lamp'), 'off');
  // 用相同灯光设置检查实际合成到人物和家具上方的渐变，避免只改时间标签。
  const daylight = new Set();
  for (const [time, period] of [['06:40', 'dawn'], ['12:10', 'day'], ['18:20', 'dusk'], ['23:10', 'night']]) {
    await page.locator('.wb-tabs button').first().click();
    await page.clock.setFixedTime(new Date('2026-11-21T' + time + ':00+08:00'));
    await enter(page);
    await room.locator(`.ws-scene[data-life-period="${period}"][data-lamp-lit="off"]`).waitFor();
    if (period === 'dawn') assert.equal(await scene.getAttribute('data-winter-quilt'), null, '晨起收被');
    const wash = await scene.locator('.ws-room-light').evaluate(layer => {
      const ambient = getComputedStyle(layer, '::before');
      return { image: ambient.backgroundImage, opacity: Number(ambient.opacity), width: layer.getBoundingClientRect().width };
    });
    assert.ok(wash.image.includes('linear-gradient') && wash.opacity > .05 && wash.width > 100, time + ' 的环境光在车间实际可见');
    daylight.add(wash.image);
  }
  assert.equal(daylight.size, 4, '清晨、白天、黄昏和深夜各有不同的窗光');
}
