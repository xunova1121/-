import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// 家具和人物坐标都以同一张原画为准，PC 与窄屏无需分别设阈值。
async function roomBox(locator) {
  return locator.evaluate(el => {
    const box = el.getBoundingClientRect();
    const room = el.closest('.ws-floorplan').getBoundingClientRect();
    return {
      x: (box.x - room.x) / room.width, y: (box.y - room.y) / room.height,
      right: (box.right - room.x) / room.width, bottom: (box.bottom - room.y) / room.height
    };
  });
}

// 拍同一机位、同一动画帧的两张图，直接核对沙发出现时有没有盖住地毯上的猫尾。
async function checkTailInFront(scene, seat) {
  const floor = scene.locator('.ws-floorplan');
  const photo = async () => {
    const img = await loadImage(await floor.screenshot({ animations: 'disabled', scale: 'css' }));
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const shown = await photo();
  await seat.evaluate(el => { el.style.visibility = 'hidden'; });
  let hidden;
  try { hidden = await photo(); }
  finally { await seat.evaluate(el => el.style.removeProperty('visibility')); }
  function changed(x0, y0, x1, y1) {
    let different = 0, count = 0;
    for (let y = Math.ceil(shown.height * y0); y < shown.height * y1; y++) {
      for (let x = Math.ceil(shown.width * x0); x < shown.width * x1; x++) {
        const i = 4 * (y * shown.width + x);
        if ([0, 1, 2].some(c => Math.abs(shown.data[i + c] - hidden.data[i + c]) > 20)) different++;
        count++;
      }
    }
    return different / count;
  }
  assert(changed(.07, .60, .27, .82) > .12, '第二张沙发要实际绘在猫尾左后方');
  assert(changed(.301, .779, .356, .794) < .1, '橘猫尾巴应画在第二张沙发前面');
}

export async function checkRestingFurniture(room, scene, hit, shot) {
  const seat = scene.locator('.ws-nest-loveseat');
  const table = scene.locator('.ws-nest-coffee-table');
  await seat.waitFor();
  await table.waitFor();
  const stationarySofa = await roomBox(seat);
  const stationaryTable = await roomBox(table);
  // 猫脸在 x=.414，尾部在左侧 x≈.29、y≈.78。新增沙发的右端要落在尾部后面。
  assert(stationarySofa.right > .23 && stationarySofa.right < .385 && stationarySofa.bottom > .7,
    '第二张沙发没有放在猫尾后 ' + JSON.stringify(stationarySofa));
  await checkTailInFront(scene, seat);
  await hit('sofa').click();
  await room.locator('.ws-scene[data-nest-pose="rest"][data-life-phase="settled"]').waitFor();
  const person = scene.locator('.ws-nest-sofa-rest');
  await person.waitFor();
  const resting = await roomBox(person);
  const center = (resting.x + resting.right) / 2;
  assert(center > .18 && center < .52 && resting.y < .6 && resting.bottom > .47,
    '休息人物应坐在原画靠墙沙发 ' + JSON.stringify(resting));
  assert.equal(await scene.locator('.ws-life-actor').isVisible(), false, '休息时不能再绘制自带凳子的旧人物');
  assert.deepEqual(await roomBox(seat), stationarySofa, '休息时另一个沙发不应移动或消失');
  assert.deepEqual(await roomBox(table), stationaryTable, '倒水桌在休息时也留在原位');
  await shot('回到沙发休息');
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="auto"]').click();
}

