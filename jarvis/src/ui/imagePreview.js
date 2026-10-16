/** 原图从工作区按需读取；预览关闭后立即释放 Blob URL。 */
export function showImagePreview(src, { title = '图片预览', revoke = false } = {}) {
  const dialog = document.createElement('dialog'); dialog.className = 'image-preview';
  const head = document.createElement('header'), name = document.createElement('strong'), close = document.createElement('button');
  name.textContent = title; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭图片预览'); head.append(name,close);
  const img = Object.assign(document.createElement('img'), { src, alt: title });
  dialog.append(head,img); document.body.append(dialog);
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; dialog.remove(); if (revoke) URL.revokeObjectURL(src); };
  close.onclick = () => dialog.close(); dialog.addEventListener('close', cleanup);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.showModal(); close.focus(); return dialog;
}
export function imageButton(src, onOpen, label = '查看上传图片') {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'image-open', title: label });
  button.setAttribute('aria-label', label); button.append(Object.assign(document.createElement('img'), { src, alt: label, loading: 'lazy' }));
  button.addEventListener('click', () => onOpen()); return button;
}
export async function previewWorkspaceImage(path, thumbnail = '') {
  try {
    const ws = await import('../agent/workspace.js');
    const blob = await ws.readBlob(path);
    return showImagePreview(URL.createObjectURL(blob), { title: '上传的图片', revoke: true });
  } catch {
    if (thumbnail) return showImagePreview(thumbnail, { title: '历史图片预览（缩略图）' });
    throw new Error('图片已不在工作区，请重新上传');
  }
}
