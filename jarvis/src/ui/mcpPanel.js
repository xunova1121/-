/**
 * “技能”面板里的 MCP 连接：添加 / 编辑 / 启停 / 重连 / 删除 MCP 服务，查看每个服务提供的工具。
 * 只在有本机网关（完整版或桌面版）时可用——MCP 服务要在本机启动程序。
 */
import * as mcp from '../agent/mcpClient.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/** 常用 MCP 服务（命令需要电脑上装有 Node.js；uvx 需要装 uv） */
export const MCP_PRESETS = [
  { id: 'filesystem', name: '文件系统', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{{文件夹}}'], desc: '读写指定文件夹（把最后一个参数改成你的文件夹路径）' },
  { id: 'browser', name: '浏览器自动化', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], desc: '打开网页、点击、填表、截图（Playwright）' },
  { id: 'memory', name: '知识图谱记忆', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], desc: '以实体-关系的形式长期记忆' },
  { id: 'thinking', name: '分步思考', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], desc: '复杂问题拆成步骤逐步推理' },
  { id: 'amap', name: '高德地图', type: 'stdio', command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'], env: { AMAP_MAPS_API_KEY: '{{高德 Key}}' }, desc: '地点搜索、路线规划、天气（需高德开放平台 Key）' },
  { id: 'github', name: 'GitHub', type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {{GitHub Token}}' }, desc: '仓库、Issue、PR（需 GitHub 个人访问令牌）' },
  { id: 'fetch', name: '网页抓取', type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], desc: '抓取网页并转成 Markdown（需安装 uv）' }
];

const STATUS = { ready: ['已连接', 'ok'], connecting: ['连接中…', 'wait'], error: ['连接失败', 'bad'], off: ['已停用', 'off'] };

/** “a b 'c d'” → ['a', 'b', 'c d']（每行一个参数也可以） */
export function parseArgs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}
/** “KEY=VALUE” 或 “Key: Value”，每行一个 */
export function parsePairs(text, sep) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

/**
 * @param {{ getGateway: () => object|null, toast: (t: string) => void, onChange?: (servers: any[]) => void }} o
 */
