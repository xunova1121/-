/**
 * 安卓 App 里“下载”文件：WebView 里网页下载不起作用。
 *   下载：只存到手机“文档/Jarvis”，不自动跳去别的应用（以前自动弹分享面板，选了 WPS、微信就跳进去，按返回回不来）；
 *         存不进去（没有存储权限等）才弹分享面板兜底。
 *   分享：用户点“分享”时才弹系统分享面板（用 WPS、微信等打开或发送）。
 * 每一步都有超时：原生插件没响应时也一定给用户一句话，而不是点了没反应。
 */
import { createShareReturnCoordinator } from './shareReturn.js';
import { prepareShareCache } from './shareCache.js';

const withTimeout = async (p, ms, what) => {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}没有响应`)), ms); })]); }
  finally { clearTimeout(timer); }
};
// 同一个原生Share插件只有一个选择器；不能因每次创建saver就丢掉互斥状态。
const coordinators = new WeakMap();
function coordinatorFor(Share, supplied) {
  if (supplied) return supplied;
  if (!coordinators.has(Share)) coordinators.set(Share, createShareReturnCoordinator());
  return coordinators.get(Share);
}

/** Blob → Base64（分块转换，大文件也不会卡住） */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const CANCELLED = /cancel|取消|dismiss/i;

/** 回到未央的说明：别的应用按返回键不一定能回来 */
export const BACK_TIP = '用完从手机的“最近任务”切回未央（别的应用按返回键不一定能回到这里）';

/** 分享面板：先写进 App 自己的缓存目录（分享面板只能分享这里的文件） */
async function openShare({ Filesystem, Directory, Share, toast, timeoutMs, shareReturn, manageShareCache }, data, name) {
  const coordinator = coordinatorFor(Share, shareReturn);
  const ticket = await coordinator.begin();
  try {
    if (manageShareCache) await withTimeout(prepareShareCache(Filesystem, Directory, { protectedIds: [ticket.id, coordinator.pending()?.id].filter(Boolean) }), timeoutMs, '检查分享缓存');
    const encoded = typeof data === 'function' ? await data() : data;
    const { uri } = await withTimeout(Filesystem.writeFile({ path: `share/${ticket.id}/${name}`, data: encoded, directory: Directory.Cache, recursive: true }), timeoutMs, '写入缓存');
    const prepared = await withTimeout(coordinator.prepare(ticket), Math.min(timeoutMs, 3000), '准备返回入口').catch(() => ({ notification: false }));
    coordinator.launch(ticket);
    // 选择器回调可能一直不结束；页面不等待它，不提前声称已分享成功。
    Promise.resolve(Share.share({ title: name, files: [uri], dialogTitle: `打开或发送 ${name}` })).then(
      () => coordinator.settle(ticket),
      e => { coordinator.settle(ticket, true); if (!CANCELLED.test(String(e?.message || e))) toast(`打开分享面板失败：${e?.message || e}`); }
    );
    return prepared?.notification === true;
  } catch (error) { coordinator.cancel(ticket); throw error; }
}

/**
 * 下载：存到“文档/Jarvis”，不跳转；存不进去才用分享面板
 * @param {{ Filesystem: object, Directory: object, Share: object, toast?: (t: string) => void, timeoutMs?: number }} deps
 */
export function createNativeSaver({ Filesystem, Directory, Share, toast = () => {}, timeoutMs = 15000, shareReturn, manageShareCache = typeof Filesystem.readdir === 'function' }) {
  const deps = { Filesystem, Directory, Share, toast, timeoutMs, shareReturn, manageShareCache };
  return async function saveNative(blob, name) {
    toast(`正在保存 ${name}…`);
    const data = await blobToBase64(blob);
    try {
      await withTimeout(Filesystem.writeFile({ path: `Jarvis/${name}`, data, directory: Directory.Documents, recursive: true }), timeoutMs, '保存到“文档”');
      return `已保存到手机“文档/Jarvis/${name}”（文件管理里能找到）；要用 WPS、微信打开，点“分享”`;
    } catch {
      /* 没有存储权限、同名文件属于旧版 App 等：用分享面板 */
    }
    try {
      await openShare(deps, data, name);
    } catch (e) {
      throw new Error(`保存失败：${e.message || e}`);
    }
    return `没能存进“文档”，已请求打开分享面板：选“保存到手机”或用其他应用打开；${BACK_TIP}`;
  };
}

/** 分享：用户点了才弹系统分享面板 */
export function createNativeSharer({ Filesystem, Directory, Share, toast = () => {}, timeoutMs = 15000, shareReturn, manageShareCache = typeof Filesystem.readdir === 'function' }) {
  const deps = { Filesystem, Directory, Share, toast, timeoutMs, shareReturn, manageShareCache };
  return async function shareNative(blob, name) {
    const notification = await openShare(deps, () => blobToBase64(blob), name);
    return `已请求打开分享面板；${notification ? '分享后可点通知“返回未央”；' : ''}${BACK_TIP}`;
  };
}
