import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

async function difference(a, b) {
  const images = await Promise.all([a, b].map(bytes => loadImage(bytes)));
  const {width, height} = images[0];
  const ctx = createCanvas(width, height).getContext('2d');
  const pixels = images.map(image => {
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  });
  let changed = 0;
  for (let i = 0; i < pixels[0].length; i += 4) {
    if ([0,1,2].some(c => Math.abs(pixels[0][i+c] - pixels[1][i+c]) > 16)) changed++;
  }
  return changed / (width * height);
}

// 17:50 离开桌前，端杯时退出，18:09 回来吃晚饭。曾经端杯层和晚饭人物会同时留在屏幕里。
export async function checkDinnerAfterAway({page, room, scene, mobile, enter, dinnerTime, shot}) {
  await room.locator('[data-room-action=menu]').click();
  await room.locator('[data-room-action=coffee]').click();
  await scene.locator('.ws-nest-coffee').waitFor();
  await page.clock.fastForward(8500);
  if (mobile) await room.locator('.mobile-studio-back').click();
  else await page.locator('.wb-tabs').getByRole('button', {name:'对话', exact:true}).click();
  await page.clock.setSystemTime(dinnerTime);
  await enter();
  await room.locator('.ws-scene[data-nest-pose="eat"]:not([data-sofa-walk]) .ws-life-pose').waitFor();
  await shot('晚饭只有一位未央');
  const floor = await scene.locator('.ws-floorplan').boundingBox();
  const desk = mobile ? [.66,.36,.24,.11] : [.57,.34,.16,.16];
  const seat = mobile ? [.4,.48,.26,.15] : [.56,.54,.18,.26];
  const clip = ([x,y,w,h]) => page.screenshot({clip:{
    x: Math.round(floor.x+x*floor.width), y: Math.round(floor.y+y*floor.height),
    width: Math.round(w*floor.width), height: Math.round(h*floor.height)
  }});
  const hadDesk = await clip(desk), hadSeat = await clip(seat);
  const blank = await page.addStyleTag({content:'.ws-scene[data-nest-pose="eat"] :is(.ws-nest-coffee,.ws-life-actor,.ws-nest-portrait-actor){visibility:hidden!important}'});
  try {
    const deskDiff = await difference(hadDesk, await clip(desk));
    const seatDiff = await difference(hadSeat, await clip(seat));
    assert(deskDiff < .008 && seatDiff > .06,
      '书桌处应为空椅，只有前景有吃饭的人物像素 ' + JSON.stringify({deskDiff, seatDiff}));
  } finally { await blank.evaluate(el => el.remove()); }
  if (mobile) await checkHorizontalSleep(page, room, scene);
}

async function checkHorizontalSleep(page, room, scene) {
  const size = page.viewportSize();
  const safe = await page.evaluate(() => document.documentElement.classList.contains('safe-render'));
  await page.setViewportSize({width:size.height, height:size.width});
  await page.evaluate(() => document.documentElement.classList.add('safe-render'));
  try {
    await room.locator('[data-room-action=menu]').click();
    await room.locator('[data-room-action=sleep]').click();
    await room.locator('.ws-scene[data-nest-layout=landscape][data-nest-pose=sleep] .ws-nest-idle-detail').waitFor();
    assert.equal(await scene.locator('.ws-life-actor').isVisible(), false, '兼容显示的横屏保留前排睡姿，不额外绘制通用人物');
    assert.equal(await scene.locator('.ws-nest-seat').isVisible(), true, '靠桌的座位应保持空置');
    await room.locator('[data-room-action=menu]').click();
    await room.locator('[data-room-action=auto]').click();
  } finally {
    await page.evaluate(safe => document.documentElement.classList.toggle('safe-render', safe), safe);
    await page.setViewportSize(size);
  }
}
