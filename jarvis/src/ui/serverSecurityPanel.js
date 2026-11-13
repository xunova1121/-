/** 主人管理设备和评测授权；明文授权只留本次生成视图，不进聊天或配置。 */
import './serverSecurityPanel.css';
export function createServerSecurityPanel({ client, toast }) {
  const node = (tag, text, props = {}) => Object.assign(document.createElement(tag), { ...(text && { textContent: text }), ...props });
  const panel = node('details', '', { className: 'server-security' });
  panel.append(node('summary', '登录安全与评测授权'));
  const message = node('p', '', { role: 'status', className: 'muted small' });
  const warning = node('p', '', { className: 'server-security-warning' });
  const devices = node('div', '', { className: 'server-security-devices' });
  const evaluations = node('div', '', { className: 'server-security-evaluations' });
  const name = node('input', '', { placeholder: '例如：30题复测', maxLength: 80, ariaLabel: '评测授权名称' });
  const days = node('input', '', { type: 'number', min: '1', max: '30', value: '7', ariaLabel: '评测有效天数' });
  const dailyLimit = node('input', '', { type: 'number', min: '1', max: '10000', value: '200', ariaLabel: '每日模型与搜索次数上限' });
  const issued = node('div', '', { className: 'server-security-issued', hidden: true });
  const token = node('textarea', '', { readOnly: true, rows: 2, ariaLabel: '仅本次显示的评测令牌', autocomplete: 'off', spellcheck: false });
  const clear = () => { token.value = ''; issued.hidden = true; };
  const adminSection = node('div');
  let loading = false;
  const run = async action => {
    if (loading) return;
    loading = true;
    try { await action(); }
    catch (failure) { message.textContent = failure.status === 404 ? '此服务器尚未支持安全管理，请先更新服务器。' : failure.status === 401 ? '请先在上方登录服务器。' : '安全操作未完成，请稍后重试。'; }
    finally { loading = false; }
  };
  const button = (label, action) => {
    const result = node('button', label, { type: 'button', className: 'btn ghost sm' });
    result.addEventListener('click', () => run(action));
    return result;
  };
  const date = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未使用';
  async function refresh() {
    const current = await client().security();
    adminSection.hidden = current.identity?.role === 'member';
    if (adminSection.hidden) clear();
    devices.replaceChildren();
    evaluations.replaceChildren();
    warning.textContent = current.weakPassword ? '当前密码较短或简单。最低允许6位；建议你自行在 /opt/jarvis/jarvis.env 设置更长的密码，程序不会修改密码。' : '';
    message.textContent = current.loginLockedUntil ? '有人在尝试密码，登录暂锁至 ' + date(current.loginLockedUntil) : '30天不用自动退出，单次登录最长90天；新设备登录会提醒。';
    for (const device of current.devices || []) {
      const row = node('div', '', { className: 'server-security-row' });
      row.append(node('p', `${device.device}${device.current ? '（当前设备）' : ''} · ${device.ip}`), node('p', '最近使用：' + date(device.lastUsedAt), { className: 'muted small' }));
      row.append(button(device.current ? '退出当前设备' : '退出此设备', async () => {
        await client().revokeDevice(device.id);
        if (device.current) { clear(); message.textContent = '此设备已退出，请重新登录。'; devices.replaceChildren(); evaluations.replaceChildren(); }
        else await refresh();
      }));
      devices.append(row);
    }
    for (const evaluation of current.evaluations || []) {
      const row = node('div', '', { className: 'server-security-row' });
      row.append(node('p', evaluation.name + (evaluation.revoked ? '（已作废）' : '')), node('p', `今日 ${evaluation.today}/${evaluation.dailyLimit} 次 · 累计 ${evaluation.used} 次 · 到期 ${date(evaluation.expiresAt)}`, { className: 'muted small' }), node('p', '最近使用：' + date(evaluation.lastUsedAt), { className: 'muted small' }));
      if (!evaluation.revoked) row.append(button('作废授权', async () => { await client().revokeEvaluationToken(evaluation.id); await refresh(); }));
      evaluations.append(row);
    }
  }
  const label = (title, input) => { const el = node('label', title, { className: 'field' }); el.append(input); return el; };
  issued.append(node('p', '此令牌只显示这一次。请只保存在评测机器的私有环境变量 JARVIS_EVAL_TOKEN 中，不要发到对话、日志或仓库。'), token,
    button('复制本次令牌', async () => { if (token.value) { await navigator.clipboard.writeText(token.value); toast('已复制，请保存在私有环境'); } }), button('已保存，隐藏令牌', async () => clear()));
  panel.append(message, warning, button('刷新安全状态', refresh), node('h4', '已登录设备'), devices,
    button('退出所有其他设备', async () => { await client().revokeDevice('others'); await refresh(); }));
  adminSection.append(node('h4', '评测专用授权'),
    node('p', '只能读写自己的评测任务与会话；不能读取设置、文件、代码仓库或用户对话。模型调用和搜索共用每日限额。', { className: 'muted small' }),
    label('名称', name), label('有效期（天，最多30）', days), label('每日调用上限', dailyLimit),
    button('生成评测令牌', async () => {
      const value = { name: name.value, days: Number(days.value), dailyLimit: Number(dailyLimit.value) };
      if (!Number.isInteger(value.days) || value.days < 1 || value.days > 30 || !Number.isInteger(value.dailyLimit) || value.dailyLimit < 1 || value.dailyLimit > 10000) { message.textContent = '有效期应为1至30天，每日次数为1至10000。'; return; }
      clear();
      const result = await client().createEvaluationToken(value);
      if (!panel.open) return; // 页面关闭后不重新显示敏感内容。
      token.value = result.token;
      issued.hidden = false;
      await refresh();
    }), issued, evaluations);
  panel.append(adminSection);
  panel.addEventListener('toggle', () => { if (panel.open) run(refresh); else clear(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  return panel;
}
