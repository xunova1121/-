/**
 * 安卓 App 里“下载”文件：WebView 里网页下载不起作用。
 *   下载：只存到手机“文档/Jarvis”，不自动跳去别的应用（以前自动弹分享面板，选了 WPS、微信就跳进去，按返回回不来）；
 *         存不进去（没有存储权限等）才弹分享面板兜底。
 *   分享：用户点“分享”时才弹系统分享面板（用 WPS、微信等打开或发送）。
 * 每一步都有超时：原生插件没响应时也一定给用户一句话，而不是点了没反应。
 */
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}没有响应`)), ms))]);

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
async function openShare({ Filesystem, Directory, Share, toast, timeoutMs }, data, name) {
  const { uri } = await withTimeout(Filesystem.writeFile({ path: `share/${name}`, data, directory: Directory.Cache, recursive: true }), timeoutMs, '写入缓存');
  // 分享面板关闭时才返回，不等它；出错时再提示
  Share.share({ title: name, files: [uri], dialogTitle: `打开或发送 ${name}` })
    .catch((e) => { if (!CANCELLED.test(String(e?.message || e))) toast(`打开分享面板失败：${e?.message || e}`); });
}

/**
 * 下载：存到“文档/Jarvis”，不跳转；存不进去才用分享面板
 * @param {{ Filesystem: object, Directory: object, Share: object, toast?: (t: string) => void, timeoutMs?: number }} deps
 */
export function createNativeSaver({ Filesystem, Directory, Share, toast = () => {}, timeoutMs = 15000 }) {
  const deps = { Filesystem, Directory, Share, toast, timeoutMs };
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
    return `没能存进“文档”，已打开分享面板：选“保存到手机”或用其他应用打开；${BACK_TIP}`;
  };
}

/** 分享：用户点了才弹系统分享面板 */
export function createNativeSharer({ Filesystem, Directory, Share, toast = () => {}, timeoutMs = 15000 }) {
  const deps = { Filesystem, Directory, Share, toast, timeoutMs };
  return async function shareNative(blob, name) {
    await openShare(deps, await blobToBase64(blob), name);
    return `已打开分享面板；${BACK_TIP}`;
  };
}
