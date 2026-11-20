import assert from 'node:assert/strict';

// 旁路监听送往扬声器的同一份 PCM。不调用合成器私有方法，不加速音频时钟。
export async function checkWorkshopHum(page, room, choose) {
  await page.evaluate(() => {
    const original = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(target, ...args) {
      const result = original.call(this, target, ...args);
      if (target === this.context.destination) {
        const analyser = this.context.createAnalyser();
        original.call(this, analyser);
        window.humOutput = analyser;
      }
      return result;
    };
  });
  const label = room.locator('.ws-action');
  const songs = new Set(['正在哼《茉莉花》', '正在哼《凤阳花鼓》', '正在哼《小白菜》']);
  const readSong = async () => {
    const title = await label.textContent();
    assert.ok(songs.has(title), title + ' 显示实际播放的中文曲名');
    await page.waitForFunction(() => {
      const source = window.humOutput;
      if (!source || source.context.state !== 'running') return false;
      const pcm = new Float32Array(source.fftSize);
      source.getFloatTimeDomainData(pcm);
      return pcm.some(point => Math.abs(point) > .008);
    });
    return title;
  };
  // 回到自然哼歌的作息段。未点唱时只预告曲目，扬声器保持安静。
  await page.clock.setFixedTime(new Date('2026-11-20T10:36:00+08:00'));
  await room.locator('[data-room-action="menu"]').click();
  await room.locator('[data-room-action="auto"]').click();
  const listen = room.locator('[data-room-action="listen"]');
  await listen.waitFor();
  const advertised = (await listen.textContent()).replace('听《', '正在哼《');
  assert.equal(await page.evaluate(() => Boolean(window.humOutput)), false);
  await listen.click();
  const first = await readSong();
  assert.equal(first, advertised, '点自然作息的哼歌，听到当前显示的曲名');
  await label.filter({ hasText: '正在哼《', hasNotText: first }).waitFor({ timeout: 30000 });
  const second = await readSong();
  await choose('sing');
  const third = await readSong();
  assert.equal(new Set([first, second, third]).size, 3, '自动接唱和手动换歌共用一轮不重复的歌单');
  await choose('sing');
  assert.notEqual(await readSong(), third, '新一轮的第一首避开上一轮最后一首');
  // 原生 App 的前后台通知到达工作台时立即收声，回前台不自行重启。
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: false } })));
  await page.waitForFunction(() => window.humOutput.context.state === 'closed');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: true } })));
  assert.equal(await page.evaluate(() => window.humOutput.context.state), 'closed');
  await choose('sing');
  await readSong();
  await choose('rest');
  await page.waitForFunction(() => window.humOutput.context.state === 'closed');
  await choose('sing');
  await readSong();
  await page.locator('.wb-tabs button').first().click();
  await page.waitForFunction(() => window.humOutput.context.state === 'closed');
  console.log('工作台中文哼唱：' + [first, second, third].join(' → ') + '；连续两首有实际波形，离开工作台音频关闭。');
}
