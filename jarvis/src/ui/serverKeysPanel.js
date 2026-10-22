/**
 * 云服务器用的博查搜索 Key、fal.ai（唱歌）Key：直接写进服务器配置。
 * “从本机复制”特意不带搜索凭据，所以这里单独填；服务器只回掩码，留空保存就保留原值。
 */
export function serverKeysPanel({ cfg, workspace, node }) {
  const field = (label, value, hint) => {
    const input = node('input', { type: 'password', autocomplete: 'off', ariaLabel: label, maxLength: 512, placeholder: value ? `已配置（${value}）；留空保留` : '未配置' });
    return { input, row: node('label', { className: 'ml-field' }, node('span', { textContent: label }), input, node('small', { className: 'ml-muted', textContent: hint })) };
  };
  const bocha = field('博查搜索 Key', cfg.bochaKey, 'DeepSeek 搜索没开或失败时的备用；不填就退回免费的必应、百度。');
  const fal = field('fal.ai Key（唱歌）', cfg.falKey, '让未央把写好的歌唱出来，按次收费（约 0.03 美元一首）。');
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const save = node('button', { type: 'button', className: 'ml-button', textContent: '保存到服务器' });
  save.addEventListener('click', async () => {
    const next = {};
    if (bocha.input.value.trim()) next.bochaKey = bocha.input.value.trim();
    if (fal.input.value.trim()) next.falKey = fal.input.value.trim();
    if (!Object.keys(next).length) {
      result.textContent = '没有填新的 Key，原来的保持不变';
      return;
    }
    save.disabled = true;
    try {
      await workspace.patch((value) => ({ ...value, ...next }), 'server');
      result.textContent = '已保存到服务器';
    } catch (error) {
      result.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  return node('details', { className: 'ml-copy' }, node('summary', { textContent: '搜索与唱歌的 Key · 云服务器' }), bocha.row, fal.row, save, result);
}
