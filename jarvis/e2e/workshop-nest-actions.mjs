import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { checkPortraitViewer, isPortraitNest } from './workshop-fixed-nest.mjs';
import { checkViewerPixels } from './workshop-room-furniture.mjs';

async function pixels(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

// 定在相同动画进度对照两张真实截图，单测中定时器触发本身不能证明角色在动。
export async function checkLivingMotion(page, scene) {
  const portrait = await isPortraitNest(scene);
  const parts = portrait ? scene.locator('.ws-nest-portrait-actor,.ws-nest-portrait-cat')
    : scene.locator('.ws-nest-idle-paint,.ws-nest-cat-body,.ws-nest-cat-face');
  if (portrait) await scene.locator('.ws-nest-portrait-actor[data-picture="work"]').waitFor();
  else await scene.locator('.ws-nest-living[data-idle-pose="work"]').waitFor();
  await parts.evaluateAll(els => Promise.all(els.filter(el => el instanceof HTMLImageElement && el.currentSrc).map(el => el.decode())));
  async function frame(fraction) {
    await parts.evaluateAll((els, fraction) => {
      for (const el of els) for (const animation of el.getAnimations()) {
        animation.pause();
        animation.currentTime = animation.effect.getTiming().duration * fraction;
      }
    }, fraction);
    return pixels(await scene.screenshot({ scale: 'css' }));
  }
  const before = await frame(0), after = await frame(.4);
  const changed = ([x0, y0, x1, y1]) => {
    let count = 0;
    for (let y = Math.floor(before.height * y0); y < before.height * y1; y++) {
      for (let x = Math.floor(before.width * x0); x < before.width * x1; x++) {
        const i = 4 * (y * before.width + x);
        if ([0,1,2].some(c => Math.abs(before.data[i+c] - after.data[i+c]) > 3)) count++;
      }
    }
    return count;
  };
  const regions = await scene.evaluate((el, portrait) => {
    const stage = el.getBoundingClientRect();
    const floor = el.querySelector('.ws-floorplan').getBoundingClientRect();
    const points = (left, top, right, bottom) => [
      (left - stage.left) / stage.width, (top - stage.top) / stage.height,
      (right - stage.left) / stage.width, (bottom - stage.top) / stage.height,
    ].map(n => Math.max(0, Math.min(1, n)));
    const floorRegion = ([x0, y0, x1, y1]) => points(floor.left + x0 * floor.width,
      floor.top + y0 * floor.height, floor.left + x1 * floor.width, floor.top + y1 * floor.height);
    const spriteRegion = selector => {
      const b = el.querySelector(selector).getBoundingClientRect();
      return points(b.left, b.top, b.right, b.bottom);
    };
    return {
      person: portrait ? spriteRegion('.ws-nest-portrait-actor') : floorRegion([.55,.32,.70,.56]),
      cat: portrait ? spriteRegion('.ws-nest-portrait-cat') : floorRegion([.29,.65,.44,.82]),
      wall: floorRegion([.07,.13,.16,.25]),
    };
  }, portrait);
  const motion = { person: changed(regions.person), cat: changed(regions.cat), wall: changed(regions.wall) };
  assert(motion.person >= 8 && motion.cat >= 8 && motion.wall <= 2, '人物、橘猫各自有动作，背景书架应保持静止 ' + JSON.stringify(motion));
  await parts.evaluateAll(els => els.forEach(el => el.getAnimations().forEach(animation => animation.play())));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert(await parts.evaluateAll(els => els.every(el => getComputedStyle(el).animationName === 'none')),
    '减少动态时保留自然姿势，停止循环动作');
  // 分别验证每个姿势的实际样式；闻手、理毛和蹭手的选择器比普通待机层更具体。
  const poses = ['alert', 'asleep', 'listening', 'deep', 'groom', 'rest', 'sniff', 'welcome', 'pet'];
  async function movingCatParts() {
    if (portrait) return scene.evaluate((el, list) => {
      const original = el.dataset.catState;
      try {
        return list.filter(pose => {
          el.dataset.catState = pose;
          return getComputedStyle(el.querySelector('.ws-nest-portrait-cat')).animationName !== 'none';
        });
      } finally { el.dataset.catState = original; }
    }, poses);
    return scene.locator('.ws-nest-cat-motion').evaluate((cat, list) => {
      const probe = cat.cloneNode(true);
      cat.after(probe);
      try {
        return list.filter(pose => {
          probe.dataset.pose = pose;
          return [...probe.querySelectorAll('img')].some(el => getComputedStyle(el).animationName !== 'none');
        });
      } finally { probe.remove(); }
    }, poses);
  }
  assert.deepEqual(await movingCatParts(), [], '系统减少动态应覆盖全部猫姿势');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // 使用设置页同一个选项和 change 处理器。系统偏好异步更新时也应尊重应用设置。
  const preference = page.locator('#set-motion');
  const previous = await preference.inputValue();
  try {
    await preference.selectOption('on', { force: true });
    assert.deepEqual(await movingCatParts(), [], '应用减少动态应覆盖全部猫姿势');
  } finally {
    await preference.selectOption(previous, { force: true });
  }
}

export async function checkCoffee(page, room, scene, hit, shot) {
  const living = scene.locator('.ws-nest-living');
  const table = scene.locator('.ws-nest-coffee-table');
  await table.waitFor();
  const service = () => table.evaluate(el => getComputedStyle(el, '::after').display);
  assert.notEqual(await service(), 'none', '未开始冲泡时桌上也要有壶和杯');
  const restingPlace = await table.evaluate(el => [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight]);
  const frames = await living.evaluateHandle(el => {
    const frames = [];
    const observer = new MutationObserver(() => {
      if (!el.dataset.coffeePhase) return;
      const paint = getComputedStyle(el.querySelector('.ws-nest-coffee'));
      if (paint.display !== 'none') frames.push({ phase: el.dataset.coffeePhase, frame: paint.backgroundPosition });
    });
    observer.observe(el, {attributes: true, attributeFilter: ['data-coffee-phase']});
    return {frames, observer};
  });
  await hit('cup').click();
  const phase = name => scene.locator(`[data-coffee-phase="${name}"] .ws-nest-coffee`).waitFor();
  await phase('pour');
  assert.equal(await service(), 'none', '拿起壶时空出壶杯原来所在的台面');
  await checkUnobstructed(scene, '桌前倒咖啡');
  const geometry = await living.locator('.ws-nest-coffee').evaluate(el => {
    const actor = el.getBoundingClientRect(), stage = el.closest('.ws-floorplan'), floor = stage.getBoundingClientRect();
    const x = (actor.left + actor.width * .86 - floor.left) / floor.width;
    const y = (actor.top + actor.height * .82 - floor.top) / floor.height;
    const table = stage.querySelector('.ws-nest-coffee-table').getBoundingClientRect();
    const mugX = (actor.left + actor.width * .86 - table.left) / table.width;
    const mugY = (actor.top + actor.height * .82 - table.top) / table.height;
    const style = getComputedStyle(el);
    return { x, y, mugX, mugY, frame: style.backgroundPosition, art: style.backgroundImage };
  });
  const pourRegion = await isPortraitNest(scene) ? [.82,.98,.41,.50] : [.64,.83,.4,.58];
  assert(geometry.x > pourRegion[0] && geometry.x < pourRegion[1] && geometry.y > pourRegion[2] && geometry.y < pourRegion[3] && geometry.art !== 'none',
    '水流落到桌面杯中 ' + JSON.stringify(geometry));
  assert(geometry.mugX > .25 && geometry.mugX < .46 && geometry.mugY > .04 && geometry.mugY < .17,
    '杯底应落在固定茶桌左侧的实际桌面内 ' + JSON.stringify(geometry));
  assert.equal(await scene.locator('.ws-life-actor').isVisible(), false, '倒咖啡时桌旁只有一位未央');
  await shot('桌边冲咖啡');
  await phase('hold');
  assert.deepEqual(await table.evaluate(el => [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight]), restingPlace,
    '倒水和喝完都应使用同一张固定的茶桌');
  const timeline = await frames.evaluate(log => { log.observer.disconnect(); return log.frames; });
  await frames.dispose();
  assert.deepEqual([...new Set(timeline.map(f => f.phase))], ['reach','pour','set-down','sip','hold'], '茶具和手应按冲泡顺序换姿势');
  assert.notEqual(timeline.find(f => f.phase === 'sip').frame, geometry.frame, '放下水壶后，应换到抬杯喝咖啡的图像');
  await hit('cup').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await phase('pour');
  await page.clock.fastForward(9000);
  await phase('pour');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="auto"]').click();
}

