import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export const isPortraitNest = scene => scene.getAttribute('data-nest-layout').then(value => value === 'portrait');

async function pixels(locator) {
  const image = await loadImage(await locator.screenshot({ scale: 'css', animations: 'disabled' }));
  const ctx = createCanvas(image.width, image.height).getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

// 对照的是屏幕坐标，不是家具在可能一起平移或缩小的父容器内的相对坐标。
export async function captureFurniture(scene) {
  return scene.evaluate(el => {
    const boxes = {};
    for (const selector of ['.ws-floorplan', '.ws-nest-art', '[data-furniture=sofa]', '[data-furniture=cup]', '[data-furniture=window]', '.nest-wall-clock']) {
      const { x, y, width, height } = el.querySelector(selector).getBoundingClientRect();
      boxes[selector] = [x, y, width, height];
    }
    return { boxes, art: el.querySelector('.ws-nest-art').currentSrc };
  });
}

export async function checkFurnitureStayed(scene, before, action) {
  const after = await captureFurniture(scene);
  if (await isPortraitNest(scene)) assert.equal(after.art, before.art, action + '更换了整幅房间');
  for (const [selector, values] of Object.entries(before.boxes)) {
    const actual = after.boxes[selector];
    assert(actual.every((v, i) => Math.abs(v - values[i]) < 1), action + '改变了固定物件 ' + selector + ' ' + JSON.stringify({before: values, after: actual}));
  }
}

// 手机竖屏同一块地毯和扶手应始终出现在同一处。比较绕开人物、电视、新闻和输入框的真像素。
export async function capturePortraitFurniture(scene) {
  const image = await pixels(scene);
  const positions = await scene.evaluate(el => {
    const art = el.querySelector('.ws-nest-art').getBoundingClientRect();
    const scene = el.getBoundingClientRect();
    return { x: art.left - scene.left, y: art.top - scene.top, w: art.width, h: art.height };
  });
  const samples = [];
  for (const [x0,y0,x1,y1] of [[.86,.755,.92,.80], [.31,.80,.37,.84]]) {
    for (let y = y0; y < y1; y += .003) for (let x = x0; x < x1; x += .004) {
      const px = Math.floor(positions.x + positions.w * x), py = Math.floor(positions.y + positions.h * y);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const i = (py * image.width + px) * 4;
      samples.push([image.data[i], image.data[i+1], image.data[i+2]]);
    }
  }
  assert(samples.length > 100, '扶手、地毯应在屏幕里');
  return samples;
}

export function checkFurniturePixels(before, after, action) {
  assert.equal(after.length, before.length);
  const same = after.filter((rgb,i) => rgb.every((v,c) => Math.abs(v - before[i][c]) < 12)).length / before.length;
  assert(same > .90, action + '遮住或移动了固定沙发和地毯 ' + same.toFixed(3));
}

// 选用人物头发、猫毛的实际不透明像素：单看 DOM 中的 img 可见不能发现被播放器盖住。
export async function checkPortraitViewer(scene, device) {
  const actor = '.ws-nest-portrait-actor', cat = '.ws-nest-portrait-cat';
  const points = await scene.evaluate(async (el, selectors) => {
    const stage = el.getBoundingClientRect();
    return Promise.all(selectors.map(async ([selector, isCat]) => {
      const picture = el.querySelector(selector);
      await picture.decode();
      const box = picture.getBoundingClientRect();
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const ctx = cv.getContext('2d');
      ctx.drawImage(picture, 0, 0, 64, 64);
      const {data} = ctx.getImageData(0, 0, 64, 64);
      const points = [];
      for (let y=0; y<64; y++) for (let x=0; x<64; x++) {
        const i = (y*64+x)*4, r=data[i], g=data[i+1], b=data[i+2];
        if (data[i+3] < 205 || !(isCat ? r>g*1.22 && r>b*1.55 : b>r*1.13 && b>g*1.05)) continue;
        points.push([Math.floor(box.x-stage.x+(x+.5)*box.width/64), Math.floor(box.y-stage.y+(y+.5)*box.height/64)]);
      }
      return points;
    }));
  }, [[actor, false], [cat, true]]);
  const shown = await pixels(scene);
  const hide = await scene.page().addStyleTag({ content: `${actor}, ${cat} {visibility:hidden !important}` });
  let empty;
  try { empty = await pixels(scene); } finally { await hide.evaluate(el => el.remove()); }
  for (const [n, samples] of points.entries()) {
    assert(samples.length > 40, device + ' 的人物或橘猫图上取不到可见颜色');
    const visible = samples.filter(([x,y]) => {
      if (x < 0 || y < 0 || x >= shown.width || y >= shown.height) return false;
      const i = 4*(y*shown.width+x);
      return [0,1,2].some(c => Math.abs(shown.data[i+c]-empty.data[i+c]) > 16);
    }).length / samples.length;
    assert(visible > (n ? .56 : .72), device + (n ? ' 橘猫' : ' 未央头部') + '被遮挡 ' + visible.toFixed(3));
  }
}

// 用正常输入和发送按钮产生消息，两条气泡、历史层和键盘都只覆盖同一张房间。
export async function checkFloatingChat(page, room, scene, shot) {
  const sheet = page.locator('#mobile-work-studio');
  const before = await captureFurniture(scene);
  const viewport = await scene.boundingBox();
  assert(viewport.height >= await page.evaluate(() => innerHeight * .88), '手机的家具图应铺满整个小窝');
  const prompt = sheet.locator('#prompt');
  const text = '未央，你现在在做什么？';
  await prompt.fill(text);
  await sheet.locator('#btn-send').click();
  const user = sheet.locator('#transcript > .msg.user[data-nest-recent]').filter({hasText:text});
  const agent = sheet.locator('#transcript > .msg.agent[data-nest-recent] .body:visible').last();
  await user.waitFor();
  await agent.waitFor();
  await page.waitForFunction(() => !document.body.classList.contains('generating'));
  const userBox = await user.boundingBox(), answerBox = await agent.boundingBox();
  assert(userBox.x > answerBox.x + 4, '自己的气泡靠右，未央的回复靠左');
  assert.equal(await agent.evaluate(el => getComputedStyle(el).webkitLineClamp), '3');
  await checkFurnitureStayed(scene, before, '收到消息');
  await shot('小窝悬浮对话');
  await agent.click();
  await sheet.locator('.nest-chat-collapse').waitFor();
  assert.equal(await sheet.getAttribute('data-nest-chat'), 'history');
  await checkFurnitureStayed(scene, before, '展开完整对话');
  await sheet.locator('.nest-chat-collapse').click();
  const toggle = sheet.locator('.nest-chat-toggle');
  await toggle.click();
  assert.equal(await prompt.isVisible(), false);
  await checkFurnitureStayed(scene, before, '隐藏对话');
  await toggle.click();
  assert(await prompt.isVisible(), '房间里的聊天按钮可重新打开输入框');
  await prompt.fill('保留的草稿');
  await prompt.focus();
  try {
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', {configurable:true,value:480});
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.body.classList.contains('wy-keyboard-open'));
    await checkFurnitureStayed(scene, before, '打开输入键盘');
    const input = await prompt.boundingBox();
    assert(input && input.y + input.height <= 481, '键盘上方的输入框可见');
  } finally {
    await page.evaluate(() => {
      delete visualViewport.height;
      visualViewport.dispatchEvent(new Event('resize'));
      document.activeElement.blur();
    });
  }
  assert.equal(await prompt.inputValue(), '保留的草稿');
  await shot('小窝输入草稿');
}
