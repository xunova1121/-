import assert from 'node:assert/strict';

// 近看时任何 transform-origin 漂移都会被 2 倍镜头放大。用互动菜单中的真实入口分别展开、收回电视和新闻。
export async function checkNearNestCamera(room, scene) {
  const zoom = room.locator('.ws-zoom-toggle');
  const camera = () => scene.locator('.ws-floorplan').evaluate(floor => {
    const geometry = floor.getBoundingClientRect();
    const style = getComputedStyle(floor);
    return {x:geometry.x,y:geometry.y,w:geometry.width,h:geometry.height,transform:style.transform,origin:style.transformOrigin};
  });
  await zoom.click();
  await scene.page().waitForFunction(() => {
    const floor = document.querySelector('.work-studio-view[data-visible="true"] .ws-floorplan');
    return floor && new DOMMatrix(getComputedStyle(floor).transform).a >= 1.99;
  });
  const scroll = await scene.evaluate(el => {
    // 浏览器可以像 scrollTo 一样滚动 overflow:hidden；2×下两个方向都有画外内容。
    const before = [el.scrollLeft,el.scrollTop];
    el.scrollTo(80,12);
    const after = [el.scrollLeft,el.scrollTop];
    el.scrollTo(...before);
    return {before,after};
  });
  assert.deepEqual(scroll.after,[0,0],'画外家具不应使小窝镜头发生内部滚动');
  assert.deepEqual(scroll.before,scroll.after,'进入近看就已经平移了画面');
  const before = await camera();
  const panel = scene.locator('.ws-media-panel');
  for (const [device, opener] of [['tv','[data-room-action="tv"]'],['monitor','.ws-monitor-ticker']]) {
    await scene.locator('[data-room-action="menu"]').click();
    await scene.locator(opener).click();
    await scene.locator('.ws-media-panel[data-device="' + device + '"]').waitFor();
    assert.deepEqual(await camera(), before, device + ' 打开时近看倍率和轴心都应保持不动');
    await panel.getByRole('button', {name:'返回房间',exact:true}).click();
    await panel.waitFor({state:'hidden'});
    assert.deepEqual(await camera(), before, device + ' 收起后沙发仍在原地');
  }
  await zoom.click();
}