// 记录真正接到输出端的抚摸音频。前半段要有说话声，后半段还要能量出猫叫。
export async function listenForCat(page) {
  return page.evaluateHandle(() => {
    const output = new Map();
    const sounds = [];
    const originalConnect = AudioNode.prototype.connect;
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioNode.prototype.connect = function(target, ...args) {
      const result = originalConnect.call(this, target, ...args);
      if (target === this.context.destination) {
        const analyser = this.context.createAnalyser();
        originalConnect.call(this, analyser);
        output.set(this.context, analyser);
      }
      return result;
    };
    AudioBufferSourceNode.prototype.start = function(...args) {
      const result = originalStart.apply(this, args);
      const analyser = output.get(this.context);
      if (!analyser || !this.buffer) return result;
      const sound = { seconds: this.buffer.duration, voice: 0, meow: 0 };
      sounds.push(sound);
      const start = Math.max(args[0] || 0, this.context.currentTime);
      const pcm = new Float32Array(analyser.fftSize);
      const sample = () => {
        const elapsed = this.context.currentTime - start;
        if (this.context.state === 'closed' || elapsed > sound.seconds) return;
        analyser.getFloatTimeDomainData(pcm);
        const part = elapsed < sound.seconds * .65 ? 'voice' : 'meow';
        for (const value of pcm) sound[part] = Math.max(sound[part], Math.abs(value));
        requestAnimationFrame(sample);
      };
      sample();
      return result;
    };
    return { sounds, restore() {
      AudioNode.prototype.connect = originalConnect;
      AudioBufferSourceNode.prototype.start = originalStart;
      for (const probe of output.values()) probe.disconnect();
      output.clear();
    } };
  });
}

