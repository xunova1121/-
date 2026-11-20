import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkNewsEntrance({ page, room, platform, output }) {
  const ticker = room.getByRole('button', { name: /新闻简报/ });
  const computer = room.locator('[data-media-device="monitor"]');
  const news = room.locator('.ws-media-panel[data-device="monitor"]');
  const trials = [[ticker, 'system'], [computer, 'app'], [ticker, 'normal'], [computer, 'normal']];
  if (platform === 'mobile') trials.unshift([ticker, 'closeup']);
  for (const [trigger, preference] of trials) {
    if (preference === 'closeup') {
      await room.getByRole('button', { name: '坐到沙发上休息' }).click();
      await room.locator('.ws-scene[data-life-place="lounge"][data-life-phase="settled"]').waitFor();
      await room.getByRole('button', { name: '近看操作' }).click();
    }
    await page.emulateMedia({ reducedMotion: preference === 'system' ? 'reduce' : 'no-preference' });
    await page.locator('#set-motion').evaluate((select, value) => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, preference === 'app' ? 'on' : 'system');
    const probe = await trigger.evaluateHandle(button => {
      const result = {};
      const room = button.closest('.ws-scene');
      const rect = element => element.getBoundingClientRect().toJSON();
      button.addEventListener('click', () => {
        result.screen = rect(room.querySelector('.ws-mini-screen'));
        result.room = rect(room);
        result.trigger = rect(button);
      }, { capture: true, once: true });
      room.addEventListener('click', () => {
        const panel = room.querySelector('.ws-media-panel');
        const motion = panel.getAnimations().find(a => a.effect?.getKeyframes().some(frame => frame.transform));
        if (motion) {
          motion.pause();
          motion.currentTime = 0;
          result.start = rect(panel);
          motion.currentTime = motion.effect.getTiming().duration * .25;
          result.middle = rect(panel);
        }
      }, { once: true });
      return result;
    });
    await trigger.click();
    const snapshot = await probe.jsonValue();
    const { screen, start, middle } = snapshot;
    await probe.dispose();
    if (preference === 'normal' || preference === 'closeup') {
      assert(start, '点简报或实体显示器时应有真实缩放');
      if (preference === 'closeup') assert(screen.left >= snapshot.room.right, '沙发近景的电脑应在房间外');
      const origin = preference === 'closeup' ? snapshot.trigger : screen;
      for (const key of ['left', 'top', 'width', 'height']) {
        assert(Math.abs(start[key] - origin[key]) < 2, '展开起点应贴合当前可见的新闻入口 ' + key);
      }
      if (trigger === computer) await page.screenshot({ path: path.join(output, platform + '-news-opening.png') });
    } else {
      assert.equal(start, undefined, preference + ' 减少动态时应立即呈现新闻');
    }
    await news.evaluate(el => el.getAnimations().forEach(animation => animation.finish()));
    const end = await news.boundingBox();
    const scene = await room.locator('.ws-scene').boundingBox();
    const coverage = end.width * end.height / (scene.width * scene.height);
    assert(coverage >= .62 && coverage <= .72, '新闻应占房间约 2/3 面积，实测 ' + coverage);
    assert(Math.abs(end.x + end.width / 2 - scene.x - scene.width / 2) <= 2);
    assert(Math.abs(end.y + end.height / 2 - scene.y - scene.height / 2) <= 2);
    if (middle) assert(middle.height > start.height && middle.height < end.height, '新闻应由小变大');
    if (preference === 'normal' && trigger === computer) {
      console.log(platform + ' 新闻从电脑屏面放大，居中占工作台 ' + (coverage * 100).toFixed(1) + '%');
      return;
    }
    await news.getByRole('button', { name: '返回房间' }).press('Escape');
    assert(await trigger.evaluate(el => el === document.activeElement), '退出新闻回到原来的入口');
    if (preference === 'closeup') await room.getByRole('button', { name: '看全景' }).click();
  }
}
