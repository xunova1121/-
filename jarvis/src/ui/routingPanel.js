/**
 * “模型”面板高级区的两个开关：日常对话少想一点、主模型慢时同时问备用模型。
 * 旧的“模型分工”界面已去掉（和“每项能力用哪个模型”冲突）。
 */
const $ = (s) => document.querySelector(s);

/** 测一个模型的首字时间（毫秒） */
export async function measureFirstToken(adapter, model, { timeoutMs = 45000, now = () => performance.now() } = {}) {
  const t0 = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let first = 0;
  try {
    await adapter.stream({
      model, effort: 'low', tools: [], signal: ctrl.signal,
      system: ['只回复一个字：好', ''], messages: [{ role: 'user', content: '测速' }],
      onText: () => { if (!first) { first = now(); ctrl.abort(); } }
    });
  } catch (e) {
    if (!first) throw e.name === 'AbortError' ? new Error('超时') : e;
  } finally { clearTimeout(timer); }
  return Math.round((first || now()) - t0);
}

export function initRoutingPanel({ getConfig, patchConfig, toast, patchServer }) {
  // 旧的“模型分工”（按每句话内容切模型）和模型中心的“每项能力用哪个模型”管同一件事，用户 2026-10-30 说冲突、要去掉：
  // 界面已删，每句话用哪个模型只在能力表里设；能力表设过的项优先（见 router.js routeFor）
  function render() {
    const cfg = getConfig();
    $('#fast-chat').checked = cfg.fastChat !== false;
    $('#hedge-backup').checked = cfg.hedgeBackup !== false;
  }

  $('#fast-chat').addEventListener('change', () => patchConfig((c) => ({ ...c, fastChat: $('#fast-chat').checked })));
  $('#hedge-backup').addEventListener('change', () => {
    patchConfig((c) => ({ ...c, hedgeBackup: $('#hedge-backup').checked }));
    // 服务器模式：服务器上的任务也照这个开关
    patchServer?.({ hedgeBackup: $('#hedge-backup').checked })?.catch?.(() => toast('服务器上的设置没改成，稍后再试'));
  });

  render();
  return { render };
}