// 按住或点到实物时，朗读标签可以保留；只核验用户在画面上真正能看见的字。
export async function checkUnobstructed(scene, action) {
  const labels = await scene.evaluate(root => {
    const stage = root.getBoundingClientRect();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const labels = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const el = text.parentElement;
      if (!text.textContent.trim() || el.closest('[data-room-action="menu"], [data-room-action="listen"]')) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const box of range.getClientRects()) {
        const left = Math.max(stage.left, box.left), right = Math.min(stage.right, box.right);
        const top = Math.max(stage.top, box.top), bottom = Math.min(stage.bottom, box.bottom);
        if (right - left < 3 || bottom - top < 3) continue;
        // 已裁到 1px 的无障碍播报与屏外操作栏没有覆盖房间。
        const clipped = el.closest('.sr-only,[role="status"],[aria-live]');
        if (clipped && clipped.getBoundingClientRect().width <= 1) continue;
        labels.push(text.textContent.trim());
        break;
      }
    }
    return labels;
  });
  assert.deepEqual(labels, [], action + '时画面不被操作文案遮挡');
}

// 把真实播放流旁接到分析器，不造声音，也不改变原来的音量或输出目的地。
async function readRadioSignal(page, audio) {
  const element = await audio.elementHandle();
  try {
    await page.waitForFunction(el => !el.paused && el.currentTime > .08 && el.readyState >= 2 && !el.muted && el.volume > 0, element);
  } finally { await element.dispose(); }
  const peak = await audio.evaluate(async el => {
    const context = new AudioContext();
    const stream = el.captureStream();
    const input = context.createMediaStreamSource(stream);
    const probe = context.createAnalyser();
    input.connect(probe);
    try {
      await context.resume();
      const pcm = new Float32Array(probe.fftSize);
      const deadline = context.currentTime + 2;
      let peak = 0;
      while (context.currentTime < deadline && peak < .008) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        probe.getFloatTimeDomainData(pcm);
        for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
      }
      return peak;
    } finally {
      input.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close();
    }
  });
  assert(peak > .008, '收音机播放应产生实际音乐波形，实测峰值 ' + peak);
  return audio.evaluate(el => el.currentSrc);
}

