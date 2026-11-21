/**
 * 把文件交给用户：电脑 / 浏览器里直接下载；安卓 App 里网页下载不起作用，
 * 改为存到手机“文档/Jarvis”文件夹（不自动跳去别的应用；要用 WPS、微信打开点“分享”，见 shareFile）。
 * @returns {Promise<string>} 给用户看的结果说明
 */
export async function saveFile(blob, name) {
  const safe = String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
  if (globalThis.__jarvisSaveFile) return globalThis.__jarvisSaveFile(blob, safe);
  const u = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: u, download: safe });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
  return `已下载 ${safe}`;
}

/** 安卓 App：弹系统分享面板，用别的应用打开或发送（没有原生分享时返回 null，调用方不显示按钮） */
export const canShareFile = () => typeof globalThis.__jarvisShareFile === 'function';
export async function shareFile(blob, name) {
  const safe = String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
  return globalThis.__jarvisShareFile(blob, safe);
}
