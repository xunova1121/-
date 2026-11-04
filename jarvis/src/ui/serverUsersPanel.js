/** 管理员创建稳定用户ID；访问码只在生成/重置时显示，不存浏览器、不写日志。 */
import './serverSecurityPanel.css';
export function createServerUsersPanel({ client, toast }) {
  const node = (tag, text = '', props = {}) => Object.assign(document.createElement(tag), { textContent: text, ...props });
  const panel = node('details', '', { className: 'server-security server-users' });
  const status = node('p', '', { role: 'status' });
  const controls = node('div', '', { hidden: true });
  const name = node('input', '', { placeholder: '例如：小李', maxLength: 40, ariaLabel: '用户名称' });
  const concurrency = node('select', '', { ariaLabel: '服务器同时执行任务数' });
  for (const n of [1, 2, 3, 4]) concurrency.append(node('option', `${n} 个任务${n === 2 ? '（建议起步值）' : ''}`, { value: String(n) }));
  concurrency.value = '2';
  const rows = node('div');
  const issued = node('div', '', { hidden: true, className: 'server-security-issued' });
  const code = node('textarea', '', { readOnly: true, rows: 2, ariaLabel: '本次生成的个人访问码', autocomplete: 'off', spellcheck: false });
  const identity = node('p');
  let busy = false;
  const clear = () => { code.value = ''; issued.hidden = true; };
  const button = (title, action) => {
    const el = node('button', title, { type: 'button', className: 'btn ghost sm' });
    el.addEventListener('click', async () => {
      if (busy) return;
      busy = true; el.disabled = true;
      try { await action(); }
      catch (e) { status.textContent = e.status === 404 ? '请先更新服务器以支持用户绑定。' : e.message || '操作未完成'; }
      finally { busy = false; el.disabled = false; }
    });
    return el;
  };
  function reveal(result) {
    if (!panel.open || document.hidden) return;
    identity.textContent = result.name + ' · ' + result.id;
    code.value = result.accessCode; issued.hidden = false;
  }
  async function refresh() {
    const security = await client().security();
    const user = security.identity;
    controls.hidden = Boolean(user && user.role !== 'owner');
    if (controls.hidden) { clear(); rows.replaceChildren(); status.textContent = `当前用户：${user.name}。对话、文件、记忆和任务独立保存，模型由管理员共享。`; return; }
    const users = await client().users();
    const cfg = await client().getConfig();
    if (cfg.taskConcurrency) concurrency.value = String(cfg.taskConcurrency);
    status.textContent = `已绑定 ${users.length} 位成员。主人的原数据和登录保持有效。`;
    rows.replaceChildren();
    for (const user of users) {
      const row = node('div', '', { className: 'server-security-row' });
      row.append(node('p', user.name + (user.disabled ? '（已停用）' : '')), node('p', user.id, { className: 'muted small' }));
      row.append(button(user.disabled ? '启用' : '停用', async () => { clear(); await client().updateUser(user.id, user.disabled ? 'enable' : 'disable'); await refresh(); }),
        button('重置访问码', async () => { clear(); const result = await client().updateUser(user.id, 'reset'); reveal(result); await refresh(); }));
      rows.append(row);
    }
  }
  issued.append(identity, node('p', '访问码仅本次显示，请私下交给本人。手机和电脑在服务器登录的密码栏填写同一码，进入同一份数据。不要发送到聊天或日志。'), code,
    button('复制访问码', async () => { if (code.value) { await navigator.clipboard.writeText(code.value); toast('已复制个人访问码'); } }), button('已保存，隐藏', clear));
  controls.append(node('p', '每位成员独立保存对话、附件、知识库、记忆、提醒与代码项目。成员不能修改共享模型、管理其他用户或更新服务器。'), concurrency, button('保存并发数', async () => { await client().putConfig({ taskConcurrency: Number(concurrency.value) }); status.textContent = '已保存，超过名额的任务排队执行。'; }), name,
    button('添加用户', async () => { clear(); await client().putConfig({ taskConcurrency: Number(concurrency.value) }); const result = await client().createUser(name.value.trim()); name.value = ''; reveal(result); await refresh(); }), rows, issued);
  panel.append(node('summary', '用户绑定与数据归属'), status, button('刷新用户', refresh), controls);
  panel.addEventListener('toggle', () => { if (!panel.open) clear(); else refresh().catch(e => { controls.hidden = true; status.textContent = e.status === 404 ? '此服务器尚未支持用户绑定。' : '请先登录服务器。'; }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  return panel;
}
