import './composerMedia.css';

/** 手机上交给系统相机；电脑上预览摄像头，确认后作为普通附件加入，不自动发送。 */
export function initCamera({ button, input, native = false, onFiles, onError }) {
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (files.length) Promise.resolve(onFiles(files)).catch(onError);
  });
  let dialog = null;
  let opening = false;
  button.addEventListener('click', async () => {
    if (native || !navigator.mediaDevices?.getUserMedia) { input.click(); return; }
    if (opening || dialog) return;
    opening = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      dialog = document.createElement('dialog');
      dialog.className = 'camera-preview';
      dialog.setAttribute('aria-label', '拍照预览');
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      const actions = document.createElement('div');
      actions.className = 'camera-actions';
      const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消' });
      const capture = Object.assign(document.createElement('button'), { type: 'button', textContent: '拍照并添加' });
      const close = () => { stream.getTracks().forEach(t => t.stop()); video.srcObject = null; dialog?.remove(); dialog = null; globalThis.removeEventListener?.('pagehide', close); button.focus(); };
      globalThis.addEventListener?.('pagehide', close, { once: true });
      cancel.onclick = close;
      dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
      capture.onclick = async () => {
        if (!video.videoWidth) return;
        capture.disabled = true;
        try {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
          if (!blob) throw new Error('照片生成失败，请重试');
          await onFiles([new File([blob], `拍照-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
          close();
        } catch (e) { capture.disabled = false; onError(e); }
      };
      actions.append(cancel, capture);
      dialog.append(video, actions);
      document.body.append(dialog);
      dialog.showModal();
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop());
      dialog?.remove(); dialog = null;
      onError(new Error(e.name === 'NotAllowedError' ? '相机权限被拒绝，请在系统或浏览器设置里允许使用相机' : e.name === 'NotFoundError' ? '没有找到摄像头，可以用附件按钮添加图片' : `相机打不开：${e.message}`));
    } finally { opening = false; }
  });
}
