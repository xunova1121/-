// 安卓聊天可能在软件绘制下运行。显示小屋前等原生切到可播放视频的图层，
// 离开时先停播，再还原聊天的原图层。旧网页和旧安装包仍走原来的入口。
export function createWorkshopDrawing({ show, hide, failed, plugin = () => globalThis.__jarvisRenderHealthPlugin, now = Date.now }) {
  let desired = false;
  let revision = 0;

  return function setActive(active) {
    if (active === desired) return;
    desired = active;
    revision = Math.max(now(), revision + 1);
    const current = revision;
    if (!active) hide();
    const bridge = plugin();
    if (!bridge?.setWorkshopDrawing) {
      if (active) show();
      return;
    }
    const onError = (error) => {
      if (current !== revision || !active) return;
      if (/UNIMPLEMENTED|not implemented/i.test(String(error?.code) + ' ' + String(error?.message))) show();
      else failed('unavailable');
    };
    let applied;
    try { applied = bridge.setWorkshopDrawing({ active, revision }); }
    catch (error) { onError(error); return; }
    Promise.resolve(applied).then(result => {
      if (current !== revision || !active) return;
      if (result?.status === 'applied' && result.active) show();
      else if (result?.status === 'background') desired = null; // 原生可能比网页更早收到切后台通知。
      else failed(result?.status || 'unavailable');
    }, onError);
  };
}
