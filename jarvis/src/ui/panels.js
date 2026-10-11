/**
 * 右侧面板：工作区 / 知识库 / 记忆与进化 / 模型。
 */
import * as ws from '../agent/workspace.js';
import * as kb from '../agent/knowledge.js';
import * as memory from '../agent/memory.js';
import { parseFile, htmlDocument } from '../agent/docs.js';
import { fmtSize } from '../agent/tools.js';
import { renderBlocks } from './transcript.js';
import { PROVIDERS, providerById, loadConfig, saveConfig, modelOf, createAdapter } from '../llm/config.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
};

export function initPanels({ toast, getGateway, onConfigChange, getHistory, onClearHistory, onPersistChange, settings }) {
  const fresh = new Set();
  let current = null; // 当前预览的文件
  let objectUrls = [];

  // ================================================================ 工作区
  async function refreshFiles() {
    const list = $('#file-list');
    const mode = ws.mode();
    $('#ws-mode').textContent = mode === 'folder' ? `本地：${ws.folderName()}` : '浏览器内';
    $('#ws-mode').classList.toggle('on', mode === 'folder');
    const restore = await ws.restoreFolder().catch(() => null);
    const btn = $('#btn-folder');
    btn.hidden = !ws.canUseFolders();
    btn.textContent = mode === 'folder' ? '断开文件夹' : restore?.pending ? `恢复连接「${restore.pending}」` : '连接本地文件夹';
    btn.dataset.pending = restore?.pending ? '1' : '';
    let files;
    try { files = await ws.list(); } catch (e) { files = []; toast(`读取工作区失败：${e.message}`); }
    list.replaceChildren(...(files.length ? files.map((f) => {
      const li = el('li', { title: f.path },
        el('span', { className: 'fx', textContent: ws.ext(f.path) || '—' }),
        el('span', { className: 'fn', textContent: f.path }),
        el('span', { className: 'fs', textContent: fmtSize(f.size) }));
      if (fresh.has(f.path)) li.classList.add('fresh');
      if (current === f.path) li.classList.add('active');
      li.addEventListener('click', () => openFile(f.path));
      if (mode === 'virtual') {
        const x = el('button', { type: 'button', className: 'x-btn', title: '删除', textContent: '✕' });
        x.addEventListener('click', async (e) => {
          e.stopPropagation();
          await ws.removeVirtual(f.path);
          if (current === f.path) { current = null; $('#viewer').hidden = true; }
          refreshFiles();
        });
        li.append(x);
      }
      return li;
    }) : [el('li', { className: 'empty', textContent: '还没有文件。让我“写一个网页”或“生成一份 PPT”，或者上传文件。' })]));
  }

  $('#btn-folder').addEventListener('click', async () => {
    try {
      if (ws.mode() === 'folder') { await ws.disconnectFolder(); toast('已断开本地文件夹'); }
      else if ($('#btn-folder').dataset.pending) { const r = await ws.restoreFolder({ prompt: true }); toast(typeof r === 'string' ? `已连接「${r}」` : '没有获得授权'); }
      else toast(`已连接「${await ws.connectFolder()}」：我现在可以读写这个文件夹了`);
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message);
    }
    refreshFiles();
  });

  /** 网页预览：把同目录引用的 css / js 内联进去，在无同源权限的沙箱 iframe 里运行 */
  async function inlineAssets(path, html) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const resolve = (ref) => { try { return ws.normalize(dir + ref); } catch { return null; } };
    const replaceAsync = async (str, re, fn) => {
      const parts = [];
      let last = 0;
      for (const m of str.matchAll(re)) { parts.push(str.slice(last, m.index), await fn(...m)); last = m.index + m[0].length; }
      parts.push(str.slice(last));
      return parts.join('');
    };
    html = await replaceAsync(html, /<link\b[^>]*href=["'](?!https?:|\/\/)([^"']+\.css)["'][^>]*>/gi, async (m, ref) => {
      const p = resolve(ref);
      return p && (await ws.exists(p)) ? `<style>${await ws.readText(p)}</style>` : m;
    });
    html = await replaceAsync(html, /<script\b([^>]*)src=["'](?!https?:|\/\/)([^"']+\.m?js)["']([^>]*)><\/script>/gi, async (m, a, ref, b) => {
      const p = resolve(ref);
      return p && (await ws.exists(p)) ? `<script${a}${b}>${(await ws.readText(p)).replace(/<\/script/gi, '<\\/script')}</script>` : m;
    });
    return html;
  }

  async function openFile(path) {
    current = path;
    fresh.delete(path);
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];
    const body = $('#viewer-body');
    $('#viewer').hidden = false;
    $('#viewer-name').textContent = path;
    body.replaceChildren(el('pre', { textContent: '读取中…' }));
    const e = ws.ext(path);
    $('#btn-v-pdf').hidden = !['html', 'htm', 'md'].includes(e);
    $('#btn-v-open').hidden = !['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e);
    try {
      const blob = await ws.readBlob(path);
      if (e === 'html' || e === 'htm') {
        body.replaceChildren(el('iframe', { sandbox: 'allow-scripts allow-forms allow-modals', srcdoc: await inlineAssets(path, await blob.text()), title: path }));
      } else if (e === 'md') {
        const div = el('div', { className: 'msg agent' });
        const inner = el('div', { className: 'body' });
        renderBlocks(inner, await blob.text());
        div.append(inner);
        body.replaceChildren(div);
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) {
        const u = URL.createObjectURL(blob);
        objectUrls.push(u);
        body.replaceChildren(el('img', { src: u, alt: path }));
      } else if (ws.isText(path)) {
        body.replaceChildren(el('pre', { textContent: await blob.text() }));
      } else {
        body.replaceChildren(el('pre', { textContent: (await parseFile(blob, path)).text }));
      }
    } catch (err) {
      body.replaceChildren(el('pre', { textContent: `无法预览：${err.message}` }));
    }
    $('#panel').scrollTop = 0;
    refreshFiles();
  }

  async function download(path) {
    const blob = await ws.readBlob(path);
    const u = URL.createObjectURL(blob);
    const a = el('a', { href: u, download: path.split('/').pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  }

  $('#btn-v-download').addEventListener('click', () => current && download(current).catch((e) => toast(e.message)));
  $('#btn-v-open').addEventListener('click', async () => {
    if (!current) return;
    let blob = await ws.readBlob(current);
    if (/\.html?$/i.test(current)) blob = new Blob([await inlineAssets(current, await blob.text())], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  });
  // 导出 PDF：在无脚本的隐藏 iframe 里排版后调用浏览器打印（选“另存为 PDF”）
  $('#btn-v-pdf').addEventListener('click', async () => {
    if (!current) return;
    let html = await ws.readText(current);
    if (/\.md$/i.test(current)) html = htmlDocument(current.replace(/^.*\/|\.md$/g, ''), html, { printable: true });
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const frame = el('iframe', { sandbox: 'allow-modals allow-same-origin', srcdoc: html, style: 'position:fixed;width:0;height:0;border:0;opacity:0' });
    frame.addEventListener('load', () => {
      try { frame.contentWindow.print(); } catch { toast('浏览器阻止了打印，请用“新窗口打开”后按 Ctrl+P'); }
      setTimeout(() => frame.remove(), 60000);
    });
    document.body.append(frame);
  });
  $('#btn-v-kb').addEventListener('click', async () => {
    if (!current) return;
    try {
      const blob = await ws.readBlob(current);
      const text = ws.isText(current) && !/\.html?$/i.test(current) ? await blob.text() : (await parseFile(blob, current)).text;
      const d = await kb.addDocument({ name: current.split('/').pop(), text, source: 'workspace' });
      toast(`已加入知识库：${d.name}（${d.chunks} 段）`);
      refreshKb();
      refreshMind();
    } catch (e) { toast(e.message); }
  });

  $('#btn-upload').addEventListener('click', () => $('#file-input').click());

  // ================================================================ 知识库
  async function importToKb(files) {
    for (const f of files) {
      try {
        toast(`正在解析 ${f.name}…`);
        const { text } = await parseFile(f, f.name);
        const d = await kb.addDocument({ name: f.name, text });
        toast(`已加入知识库：${d.name}（${d.chunks} 段）`);
      } catch (e) { toast(`${f.name}：${e.message}`); }
    }
    refreshKb();
    refreshMind();
  }
  async function refreshKb() {
    const docs = await kb.listDocuments();
    $('#kb-count').textContent = `${docs.length} 份`;
    $('#kb-list').replaceChildren(...(docs.length ? docs.map((d) => {
      const x = el('button', { type: 'button', className: 'x-btn', title: '移出知识库', textContent: '✕' });
      x.addEventListener('click', async () => { await kb.removeDocument(d.id); refreshKb(); refreshMind(); });
      return el('li', {}, el('span', { className: 'fn', textContent: d.name, title: d.name }), el('span', { className: 'fs', textContent: `${d.chunks} 段 · ${(d.chars / 1000).toFixed(1)}k 字` }), x);
    }) : [el('li', { className: 'empty', textContent: '知识库还是空的。导入你的资料后，回答会引用这些内容并注明出处。' })]));
  }
  $('#kb-input').addEventListener('change', (e) => { importToKb([...e.target.files]); e.target.value = ''; });
  const drop = $('#kb-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); importToKb([...e.dataTransfer.files]); });
  $('#kb-query').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const hits = await kb.search(e.target.value, 5, 0.1);
    $('#kb-hits').replaceChildren(...(hits.length ? hits.map((h) => el('li', {}, el('b', { textContent: `${h.name} · 相关度 ${h.score.toFixed(1)}` }), el('div', { textContent: h.text.slice(0, 160) }))) : [el('li', { textContent: '没有找到相关内容' })]));
  });

  // ================================================================ 记忆与进化
  let mindTab = 'memories';
  async function refreshMind() {
    const [all, docs] = await Promise.all([memory.listAll(), kb.listDocuments()]);
    const tasks = all.events.filter((e) => e.kind === 'task').length;
    const lv = memory.levelOf({ memories: all.memories.length, lessons: all.lessons.length, skills: all.skills.length, docs: docs.length, tasks });
    $('#level-num').textContent = lv.level;
    $('#level-bar').style.width = `${Math.round(lv.progress * 100)}%`;
    $('#mind-level').textContent = `LV ${lv.level} · ${lv.xp} XP`;
    $('#level-chip').title = `进化等级 ${lv.level}：经验 ${lv.xp} / ${lv.next}`;
    $('#evo-stats').replaceChildren(...[['记忆', all.memories.length], ['技能', all.skills.length], ['教训', all.lessons.length], ['知识文档', docs.length], ['完成任务', tasks], ['下一级', `${lv.next - lv.xp} XP`]]
      .map(([k, v]) => el('div', {}, el('b', { textContent: v }), el('span', { textContent: k }))));
    drawRing(lv);
    const list = $('#mind-list');
    $('#history-actions').hidden = mindTab !== 'history';
    const del = (kind, id) => {
      const x = el('button', { type: 'button', className: 'x-btn', title: '删除', textContent: '✕' });
      x.addEventListener('click', async () => { await memory.deleteItem(kind, id); refreshMind(); });
      return x;
    };
    const when = (ts) => new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    let items = [];
    if (mindTab === 'memories') items = all.memories.map((m) => el('li', {}, el('span', { className: 'tag', textContent: { preference: '偏好', profile: '身份', fact: '事实' }[m.category] ?? '其他' }), el('span', { className: 'fn', textContent: m.content }), el('span', { className: 'fs', textContent: when(m.ts) }), del('memories', m.id)));
    else if (mindTab === 'skills') items = all.skills.map((s) => el('li', {}, el('span', { className: 'tag', textContent: `v${s.version}` }), el('details', {}, el('summary', { textContent: s.name }), el('pre', { textContent: `${s.description ? `${s.description}\n\n` : ''}${s.steps}` })), del('skills', s.id)));
    else if (mindTab === 'lessons') items = all.lessons.map((l) => el('li', {}, el('span', { className: 'fn', textContent: l.content }), el('span', { className: 'fs', textContent: when(l.ts) }), del('lessons', l.id)));
    else if (mindTab === 'events') items = all.events.slice(0, 80).map((e) => el('li', {}, el('span', { className: 'fs', textContent: new Date(e.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }), el('span', { className: 'fn', textContent: e.text })));
    else if (mindTab === 'history') items = getHistory().slice(-40).reverse().map((m) => el('li', {}, el('span', { className: 'tag', textContent: m.role === 'user' ? '你' : '贾维斯' }), el('span', { className: 'fn', textContent: m.content.slice(0, 120) })));
    const emptyText = { memories: '还没有记忆。告诉我“记住我喜欢……”，或者在对话中透露你的偏好。', skills: '还没有技能。完成多步任务后，我会把可复用的做法存成技能。', lessons: '还没有教训。对不满意的回答点 👎 并说明原因，我会记住。', events: '还没有进化记录。', history: '还没有对话。' }[mindTab];
    list.replaceChildren(...(items.length ? items : [el('li', { className: 'empty', textContent: emptyText })]));
  }
  function drawRing(lv) {
    const c = $('#evo-ring');
    const g = c.getContext('2d');
    const dpr = 2;
    c.width = c.height = 112 * dpr;
    g.scale(dpr, dpr);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#38bdf8';
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(56, 56, 46, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = accent;
    g.shadowColor = accent; g.shadowBlur = 10;
    g.beginPath(); g.arc(56, 56, 46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, lv.progress)); g.stroke();
    g.shadowBlur = 0;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      g.strokeStyle = i % 4 ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.3)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(56 + Math.cos(a) * 36, 56 + Math.sin(a) * 36); g.lineTo(56 + Math.cos(a) * 39, 56 + Math.sin(a) * 39); g.stroke();
    }
    g.fillStyle = '#d9e7f2';
    g.font = '600 26px "Chakra Petch", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(lv.level), 56, 52);
    g.font = '10px "Chakra Petch", sans-serif';
    g.fillStyle = '#7a92a6';
    g.fillText('LEVEL', 56, 72);
  }
  for (const b of document.querySelectorAll('[data-mtab]')) {
    b.addEventListener('click', () => {
      mindTab = b.dataset.mtab;
      for (const x of document.querySelectorAll('[data-mtab]')) x.setAttribute('aria-selected', String(x === b));
      refreshMind();
    });
  }
  $('#set-persist').addEventListener('change', (e) => onPersistChange(e.target.checked));
  $('#btn-clear-memory').addEventListener('click', () => { onClearHistory(); refreshMind(); });

  // ================================================================ 模型
  let cfg = loadConfig();
  const sel = $('#llm-provider');
  sel.replaceChildren(...PROVIDERS.map((p) => el('option', { value: p.id, textContent: p.name })));
  function fillModels() {
    const p = providerById(sel.value);
    const gw = getGateway();
    $('#gw-badge').textContent = window.jarvisDesktop ? '桌面版' : gw ? (gw.cors ? '单文件版 · 已连网关' : '本机网关') : '单文件版';
    $('#gw-badge').classList.toggle('on', Boolean(gw));
    $('#llm-model').value = cfg.models[p.id] || p.models[0] || '';
    $('#llm-models').replaceChildren(...p.models.filter(Boolean).map((m) => el('option', { value: m })));
    $('#row-base').hidden = !p.custom;
    $('#llm-base').value = cfg.baseURLs.custom || '';
    $('#row-key').hidden = p.kind === 'mock';
    $('#llm-key').value = cfg.keys[p.id] || '';
    const gwKey = gw?.keys?.includes(p.id);
    $('#llm-key-hint').replaceChildren(...(p.kind === 'mock' ? ['无需密钥，离线可用。能演示写网页、生成文档、记忆、知识库等完整流程，但“理解力”是规则写死的。']
      : [gwKey ? '本机网关已配置该服务商的密钥，这里可以留空。' : p.needsKey === false ? '本机模型无需密钥。' : '', p.keyUrl ? el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener', textContent: ' 获取密钥 →' }) : '']));
    const notes = [];
    const fix = '解决：双击 jarvis 文件夹里的 启动.bat（Mac / Linux 运行 start.sh）并保持窗口开着，这个页面会自动连上本机网关，经它转发就不受限制了。';
    if (!gw && p.custom) notes.push(`很多中转 / 自建接口不允许网页直接调用（跨域限制），会显示“Failed to fetch”。${fix}`);
    if (!gw && p.browser === false) notes.push(`该服务商不允许网页直接调用（跨域限制）。${fix}`);
    if (p.note) notes.push(p.note);
    $('#llm-note').hidden = !notes.length;
    $('#llm-note').textContent = notes.join(' ');
    $('#llm-status').textContent = '';
  }
  sel.value = cfg.provider;
  fillModels();
  sel.addEventListener('change', fillModels);
  function collect() {
    const id = sel.value;
    cfg = { ...cfg, provider: id, models: { ...cfg.models, [id]: $('#llm-model').value.trim() }, keys: { ...cfg.keys, [id]: $('#llm-key').value.trim() } };
    if (providerById(id).custom) cfg.baseURLs = { ...cfg.baseURLs, custom: $('#llm-base').value.trim() };
    return cfg;
  }
  $('#btn-llm-save').addEventListener('click', () => {
    saveConfig(collect());
    onConfigChange(cfg);
    toast(`已切换到 ${providerById(cfg.provider).name} · ${modelOf(cfg)}`);
  });
  $('#btn-llm-test').addEventListener('click', async () => {
    const status = $('#llm-status');
    const c = collect();
    const { adapter, model, problem } = createAdapter(c, { gateway: getGateway() });
    if (problem) { status.textContent = problem; return; }
    status.textContent = '正在连接…';
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      let out = '';
      await adapter.stream({ model, system: ['你是连接测试。只回复：连接成功', ''], messages: [{ role: 'user', content: 'ping' }], tools: [], signal: ctrl.signal, onText: (d) => { out += d; } });
      status.textContent = `连接成功（${Math.round(performance.now() - t0)}ms）：${out.replace(/<emotion>[^<]*<\/emotion>/, '').slice(0, 40)}`;
    } catch (e) {
      status.textContent = `连接失败：${e.name === 'AbortError' ? '超时' : e.message}${/Failed to fetch|NetworkError|CORS/i.test(e.message) ? '（多半是跨域限制：双击 启动.bat 并保持窗口开着，本页面会自动连上本机网关）' : ''}`;
    } finally { clearTimeout(timer); }
  });
  $('#set-websearch').checked = cfg.claudeWebSearch;
  $('#set-websearch').addEventListener('change', (e) => { cfg = { ...cfg, claudeWebSearch: e.target.checked }; saveConfig(cfg); onConfigChange(cfg); });
  $('#tavily-key').value = cfg.tavilyKey || '';
  $('#tavily-key').addEventListener('change', (e) => { cfg = { ...cfg, tavilyKey: e.target.value.trim() }; saveConfig(cfg); onConfigChange(cfg); });
  $('#set-persist').checked = settings.persistMemory;

  return {
    refreshFiles,
    openFile,
    markFresh(path) { fresh.add(path); },
    refreshKb,
    refreshMind,
    importToKb,
    refreshModels: fillModels,
    get config() { return cfg; },
    /** 其他面板（如语音）修改配置：统一保存并通知 */
    patchConfig(fn) { cfg = fn(cfg); saveConfig(cfg); onConfigChange(cfg); return cfg; }
  };
}
