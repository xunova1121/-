import assert from 'node:assert/strict';

// 近看时任何 transform-origin 漂移都会被 2 倍镜头放大。使用真实按钮触发一次观影再收起。
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
  const before = await camera();
  await scene.locator('[data-room-action="menu"]').click();
  await scene.locator('[data-room-action="tv"]').click();
  await scene.locator('.ws-tv-glass').waitFor();
  assert.deepEqual(await camera(), before, '看电视时近看倍率和轴心都应保持不动');
  await scene.getByRole('button', {name:'返回房间',exact:true}).click();
  await scene.locator('.ws-media-panel').waitFor({state:'hidden'});
  assert.deepEqual(await camera(), before, '收起电视后沙发仍在原地');
  await zoom.click();
}