export async function checkLocalWallClock(page, scene) {
  const clock = scene.locator('time.nest-wall-clock');
  await clock.waitFor();
  const dial = await roomBox(clock);
  assert(Math.abs((dial.x + dial.right) / 2 - .3695) < .009 && Math.abs((dial.y + dial.bottom) / 2 - .1343) < .012,
    '真实指针应覆盖原画挂钟 ' + JSON.stringify(dial));
  async function readHands() {
    return clock.evaluate(el => {
      const now = new Date();
      const angle = selector => {
        const hand = el.querySelector(selector);
        const rect = hand.getBoundingClientRect();
        const matrix = new DOMMatrix(getComputedStyle(hand).transform);
        return { degrees: (Math.atan2(matrix.b, matrix.a) * 180 / Math.PI + 360) % 360, visible: rect.width > 0 && rect.height > 0 };
      };
      return { hour: angle('.nest-clock-hour'), minute: angle('.nest-clock-minute'), time: el.dateTime,
        h: now.getHours(), m: now.getMinutes() };
    });
  }
  const expectLocalTime = async () => {
    const actual = await readHands();
    const mid = n => String(n).padStart(2, '0');
    assert.equal(actual.time, mid(actual.h) + ':' + mid(actual.m));
    assert(actual.hour.visible && actual.minute.visible, '两只指针都要画出来');
    const distance = (a, b) => Math.abs((a - b + 540) % 360 - 180);
    assert(distance(actual.hour.degrees, 30 * (actual.h % 12) + actual.m / 2) < .2, '时针角度错误 ' + JSON.stringify(actual));
    assert(distance(actual.minute.degrees, actual.m * 6) < .2, '分针角度错误 ' + JSON.stringify(actual));
    return actual.time;
  };
  const start = await expectLocalTime();
  await page.clock.fastForward(60000);
  assert.notEqual(await expectLocalTime(), start, '零额外操作等一分钟，钟应自己走动');
  const resumeAt = async instant => {
    await page.evaluate(() => dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: false } })));
    await page.clock.setSystemTime(instant);
    await page.evaluate(() => dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: true } })));
    await expectLocalTime();
  };
  const original = await page.evaluate(() => new Date().getTime());
  try {
    await resumeAt(new Date('2026-11-21T14:13:00Z'));
  } finally {
    await resumeAt(new Date(original));
  }
}

// 从美术实际像素找头与围巾的位置，把「坐人」和「空座」的屏幕截图相减。
// 落出画布、藏在猫后或被节目蒙住的采样点，在两张截图里没有变化，也计入分母。
export async function checkViewerPixels(scene, device) {
  const subject = scene.locator('.ws-nest-loveseat');
  const samples = await subject.evaluate(async (el, device) => {
    const rect = el.getBoundingClientRect(), stage = el.closest('.ws-scene').getBoundingClientRect();
    const img = new Image();
    img.src = getComputedStyle(el, '::after').backgroundImage.replace(/^url\(["']?|["']?\)$/g, '');
    await img.decode();
    const sw = img.naturalWidth / 3, sh = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    function frame(n) {
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(img, n * sw, 0, sw, sh, 0, 0, sw, sh);
      return ctx.getImageData(0, 0, sw, sh).data;
    }
    const empty = frame(0), sitting = frame(device === 'tv' ? 1 : 2);
    function points(left, top, right, bottom) {
      const selected = [];
      for (let y = Math.ceil(top * sh); y < bottom * sh; y += 3) {
        for (let x = Math.ceil(left * sw); x < right * sw; x += 3) {
          const i = 4 * (y * sw + x);
          if (sitting[i + 3] < 200 || empty[i + 3] > 200 && [0,1,2].every(c => Math.abs(sitting[i + c] - empty[i + c]) < 48)) continue;
          selected.push([rect.left - stage.left + rect.width * x / sw, rect.top - stage.top + rect.height * y / sh]);
        }
      }
      return selected;
    }
    // 坐人的帧各包含蓝发、面部和胸前围巾，排除不属于该人物的沙发纹理。
    return { head: points(.67,.085,.9,.42), body: points(.69,.42,.92,.60) };
  }, device);
  const capture = async () => {
    const img = await loadImage(await scene.screenshot({scale:'css', animations:'disabled'}));
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const shown = await capture();
  const hide = await scene.page().addStyleTag({content: '.ws-scene[data-nest-viewing] .ws-nest-loveseat { background-position:0 0 !important; } .ws-scene[data-nest-viewing] .ws-nest-loveseat::after { visibility:hidden !important; }'});
  let empty;
  try { empty = await capture(); }
  finally { await hide.evaluate(style => style.remove()); }
  function visibleFraction(points) {
    assert(points.length >= 20, '采样区没有人物美术像素');
    const count = points.filter(([px, py]) => {
      const x = Math.floor(px), y = Math.floor(py);
      if (x < 0 || x >= shown.width || y < 0 || y >= shown.height) return false;
      const offset = (y * shown.width + x) * 4;
      return [0, 1, 2].some(c => Math.abs(shown.data[offset + c] - empty.data[offset + c]) > 20);
    }).length;
    return count / points.length;
  }
  const head = visibleFraction(samples.head), body = visibleFraction(samples.body);
  console.log(device, '观看者实际可见头部、上身', head.toFixed(2), body.toFixed(2));
  assert(head > .72 && body > .48, '观看时应能辨认未央的头部和上身 ' + JSON.stringify({device,head,body}));
}