export function initMcpPanel({ getGateway, toast, onChange }) {
  const root = $('#mcp-section');
  let servers = [];
  let editing = null;
  let polling = null;

  async function refresh() {
    const gw = getGateway();
    $('#mcp-unavailable').hidden = Boolean(gw?.mcp);
    $('#mcp-body').hidden = !gw?.mcp;
    if (!gw?.mcp) return;
    try {
      const r = await mcp.listServers(gw.origin);
      servers = r.servers;
      $('#mcp-config-path').textContent = r.configPath;
    } catch (e) {
      $('#mcp-status').textContent = `读取失败：${e.message}`;
      return;
    }
    render();
    onChange?.(servers);
    // 有服务在连接中时，每 2 秒刷新一次状态
    clearTimeout(polling);
    if (servers.some((s) => s.status === 'connecting')) polling = setTimeout(refresh, 2000);
  }

  function render() {
    const list = $('#mcp-list');
    list.replaceChildren(...(servers.length ? servers.map(card) : [el('li', { className: 'empty', textContent: '还没有连接 MCP 服务。从下方常用服务里添加一个试试。' })]));
    const ready = servers.filter((s) => s.status === 'ready');
    $('#mcp-count').textContent = `${ready.length} 个已连接 · ${ready.reduce((n, s) => n + s.tools.length, 0)} 个工具`;
    $('#mcp-presets').replaceChildren(...MCP_PRESETS.map((p) => {
      const b = el('button', { type: 'button', className: 'btn ghost sm', textContent: `+ ${p.name}`, title: p.desc, disabled: servers.some((s) => s.id === p.id) });
      b.addEventListener('click', () => openForm({ ...p }));
      return b;
    }), (() => {
      const b = el('button', { type: 'button', className: 'btn ghost sm', textContent: '+ 自定义' });
      b.addEventListener('click', () => openForm({ id: '', name: '', type: 'stdio', command: '', args: [] }));
      return b;
    })());
  }

  function card(s) {
    const [label, cls] = STATUS[s.status] ?? STATUS.off;
    const toggle = el('input', { type: 'checkbox', checked: s.enabled, title: s.enabled ? '停用' : '启用' });
    toggle.addEventListener('change', () => save({ ...s, enabled: toggle.checked }));
    const auto = el('input', { type: 'checkbox', checked: s.autoApprove });
    auto.addEventListener('change', () => save({ ...s, autoApprove: auto.checked }, false));
    const tools = el('details', { className: 'mcp-tools' }, el('summary', { textContent: `${s.tools.length} 个工具` }),
      el('ul', {}, ...s.tools.map((t) => el('li', {}, el('code', { textContent: t.name }), el('span', { textContent: t.description.split('\n')[0].slice(0, 120) })))));
    const btn = (text, fn, extra = '') => { const b = el('button', { type: 'button', className: `btn ghost sm ${extra}`, textContent: text }); b.addEventListener('click', fn); return b; };
    const del = btn('删除', async () => {
      if (del.dataset.c !== '1') { del.dataset.c = '1'; del.textContent = '确认删除'; setTimeout(() => { del.dataset.c = ''; del.textContent = '删除'; }, 3000); return; }
      await mcp.removeServer(getGateway().origin, s.id);
      toast(`已删除 MCP 服务：${s.name}`);
      refresh();
    }, 'danger');
    return el('li', { className: `mcp-server ${cls}` },
      el('div', { className: 'skill-top' },
        el('label', { className: 'switch', title: '启用 / 停用' }, toggle, el('span')),
        el('strong', { textContent: s.name }),
        el('span', { className: `mcp-dot ${cls}`, textContent: label })),
      el('code', { className: 'mcp-cmd', textContent: s.type === 'http' ? s.url : [s.command, ...s.args].map(quote).join(' ') }),
      s.status === 'error' ? el('p', { className: 'mcp-error', textContent: s.error }) : null,
      s.tools.length ? tools : null,
      el('div', { className: 'skill-actions' },
        el('label', { className: 'inline-check small', title: '不勾选时，每次调用前都会在对话里询问你' }, auto, ' 自动允许调用'),
        btn('重连', async () => { await mcp.restartServer(getGateway().origin, s.id).catch((e) => toast(e.message)); refresh(); }),
        btn('编辑', () => openForm({ ...s })),
        del));
  }

  async function save(s, reconnect = true) {
    const gw = getGateway();
    $('#mcp-status').textContent = reconnect && s.enabled ? `正在连接「${s.name}」…（首次用 npx 启动需要下载，可能要一分钟）` : '';
    try {
      const r = await mcp.saveServer(gw.origin, s);
      $('#mcp-status').textContent = r.status === 'ready' ? `「${r.name}」已连接，提供 ${r.tools.length} 个工具` : r.status === 'error' ? `「${r.name}」连接失败：${r.error}` : '';
      return r;
    } catch (e) {
      $('#mcp-status').textContent = `保存失败：${e.message}`;
      return null;
    } finally {
      refresh();
    }
  }

  // ------------------------------------------------------------ 表单
  const form = $('#mcp-form');
  function openForm(s) {
    editing = s;
    form.hidden = false;
    form.querySelector('[name=name]').value = s.name || '';
    form.querySelector('[name=type]').value = s.type || 'stdio';
    form.querySelector('[name=command]').value = s.command || '';
    form.querySelector('[name=args]').value = (s.args || []).map(quote).join(' ');
    form.querySelector('[name=env]').value = Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    form.querySelector('[name=url]').value = s.url || '';
    form.querySelector('[name=headers]').value = Object.entries(s.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    $('#mcp-form-title').textContent = s.id && servers.some((x) => x.id === s.id) ? `编辑：${s.name}` : `添加：${s.name || '自定义服务'}`;
    $('#mcp-form-desc').textContent = s.desc || '';
    syncType();
    form.querySelector('[name=name]').focus();
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function syncType() {
    const http = form.querySelector('[name=type]').value === 'http';
    for (const n of form.querySelectorAll('[data-for=stdio]')) n.hidden = http;
    for (const n of form.querySelectorAll('[data-for=http]')) n.hidden = !http;
  }
  form.querySelector('[name=type]').addEventListener('change', syncType);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = (n) => form.querySelector(`[name=${n}]`).value;
    const s = {
      id: editing?.id || f('name'),
      name: f('name').trim(),
      type: f('type'),
      command: f('command').trim(),
      args: parseArgs(f('args')),
      env: parsePairs(f('env'), '='),
      url: f('url').trim(),
      headers: parsePairs(f('headers'), ':'),
      enabled: true,
      autoApprove: editing?.autoApprove ?? false
    };
    const placeholder = JSON.stringify(s).match(/\{\{([^}]+)\}\}/);
    if (placeholder) { $('#mcp-status').textContent = `请先把「{{${placeholder[1]}}}」替换成实际内容`; return; }
    const r = await save(s);
    if (r) form.hidden = true;
  });
  $('#mcp-cancel').addEventListener('click', () => { form.hidden = true; });

  return { refresh, get servers() { return servers; } };
}
