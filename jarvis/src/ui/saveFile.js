/**
 * 把文件交给用户：电脑 / 浏览器里直接下载；安卓 App 里网页下载不起作用，
 * 改为存到手机“文档/Jarvis”文件夹，并弹出系统分享面板（可用 WPS、微信等打开或发送）。
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
