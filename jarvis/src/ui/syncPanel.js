/**
 * 设置里的“多设备同步”：填写阿里云 OSS、选择同步内容、立即同步、生成 / 使用同步码。
 */
import { GROUPS, problemOf } from '../sync/controller.js';
import { makeSyncCode, readSyncCode } from '../sync/crypto.js';

const $ = (s) => document.querySelector(s);
const FIELDS = { endpoint: '#sync-endpoint', bucket: '#sync-bucket', accessKeyId: '#sync-ak', accessKeySecret: '#sync-sk', passphrase: '#sync-pass' };

const ago = (ts) => {
  if (!ts) return '还没同步过';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? '刚刚同步' : m < 60 ? `${m} 分钟前同步` : `上次同步：${new Date(ts).toLocaleString()}`;
};

export function describeResult(result) {
  const parts = Object.entries(result || {}).map(([g, r]) => {
    const name = { memory: '记忆', sessions: '对话', config: '设置' }[g] ?? g;
    const moves = [r.pulled && `收到 ${r.pulled}`, r.pushed && `上传 ${r.pushed}`].filter(Boolean).join('、');
    return `${name}${moves ? ` ${moves}` : ' 无变化'}`;
  });
  return parts.join('；');
}

export function initSyncPanel({ controller, toast }) {
  const groupsBox = $('#sync-groups');
  for (const [id, label] of Object.entries(GROUPS)) {
    const l = document.createElement('label');
    l.className = 'inline-check';
    l.innerHTML = `<input type="checkbox" id="sync-g-${id}" /> `;
    l.append(label);
    groupsBox.append(l);
  }
  const status = $('#sync-status');

  function render() {
    const s = controller.settings;
    $('#sync-on').checked = s.enabled;
    $('#sync-form').hidden = !s.enabled;
    for (const [k, sel] of Object.entries(FIELDS)) $(sel).value = s[k] || '';
    for (const id of Object.keys(GROUPS)) $(`#sync-g-${id}`).checked = Boolean(s.groups[id]);
    $('#sync-auto').checked = s.auto;
    status.textContent = s.enabled ? (s.lastError ? `同步失败：${s.lastError}` : ago(s.lastSync)) : '';
  }

  const collect = () => ({
    ...Object.fromEntries(Object.entries(FIELDS).map(([k, sel]) => [k, $(sel).value.trim()])),
    groups: Object.fromEntries(Object.keys(GROUPS).map((id) => [id, $(`#sync-g-${id}`).checked])),
    auto: $('#sync-auto').checked
  });

  $('#sync-on').addEventListener('change', (e) => { controller.update({ enabled: e.target.checked }); render(); });
  for (const sel of [...Object.values(FIELDS), '#sync-auto']) $(sel).addEventListener('change', () => controller.update(collect()));
  groupsBox.addEventListener('change', () => controller.update(collect()));

  async function syncNow() {
    controller.update(collect());
    const p = problemOf(controller.settings);
    if (p) { status.textContent = p; return; }
    const btn = $('#btn-sync-now');
    btn.disabled = true;
    status.textContent = '正在同步…（第一次要算加密密钥，稍等几秒）';
    try {
      const r = await controller.run({ manual: true });
      status.textContent = `同步完成：${describeResult(r)}`;
    } catch (e) {
      status.textContent = `同步失败：${e.message}`;
    } finally { btn.disabled = false; }
  }
  $('#btn-sync-now').addEventListener('click', syncNow);

  // 同步码：把 OSS 配置加密成一段文字，手机上粘贴 + 输入同一个同步密码即可
  let codeMode = '';
  const box = $('#sync-code-box');
  $('#btn-sync-code').addEventListener('click', async () => {
    controller.update(collect());
    const s = controller.settings;
    const p = problemOf(s);
    if (p) { status.textContent = p; return; }
    status.textContent = '正在生成…';
    const { endpoint, bucket, accessKeyId, accessKeySecret } = s;
    const code = await makeSyncCode({ endpoint, bucket, accessKeyId, accessKeySecret }, s.passphrase);
    codeMode = 'show';
    box.hidden = false;
    $('#sync-code').value = code;
    $('#sync-code').readOnly = true;
    $('#sync-code-hint').textContent = '把这段同步码发到手机（如微信“文件传输助手”），在手机 App 的设置里点“用同步码设置”，粘贴后输入同一个同步密码。同步码已用同步密码加密。';
    $('#btn-sync-code-go').textContent = '复制';
    status.textContent = '';
  });
  $('#btn-sync-paste').addEventListener('click', () => {
    codeMode = 'paste';
    box.hidden = false;
    $('#sync-code').value = '';
    $('#sync-code').readOnly = false;
    $('#sync-code-hint').textContent = '粘贴电脑上生成的同步码，并在上面的“同步密码”里填写同一个密码，然后点确定。';
    $('#btn-sync-code-go').textContent = '确定';
    $('#sync-code').focus();
  });
  $('#btn-sync-code-go').addEventListener('click', async () => {
    const code = $('#sync-code').value.trim();
    if (codeMode === 'show') {
      try { await navigator.clipboard.writeText(code); toast('同步码已复制'); } catch { $('#sync-code').select(); toast('请长按或 Ctrl+C 复制'); }
      return;
    }
    const pass = $('#sync-pass').value.trim();
    if (!pass) { $('#sync-code-hint').textContent = '请先在上面填写同步密码（和电脑上的一样）'; return; }
    try {
      const oss = await readSyncCode(code, pass);
      controller.update({ ...oss, passphrase: pass, enabled: true });
      box.hidden = true;
      render();
      await syncNow();
    } catch (e) {
      $('#sync-code-hint').textContent = e.message;
    }
  });

  render();
  return { render };
}
