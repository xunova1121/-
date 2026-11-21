// 保留独立的任务工位验收：从正式工作台切换到三工位，再检查人物走动、道具和媒体。
export async function openTaskFloor(room) {
  const scene = room.locator('.ws-scene');
  if (await scene.getAttribute('data-room-view') === 'nest') {
    await clickViewControl(room, room.locator('[data-action="work-floor"]'));
    await room.locator('.ws-scene:not([data-room-view="nest"])').waitFor();
  }
}

export async function clickViewControl(room, button) {
  if (!await button.isVisible() && await room.locator('.ws-scene[data-nest-layout="portrait"][data-room-view="nest"]').count()) {
    await room.locator('[data-room-action="menu"]').click();
  }
  await button.click();
}

// 手机的互动浮层展开、滚动和收起，都不能挤压对话或替换当前输入。
export async function checkNestControls(page, room) {
  const toggle = room.locator('[data-room-action="menu"]');
  const controls = room.locator('.ws-room-menu');
  const prompt = page.locator('#prompt');
  const text = await prompt.inputValue();
  const layout = () => page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const scene = box('#mobile-work-studio .ws-scene');
    const button = box('#mobile-work-studio [data-room-action=menu]');
    const prompt = box('#prompt');
    const chat = box('#mobile-work-studio .mobile-studio-chat');
    return {
      onRight: button.right > scene.x + scene.width * .7 && button.y < scene.top + 56,
      inputTouchable: Boolean(document.elementFromPoint(prompt.x + prompt.width / 2, prompt.y + prompt.height / 2)?.closest('#inputbar')),
      chat: [chat.top, chat.height, prompt.top, prompt.height],
      scene: [scene.x,scene.y,scene.width,scene.height],
      prompt: [prompt.x,prompt.y,prompt.width,prompt.height],
      viewport: [innerWidth,innerHeight,visualViewport.height,window.scrollY],
      focus: document.activeElement?.id || document.activeElement?.className,
      classes: document.body.className,
      target: document.elementFromPoint(prompt.x + prompt.width / 2, prompt.y + prompt.height / 2)?.tagName
    };
  });
  const before = await layout();
  if (!before.onRight || !before.inputTouchable || await controls.isVisible()) throw Error('互动入口应位于房间右上并默认折叠，输入框可点');
  await toggle.click();
  await controls.waitFor();
  const open = await layout();
  if (!open.inputTouchable || open.chat.some((n, i) => Math.abs(n - before.chat[i]) > 1)) throw Error('互动浮层挤占工作台对话 ' + JSON.stringify({before, open}));
  await controls.locator('[data-room-action=draft]').scrollIntoViewIfNeeded();
  await toggle.click();
  await controls.waitFor({ state: 'hidden' });
  if (await prompt.inputValue() !== text) throw Error('收起互动后原来输入的文字丢失');
}
