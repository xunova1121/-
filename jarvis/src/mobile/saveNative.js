/**
 * 安卓 App 里“下载”文件：WebView 里网页下载不起作用。
 *   1. 先写进 App 自己的缓存目录，弹出系统分享面板（用 WPS、微信等打开，或“保存到手机”）；
 *   2. 再顺手存一份到手机“文档/Jarvis”。
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

/**
 * @param {{ Filesystem: object, Directory: object, Share: object, toast?: (t: string) => void, timeoutMs?: number }} deps
 */
export function createNativeSaver({ Filesystem, Directory, Share, toast = () => {}, timeoutMs = 15000 }) {
  return async function saveNative(blob, name) {
    toast(`正在准备 ${name}…`);
    const data = await blobToBase64(blob);
    // 分享面板只能分享 App 自己目录里的文件
    let shareError = null;
    try {
      const { uri } = await withTimeout(Filesystem.writeFile({ path: `share/${name}`, data, directory: Directory.Cache, recursive: true }), timeoutMs, '写入缓存');
      // 分享面板关闭时才返回，不等它；出错时再提示
      Share.share({ title: name, files: [uri], dialogTitle: `打开或发送 ${name}` })
        .catch((e) => { if (!CANCELLED.test(String(e?.message || e))) toast(`打开分享面板失败：${e?.message || e}`); });
    } catch (e) { shareError = e; }
    let where = '';
    try {
      await withTimeout(Filesystem.writeFile({ path: `Jarvis/${name}`, data, directory: Directory.Documents, recursive: true }), timeoutMs, '保存到“文档”');
      where = `已保存到手机“文档/Jarvis/${name}”`;
    } catch { /* 没有存储权限、同名文件属于旧版 App 等：只靠分享面板 */ }
    if (shareError && !where) throw new Error(`保存失败：${shareError.message || shareError}`);
    return where ? `${where}${shareError ? '' : '，也可以在弹出的面板里用其他 App 打开'}` : `已准备好 ${name}：在弹出的面板里选择用哪个 App 打开或保存`;
  };
}
