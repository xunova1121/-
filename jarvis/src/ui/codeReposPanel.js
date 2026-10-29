import { createServerClient, loadServerSettings, normalizeUrl } from '../core/serverClient.js';

/** 凭据只经已登录服务器保存；不进模型设置、浏览器存储或提示消息。 */
export function initCodeReposPanel() {
  const host = document.querySelector('#row-server');
  if (!host || document.querySelector('#code-repos-panel')) return;
  const panel = document.createElement('details');
  panel.id = 'code-repos-panel';
  panel.className = 'set-more';
  // 全部为固定文案；服务器返回内容只赋给value/textContent。
  panel.innerHTML = `<summary>代码仓库 · GitHub</summary>
    <div class="setting"><div class="sync-form">
      <p class="muted">连接后可在对话里读取、搜索仓库。每个任务使用独立工作副本，默认分支始终受保护。</p>
      <label class="field" for="code-repo-name"><span>GitHub 仓库</span><input id="code-repo-name" placeholder="xunova1121/weiyang-code-sandbox" spellcheck="false" autocomplete="off" maxlength="140" /></label>
      <label class="field" for="code-repo-token"><span>访问令牌（公开仓库可留空）</span><input id="code-repo-token" type="password" autocomplete="off" spellcheck="false" maxlength="255" /></label>
      <p class="muted small">令牌仅存服务器。留空保留已存令牌；清除请先断开连接。当前仅开放只读工具。</p>
      <label><input type="checkbox" checked disabled /> 保护默认分支</label>
      <div class="pane-actions"><button class="btn" type="button" id="code-repo-save">验证并连接</button><button class="btn ghost sm" type="button" id="code-repo-disconnect">断开连接</button></div>
      <p class="muted small" id="code-repo-status" role="status"></p>
    </div></div>`;
  host.after(panel);
  const field = (id) => panel.querySelector('#' + id);
  const repo = field('code-repo-name'),
    key = field('code-repo-token');
  const line = field('code-repo-status'),
    save = field('code-repo-save'),
    disconnect = field('code-repo-disconnect');
  let busy = false;
  function client() {
    // 不采用尚未登录的“服务器网址”输入框，避免把GitHub令牌送到误填的新地址。
    const cfg = loadServerSettings();
    if (!cfg.enabled || !cfg.token) throw new Error('请先登录并开启服务器模式');
    const url = new URL(normalizeUrl(cfg.url));
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('代码仓库设置需要HTTPS服务器连接（本机调试除外）');
    return createServerClient({ base: url.href.replace(/\/$/, ''), token: cfg.token });
  }
  function show(value) {
    repo.value = value.repository || '';
    key.value = '';
    line.textContent = value.connected
      ? `已连接 ${value.repository} · 默认分支 ${value.defaultBranch} · ${value.tokenConfigured ? '已存令牌' : '公开只读'}；发任务时创建独立工作副本。`
      : '尚未连接仓库';
  }
  async function act(operation) {
    if (busy) return;
    busy = true;
    save.disabled = disconnect.disabled = true;
    try {
      await operation();
    } catch (error) {
      line.textContent = error.status === 404 ? '服务器尚不支持代码仓库设置，请更新服务器' : error.message;
    } finally {
      key.value = '';
      busy = false;
      save.disabled = disconnect.disabled = false;
    }
  }
  save.addEventListener('click', () =>
    act(async () => {
      const api = client();
      const value = { provider: 'github', repository: repo.value.trim(), token: key.value.trim(), protectDefaultBranch: true };
      key.value = '';
      line.textContent = '正在验证GitHub连接…';
      show(await api.connectCodeRepository(value));
    })
  );
  disconnect.addEventListener('click', () => act(async () => show(await client().disconnectCodeRepository())));
  panel.addEventListener('toggle', () => {
    if (panel.open) act(async () => show(await client().codeRepository()));
  });
}
