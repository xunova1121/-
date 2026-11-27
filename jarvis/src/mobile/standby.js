/**
 * 设置里的“后台待命”（常驻通知，默认关；只有安卓 App 有）：开着时原生层挂一条静音通知，
 * 让系统把未央当作在工作的应用，少被后台管理关掉（见原生 StandbyService.java）。
 */
export async function initStandbyToggle({ plugin = globalThis.__jarvisBackgroundTask, doc = document, toast = () => {} } = {}) {
  const row = doc.getElementById('row-standby');
  const input = doc.getElementById('set-standby');
  if (!row || !input || !plugin?.standby) return;
  let state;
  try {
    state = await plugin.standby({});
  } catch {
    return; // 旧版 App 没有这个方法：不显示
  }
  row.hidden = false;
  input.checked = Boolean(state?.on);
  input.addEventListener('change', async () => {
    const on = input.checked;
    input.disabled = true;
    try {
      const r = await plugin.standby({ on });
      input.checked = Boolean(r?.on);
      toast(on ? '已开启后台待命：通知栏会常驻一条静音通知' : '已关闭后台待命');
    } catch (error) {
      input.checked = !on;
      toast(`后台待命没设置成功：${error.message || error}`);
    } finally {
      input.disabled = false;
    }
  });
}
