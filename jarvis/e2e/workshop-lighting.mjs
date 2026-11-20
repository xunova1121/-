import assert from 'node:assert/strict';
import path from 'node:path';

// 比对屏幕上的桌面和地板与原画。使用实际镜头尺寸换算坐标，排除人物、家具和阅读/播放面板。
async function measureRoom(page, room, label, { minBrightness = .79, maxBrightness = Infinity, minContrast = .78, screenshotPath } = {}) {
  const shot = await page.screenshot({ animations: 'disabled', scale: 'css', path: screenshotPath });
  const result = await room.evaluate(async (el, encoded) => {
    const floor = el.querySelector('.ws-floorplan');
    const frame = floor.getBoundingClientRect();
    const scene = el.querySelector('.ws-scene').getBoundingClientRect();
    const source = getComputedStyle(floor).backgroundImage.match(/url\("([^"]+)"\)/)[1];
    const blockers = [...el.querySelectorAll('.ws-room-item, .ws-life-actor, .ws-actor, .ws-device, .ws-room-tools, .ws-monitor-ticker, .ws-media-panel[data-device="monitor"], .ws-media-receiver, .ws-media-remote, .ws-media-header')]
      .filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect());
    const width = Math.round(scene.width), height = Math.round(scene.height);
    async function pixels(url, x, y, w, h) {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, x, y, w ?? image.width, h ?? image.height);
      return ctx.getImageData(0, 0, width, height).data;
    }
    const raw = await pixels(source, frame.left - scene.left, frame.top - scene.top, frame.width, frame.height);
    const shot = await pixels('data:image/png;base64,' + encoded, -scene.left, -scene.top);
    const reference = [], actual = [];
    const luma = (data, i) => .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
    for (let row = 8; row < height - 8; row += 2) {
      const y = scene.top + row;
      if (y < frame.top + .35 * frame.height || y > frame.top + .94 * frame.height) continue;
      for (let col = 8; col < width - 8; col += 2) {
        const x = scene.left + col;
        if (x < frame.left || x >= frame.right) continue;
        if (blockers.some(b => x > b.left - 6 && x < b.right + 6 && y > b.top - 6 && y < b.bottom + 6)) continue;
        const i = 4 * (row * width + col);
        reference.push(luma(raw, i));
        actual.push(luma(shot, i));
      }
    }
    const mean = (values) => values.reduce((sum, n) => sum + n, 0) / values.length;
    const quantile = (sorted, q) => sorted[Math.floor(q * sorted.length)];
    const contrast = sorted => quantile(sorted, .9) - quantile(sorted, .1);
    reference.sort((a,b) => a - b);
    actual.sort((a,b) => a - b);
    return { samples: actual.length, brightness: mean(actual) / mean(reference),
      contrast: contrast(actual) / contrast(reference) };
  }, shot.toString('base64'));
  console.log(label, result);
  assert(result.samples >= 100 && result.brightness >= minBrightness && result.brightness <= maxBrightness &&
    result.contrast >= minContrast, label + ' 房间实测光照或纹理超出范围 ' + JSON.stringify(result));
  return result;
}

export async function checkWorkshopLighting(page, room, platform, output) {
  const returnToRoom = room.getByRole('button', { name: '返回房间', exact: true });
  if (await returnToRoom.isVisible()) await returnToRoom.click();
  const darkRoom = { minBrightness: .48, maxBrightness: .68, minContrast: .39 };
  for (const [hour, period, lamp] of [[12, 'day', 'off'], [21, 'night', 'on'], [23, 'night', 'off']]) {
    await page.clock.setSystemTime(await page.evaluate(h => new Date().setHours(h, 15, 0, 0), hour));
    await room.locator('[data-room-action="menu"]').click();
    await room.locator('[data-room-action="lamp-auto"]').click();
    if (hour === 21) await page.locator('#btn-theme').dispatchEvent('click');
    assert.equal(await page.locator('html').getAttribute('data-theme'), hour === 12 ? 'light' : 'dark');
    await room.locator(`.ws-scene[data-life-period="${period}"][data-lamp-lit="${lamp}"]`).waitFor();
    const limits = hour === 23 ? darkRoom : { minContrast: hour === 12 ? .92 : .78 };
    const roomLight = await measureRoom(page, room, platform + ' ' + period + ' 灯' + lamp, limits);
    if (hour === 21) {
      for (const device of ['tv', 'monitor']) {
        await room.locator(`[data-media-device="${device}"]`).click();
        await room.locator(`.ws-media-panel[data-device="${device}"]`).waitFor();
        // 放大电视后手机仅露出很窄的一片地板，阴影边缘对其分位数更敏感。
        await measureRoom(page, room, platform + ' 夜间' + device, { minContrast: device === 'tv' ? .73 : .78 });
        await returnToRoom.click();
      }
      const lightSwitch = room.locator('[data-room-action="light"]');
      await lightSwitch.click();
      await room.locator('.ws-scene[data-lamp-lit="off"]').waitFor();
      const switchedOff = await measureRoom(page, room, platform + ' 手动关灯',
        { ...darkRoom, screenshotPath: path.join(output, platform + '-light-off.png') });
      assert(switchedOff.brightness < roomLight.brightness * .70, '关灯应明显暗于同一时刻的开灯画面');
      await lightSwitch.click();
      await room.locator('.ws-scene[data-lamp-lit="on"]').waitFor();
      await measureRoom(page, room, platform + ' 手动开灯', { screenshotPath: path.join(output, platform + '-light-on.png') });
    }
  }
  await page.clock.setSystemTime(new Date());
  await page.locator('#btn-theme').dispatchEvent('click');
}