export async function checkRadio(page, room, scene, hit) {
  const radio = hit('radio');
  const audio = room.locator('audio.ws-radio-audio');
  const dial = await radio.boundingBox();
  const tv = await room.locator('[data-media-device="tv"]').boundingBox();
  if (await isPortraitNest(scene)) {
    const floor = await scene.locator('.ws-floorplan').boundingBox();
    assert(dial && tv && dial.x > tv.x + tv.width/2 && dial.x < floor.x + floor.width * .40 && dial.y + dial.height/2 < tv.y + tv.height,
      '收音机应在照片墙下、矮柜上电视的右手边');
  } else assert(dial && tv && dial.y + dial.height / 2 < tv.y && dial.x < tv.x + tv.width && dial.x + dial.width > tv.x,
    '收音机点击区域要在真实电视上方');
  await radio.click();
  const first = await readRadioSignal(page, audio);
  await checkUnobstructed(scene, '开收音机');
  await radio.click();
  assert(await audio.evaluate(el => el.paused), '再点收音机应实际停播');
  await radio.click();
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="radio-next"]').click();
  const second = await readRadioSignal(page, audio);
  assert.notEqual(first, second, '换台后应播放另一份实际乐曲');
  await room.locator('[data-media-device="tv"]').click();
  assert(await audio.evaluate(el => el.paused), '打开电视时收音机应停止播放');
  const television = room.locator('.ws-media-panel[data-device="tv"]');
  await television.getByRole('button', { name: '返回房间', exact: true }).click();
  await television.waitFor({state:'hidden'});
}

export async function checkViewingPlace(room, device) {
  const scene = room.locator(`[data-nest-viewing="${device}"]`);
  await scene.waitFor();
  if (await isPortraitNest(scene)) {
    const actor = scene.locator('.ws-nest-portrait-actor');
    await actor.waitFor();
    await actor.evaluate(img => img.decode());
    const screen = await scene.locator(device === 'tv' ? '.ws-media-receiver' : '.ws-media-panel').boundingBox();
    const stage = await scene.boundingBox();
    assert(screen.width > stage.width * (device === 'tv' ? .88 : .64), '电视或新闻必须在手机内展开并清楚可看');
    if (device === 'news') assert(Math.abs(screen.x + screen.width / 2 - stage.x - stage.width / 2) < 2, '新闻位于小窝中央');
    await checkPortraitViewer(scene, device);
    return;
  }
  const shot = await scene.evaluate((el, device) => {
    const rect = selector => el.querySelector(selector).getBoundingClientRect();
    const furniture = el.querySelector('.ws-nest-loveseat');
    const style = getComputedStyle(furniture, '::after');
    const sofa = furniture.getBoundingClientRect();
    const floor = rect('.ws-floorplan');
    const screen = rect(device === 'tv' ? '.ws-media-receiver' : '.ws-media-panel');
    const stage = el.getBoundingClientRect();
    // 取前景沙发实际帧中的眼睛及原地毯上的猫，而非页面的固定屏幕坐标。
    const eye = [sofa.left + sofa.width * .845, sofa.top + sofa.height * .337];
    const catEye = [floor.left + floor.width * .414, floor.top + floor.height * .692];
    const catEar = [floor.left + floor.width * .405, floor.top + floor.height * .651];
    const inside = (point, box) => point[0] > box.left && point[0] < box.right && point[1] > box.top && point[1] < box.bottom;
    const inSight = point => inside(point, stage) && !inside(point, screen);
    return { viewer: inSight(eye), cat: inSight(catEye) && inSight(catEar), eye, catEye, catEar,
      coverage: screen.width * screen.height / (stage.width * stage.height),
      frame: style.backgroundPositionX, art: style.backgroundImage !== 'none', screen: screen.toJSON() };
  }, device);
  assert(shot.art && shot.frame === (device === 'tv' ? '50%' : '100%'), '第二张沙发应显示正在观看的人物美术帧 ' + device);
  assert(shot.viewer && shot.cat, '未央的眼睛、前景猫的眼睛和耳朵都应在节目与新闻正文之外可见 ' + JSON.stringify(shot));
  await checkViewerPixels(scene, device);
  if (device === 'news') assert(shot.coverage >= .62 && shot.coverage <= .72, '新闻继续占房间约三分之二 ' + JSON.stringify(shot));
}
