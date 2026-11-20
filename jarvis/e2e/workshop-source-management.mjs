import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkWorkshopSourceManagement({ page, context, room, platform, output }) {
  const address = 'https://media.example.org/workshop/test.webm';
  const offline = 'https://media.example.org/workshop/unavailable.webm';
  const clip = await readFile(new URL('../src/ui/assets/workStudio/meadow-preview.webm', import.meta.url));
  await context.route(address, route => route.fulfill({ contentType: 'video/webm', body: clip }));
  await context.route(offline, route => route.fulfill({ status: 404 }));
  const control = (parent, name) => parent.getByRole('button', { name, exact: true });
  const manage = control(room, '管理视频源');
  const editor = room.locator('.ws-source-manager');
  const name = editor.getByLabel('频道名称', { exact: true });
  const url = editor.getByLabel('播放地址', { exact: true });
  const video = room.locator('.ws-tv-player video');
  async function playing() {
    const handle = await video.elementHandle({ timeout: 10000 });
    try {
      await page.waitForFunction(el => el.currentSrc === el.src && el.videoWidth > 0 && !el.paused && el.currentTime > 0, handle, { timeout: 10000 });
    } finally {
      await handle.dispose();
    }
  }
  try {
    await control(room, '打开电视').click();
    await manage.click();
    await control(editor, '添加视频源').click();
    await name.fill('演播室测试');
    await url.fill('ftp://example.org/live');
    await control(editor, '试播').click();
    assert((await editor.getByRole('alert').innerText()).trim(), '地址无效时应在表单提示原因');
    await url.fill(offline);
    await control(editor, '试播').click();
    await control(room, '重新连接').waitFor();
    assert(!await editor.isVisible(), '试播应退出表单并显示电视');
    await control(room, '返回编辑视频源').click();
    assert.equal(await url.inputValue(), offline);
    await url.fill(address);
    await control(editor, '试播').click();
    await playing();
    assert.equal(await control(room, '演播室测试').count(), 0, '试播不能提前保存频道');
    await control(room, '返回编辑视频源').click();
    await control(editor, '保存并播放').click();
    await playing();
    assert.equal(await control(room, '演播室测试').getAttribute('aria-pressed'), 'true');
    await manage.click();
    await control(editor, '编辑 演播室测试').click();
    await name.fill('已改名的电视');
    await control(editor, '保存并播放').click();
    assert.equal(await control(room, '已改名的电视').getAttribute('aria-pressed'), 'true');
    await control(room, '返回房间').click();
    await control(room, '打开电视').click();
    await playing();
    await manage.click();
    await control(editor, '编辑 已改名的电视').click();
    await control(editor, '移除').click();
    await control(editor, '保留').click();
    assert(await control(editor, '移除').isVisible(), '取消移除后仍可编辑');
    await control(editor, '移除').click();
    await control(editor, '确认移除').click();
    assert(!await control(room, '已改名的电视').count(), '移除应同步工作台遥控器');
    await control(editor, '关闭视频源管理').click();
    assert.equal(await room.locator('.ws-media-channels [aria-pressed="true"]').count(), 1);
    const stations = room.locator('.ws-media-channels button');
    const defaults = await stations.evaluateAll(buttons => buttons.map(el => el.getAttribute('aria-label')));
    await manage.click();
    for (const station of defaults) {
      await control(editor, '移除 ' + station).click();
      assert(!await control(room.locator('.ws-media-channels'), station).count(), '移除后遥控器应同步隐藏 ' + station);
    }
    await control(editor, '关闭视频源管理').click();
    assert(!await room.locator('.ws-tv-glass :is(video,iframe)').count(), '移除最后一个频道须释放播放器');
    await control(room, '返回房间').click();
    await control(room, '打开电视').click();
    await page.screenshot({ path: path.join(output, platform + '-tv-empty.png') });
    await control(room, '添加或恢复频道').click();
    await page.screenshot({ path: path.join(output, platform + '-tv-restore.png') });
    assert.equal(await stations.count(), 0, '重新打开电视后空频道表应保留');
    for (const station of defaults.toReversed()) await control(editor, '恢复 ' + station).click();
    await control(editor, '关闭视频源管理').click();
    assert.equal(await stations.count(), defaults.length);
    assert.equal(await stations.last().getAttribute('aria-pressed'), 'true', '恢复其他默认频道后保留当前频道');
    await control(room, '返回房间').click();
    console.log(platform + ' 工作台视频源：验证地址、试播失败和成功、保存、改名、恢复选台和移除通过');
  } finally {
    await context.unroute(offline);
    await context.unroute(address);
  }
}
