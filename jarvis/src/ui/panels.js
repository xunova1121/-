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
import { probeEndpoint } from '../llm/probe.js';
import { createSearch, searchEngines } from '../agent/webSearch.js';
import { saveFile } from './saveFile.js';
import { renderDocx } from './docxView.js';
import { MOBILE } from '../config.js';
import { initChangesPanel } from './changesPanel.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
};

export function initPanels({ toast, getGateway, onConfigChange, getHistory, settings, onReflect, onAutoMemory, searchFetch }) {
  const fresh = new Set();
  let current = null; // 当前预览的文件
  let objectUrls = [];

  // ================================================================ 工作区
  // 两个标签页：文件 / 改动记录（改文件前的自动备份，可一键恢复）
  let wsTab = 'files';
  const changes = initChangesPanel({ toast, desktop: globalThis.window?.jarvisDesktop ?? null, onRestored: () => refreshFiles() });
  for (const b of document.querySelectorAll('[data-wtab]')) {
    b.addEventListener('click', () => {
      wsTab = b.dataset.wtab;
      for (const x of document.querySelectorAll('[data-wtab]')) x.setAttribute('aria-selected', String(x === b));
      $('#file-list').hidden = wsTab !== 'files';
      $('#change-box').hidden = wsTab !== 'changes';
      if (wsTab === 'changes') changes.refresh();
    });
  }

  async function refreshFiles() {
    if (wsTab === 'changes') changes.refresh();
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

  let docxFit = null;
  addEventListener('resize', () => docxFit?.());
  async function openFile(path) {
    current = path;
    docxFit = null;
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
      } else if (e === 'docx') {
        // Word：按真实样式排版预览；解析失败（文件损坏等）退回纯文字
        const host = el('div', { className: 'docx-view' });
        body.replaceChildren(host);
        try {
          const view = await renderDocx(blob, host);
          docxFit = view.fit;
        } catch {
          body.replaceChildren(el('pre', { textContent: (await parseFile(blob, path)).text }));
        }
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
    const msg = await saveFile(await ws.readBlob(path), path.split('/').pop());
    if (MOBILE) toast(msg);
  }

  $('#btn-v-download').addEventListener('click', () => current && download(current).catch((e) => toast(e.message)));
  $('#btn-v-open').addEventListener('click', async () => {
    if (!current) return;
    let blob = await ws.readBlob(current);
    if (/\.html?$/i.test(current)) blob = new Blob([await inlineAssets(current, await blob.text())], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  });
  // 导出 PDF：桌面版直接转成 PDF 文件存进工作区；网页版和安卓在无脚本的隐藏 iframe 里排版后调用浏览器打印（选“另存为 PDF”）
  $('#btn-v-pdf').addEventListener('click', async () => {
    if (!current) return;
    let html = await ws.readText(current);
    if (/\.md$/i.test(current)) html = htmlDocument(current.replace(/^.*\/|\.md$/g, ''), html, { printable: true });
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const desktop = globalThis.window?.jarvisDesktop;
    if (desktop) {
      try {
        const { base64 } = await desktop.invoke('printToPdf', { html: await inlineAssets(current, html) });
        const w = await ws.write(current.replace(/\.(html?|md)$/i, '') + '.pdf', new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'application/pdf' }));
        toast(`已导出 ${w.path}`);
        refreshFiles();
      } catch (e) { toast(`导出 PDF 失败：${e.message}`); }
      return;
    }
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
    const { embeddings } = kb.knowledgeEngine();
    const pending = embeddings ? await kb.pendingEmbeddings() : 0;
    $('#kb-engine-text').textContent = embeddings
      ? `检索：关键词 + 语义（${embeddings.split(':').pop()}）`
      : '检索：仅关键词 · 填 OpenAI / 硅基流动密钥后可按意思检索';
    const btn = $('#btn-kb-reindex');
    btn.hidden = !pending;
    btn.textContent = `补算向量（${pending} 段）`;
  }
  $('#btn-kb-reindex').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const n = await kb.reindex({ onProgress: (done, total) => { btn.textContent = `补算中 ${done}/${total}`; } });
      toast(`已为 ${n} 段补算向量，现在可以按意思检索了`);
    } catch (err) { toast(`补算失败：${err.message}`); }
    btn.disabled = false;
    refreshKb();
  });
  $('#kb-input').addEventListener('change', (e) => { importToKb([...e.target.files]); e.target.value = ''; });
  const drop = $('#kb-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); importToKb([...e.dataTransfer.files]); });
  $('#kb-query').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const hits = await kb.search(e.target.value, 5, 0.1);
    $('#kb-hits').replaceChildren(...(hits.length ? hits.map((h) => el('li', {}, el('b', { textContent: `${h.name} · ${h.via?.join(' + ') ?? '关键词'}` }), el('div', { textContent: h.text.slice(0, 160) }))) : [el('li', { textContent: '没有找到相关内容' })]));
  });

  // ================================================================ 记忆与进化
  let mindTab = 'memories';
  async function refreshMind() {
    const [all, docs] = await Promise.all([memory.listAll(), kb.listDocuments()]);
    const tasks = all.events.filter((e) => e.kind === 'task').length;
    const lv = memory.levelOf({ memories: all.memories.length, lessons: all.lessons.length, skills: all.skills.length, docs: docs.length, tasks, episodes: all.episodes.length });
    $('#level-num').textContent = lv.level;
    $('#level-bar').style.width = `${Math.round(lv.progress * 100)}%`;
    $('#mind-level').textContent = `LV ${lv.level} · ${lv.xp} XP`;
    $('#level-chip').title = `进化等级 ${lv.level}：经验 ${lv.xp} / ${lv.next}`;
    $('#evo-stats').replaceChildren(...[['记忆', all.memories.length], ['对话片段', all.episodes.length], ['习得技能', all.skills.length], ['教训', all.lessons.length], ['知识文档', docs.length], ['下一级', `${lv.next - lv.xp} XP`]]
      .map(([k, v]) => el('div', {}, el('b', { textContent: v }), el('span', { textContent: k }))));
    drawRing(lv);
    // 核心记忆（正在编辑时不覆盖）
    for (const [id, key] of [['#core-human', 'human'], ['#core-persona', 'persona']]) if (document.activeElement !== $(id)) $(id).value = all.core[key];
    // 核心记忆里像注入指令的行：不放进提示，告诉用户是哪一行、为什么
    const flags = all.coreFlags ?? [];
    $('#core-flags').hidden = !flags.length;
    $('#core-flags').replaceChildren(...flags.map((f) => el('div', { textContent: `可疑，未使用（${f.why}）·${f.block === 'human' ? '关于你' : '未央的设定'}：“${f.line}”` })));
    const eng = memory.memoryEngine();
    $('#mem-engine').textContent = `整理：${eng.llm ? '大模型' : '本地规则'} · 检索：${eng.embeddings ? `关键词 + 语义（${eng.embeddings.split(':').pop()}）` : '关键词（填 OpenAI / 硅基流动密钥可启用语义检索）'}`;
    $('#set-automem').checked = settings.autoMemory !== false;
    const list = $('#mind-list');
    const del = (kind, id) => {
      const x = el('button', { type: 'button', className: 'x-btn', title: '删除', textContent: '✕' });
      x.addEventListener('click', async () => { await memory.deleteItem(kind, id); refreshMind(); });
      return x;
    };
    const when = (ts) => new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    const sus = (x) => (x.suspicious ? el('span', { className: 'tag sus', textContent: '可疑，未使用', title: `${x.suspicious}：不会交给模型，确认无害可忽略，否则请删除` }) : null);
    let items = [];
    if (mindTab === 'memories') items = all.memories.map(memoryRow);
    else if (mindTab === 'archived') items = all.archived.map((m) => el('li', { className: 'mem archived' }, el('span', { className: 'tag', textContent: memory.CATEGORIES[m.category] ?? '其他' }), el('span', { className: 'fn', textContent: m.content, title: m.archivedReason || (m.supersededBy ? '已被新版本取代' : '') }), el('span', { className: 'fs', textContent: m.supersededBy ? '已更新' : (m.archivedReason || '已归档') }), (() => {
      const r = el('button', { type: 'button', className: 'btn ghost sm', textContent: '恢复' });
      r.addEventListener('click', async () => { await memory.updateMemory(m.id, { validTo: null, archivedReason: undefined, supersededBy: undefined }); refreshMind(); });
      return r;
    })(), del('memories', m.id)));
    else if (mindTab === 'episodes') {
      items = all.episodes.map((e) => {
        const body = el('span', { className: 'fn wrap', title: (e.topics || []).join('、') }, e.summary);
        if (e.sessionId) {
          const link = el('button', { type: 'button', className: 'ep-link', textContent: `「${e.sessionTitle || '打开对话'}」`, title: '打开这段对话' });
          link.addEventListener('click', () => dispatchEvent(new CustomEvent('jarvis:open-session', { detail: e.sessionId })));
          body.append(' ', link);
        }
        for (const o of e.open ?? []) body.append(el('span', { className: 'ep-open', textContent: `待办：${o}` }));
        return el('li', {}, el('span', { className: 'fs', textContent: when(e.ts) }), sus(e), body, del('episodes', e.id));
      });
    }
    else if (mindTab === 'skills') items = all.skills.map((s) => el('li', {}, el('span', { className: 'tag', textContent: `v${s.version}` }), sus(s), el('details', {}, el('summary', { textContent: s.name }), el('pre', { textContent: `${s.description ? `${s.description}\n\n` : ''}${s.steps}` })), del('skills', s.id)));
    else if (mindTab === 'lessons') items = all.lessons.map((l) => el('li', {}, sus(l), el('span', { className: 'fn', textContent: l.content }), el('span', { className: 'fs', textContent: when(l.ts) }), del('lessons', l.id)));
    else if (mindTab === 'events') items = all.events.slice(0, 80).map((e) => el('li', {}, el('span', { className: 'fs', textContent: new Date(e.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }), el('span', { className: 'fn', textContent: e.text })));
    else if (mindTab === 'history') items = getHistory().slice(-40).reverse().map((m) => el('li', {}, el('span', { className: 'tag', textContent: m.role === 'user' ? '你' : '未央' }), el('span', { className: 'fn', textContent: m.content.slice(0, 120) })));
    const emptyText = { archived: '没有归档的记忆。被新说法取代、被要求忘记、或长期不用的记忆会出现在这里。', episodes: '还没有对话片段。每段对话停下来之后，我会写一段摘要，以后能想起“上次聊到哪”。', memories: '还没有记忆。告诉我“记住我喜欢……”，或者在对话中透露你的偏好。', skills: '还没有技能。完成多步任务后，我会把可复用的做法存成技能。', lessons: '还没有教训。对不满意的回答点 👎 并说明原因，我会记住。', events: '还没有进化记录。', history: '还没有对话。' }[mindTab];
    list.replaceChildren(...(items.length ? items : [el('li', { className: 'empty', textContent: emptyText })]));
  }
  /** 一条记忆：分类、内容（可编辑）、重要度星级、钉住、使用次数、更新历史 */
  function memoryRow(m) {
    const text = el('span', { className: 'fn wrap', textContent: m.content, title: m.history?.length ? `历史：\n${m.history.map((h) => `· ${h.content}`).join('\n')}` : '' });
    const stars = el('button', { type: 'button', className: 'mem-stars', title: '重要度（点击调整）', textContent: '★'.repeat(m.importance) + '☆'.repeat(5 - m.importance) });
    stars.addEventListener('click', async () => { await memory.updateMemory(m.id, { importance: (m.importance % 5) + 1 }); refreshMind(); });
    const pin = el('button', { type: 'button', className: `mem-pin${m.pinned ? ' on' : ''}`, title: m.pinned ? '取消钉住' : '钉住：每次对话都带上', textContent: '📌' });
    pin.addEventListener('click', async () => { await memory.updateMemory(m.id, { pinned: !m.pinned }); refreshMind(); });
    const edit = el('button', { type: 'button', className: 'x-btn', title: '编辑', textContent: '✎' });
    edit.addEventListener('click', () => {
      const input = el('input', { className: 'mem-edit', value: m.content });
      text.replaceWith(input);
      input.focus();
      const save = async () => { if (input.value.trim() && input.value.trim() !== m.content) await memory.updateMemory(m.id, { content: input.value.trim() }); refreshMind(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') refreshMind(); });
      input.addEventListener('blur', save);
    });
    const meta = [m.suspicious?`可疑，未使用（${m.suspicious}）`:m.pending?'待核实 · 不参与回答':'已生效',m.source||'来源未记录',new Date(m.updatedAt||m.ts).toLocaleString('zh-CN'),`版本 ${(m.history?.length||0)+1}`].join(' · ');
    const confirm = el('button',{type:'button',className:'btn sm',textContent:'核实并启用'});
    confirm.onclick=async()=>{await memory.confirmCandidate(m.id);refreshMind();};
    const x = el('button', { type: 'button', className: 'x-btn', title: '删除', textContent: '✕' });
    x.addEventListener('click', async () => { await memory.deleteItem('memories', m.id); refreshMind(); });
    return el('li', { className: `mem${m.pinned ? ' pinned' : ''}${m.suspicious ? ' suspicious' : ''}` },
      el('span', { className: 'tag', textContent: memory.CATEGORIES[m.category] ?? '其他' }),
      el('div', { className: 'mem-main' }, text, el('div', { className: 'mem-meta' }, stars, meta ? el('span', { textContent: meta }) : null),m.evidence?el('details',{},el('summary',{textContent:'查看来源原话'}),el('p',{textContent:m.evidence})):null),
      m.pending?confirm:pin, edit, x);
  }

  $('#btn-core-save').addEventListener('click', async () => {
    await memory.setCore('human', $('#core-human').value);
    await memory.setCore('persona', $('#core-persona').value);
    refreshMind(); // 更新可疑行提示
    $('#core-status').textContent = '已保存';
    setTimeout(() => { $('#core-status').textContent = ''; }, 2000);
  });
  $('#set-automem').addEventListener('change', (e) => onAutoMemory?.(e.target.checked));
  $('#btn-reflect').addEventListener('click', async () => { await onReflect?.(); refreshMind(); });
  $('#btn-mem-export').addEventListener('click', async () => {
    const data = await memory.exportAll();
    const msg = await saveFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `未央记忆备份-${new Date().toISOString().slice(0, 10)}.json`);
    if (MOBILE) toast(msg);
  });
  $('#btn-mem-import').addEventListener('click', () => $('#mem-import-input').click());
  $('#mem-import-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await memory.importAll(JSON.parse(await f.text()));
      toast(`已导入：记忆 ${r.memories} 条、技能 ${r.skills} 个、教训 ${r.lessons} 条、对话片段 ${r.episodes} 段`);
      refreshMind();
    } catch (err) { toast(`导入失败：${err.message}`); }
  });

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

  // ================================================================ 模型
  let cfg = loadConfig();
  const sel = $('#llm-provider');
  sel.replaceChildren(...PROVIDERS.map((p) => el('option', { value: p.id, textContent: p.name })));
  function fillModels() {
    const p = providerById(sel.value);
    const gw = getGateway();
    $('#gw-badge').textContent = MOBILE ? '手机 App' : window.jarvisDesktop ? '桌面版' : gw ? (gw.cors ? '单文件版 · 已连网关' : '本机网关') : '单文件版';
    $('#gw-badge').classList.toggle('on', Boolean(gw));
    $('#llm-model').value = cfg.models[p.id] || p.models[0] || '';
    $('#llm-models').replaceChildren(...p.models.filter(Boolean).map((m) => el('option', { value: m })));
    $('#row-base').hidden = !p.custom;
    $('#llm-base').value = cfg.baseURLs[cfg.provider] || '';
    $('#row-key').hidden = p.kind === 'mock';
    $('#llm-key').value = cfg.keys[p.id] || '';
    const gwKey = gw?.keys?.includes(p.id);
    $('#llm-key-hint').replaceChildren(...(p.kind === 'mock' ? ['无需密钥，离线可用。能演示写网页、生成文档、记忆、知识库等完整流程，但“理解力”是规则写死的。']
      : [gwKey ? '本机网关已配置该服务商的密钥，这里可以留空。' : p.needsKey === false ? '本机模型无需密钥。' : '', p.keyUrl ? el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener', textContent: ' 获取密钥 →' }) : '']));
    const notes = [];
    const fix = '解决：双击 jarvis 文件夹里的 启动.bat（Mac / Linux 运行 start.sh）并保持窗口开着，这个页面会自动连上本机网关，经它转发就不受限制了。';
    if (!gw && !MOBILE && p.custom) notes.push(`很多中转 / 自建接口不允许网页直接调用（跨域限制），会显示“Failed to fetch”。${fix}`);
    if (!gw && !MOBILE && p.browser === false) notes.push(`该服务商不允许网页直接调用（跨域限制）。${fix}`);
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
    if (providerById(id).custom) cfg.baseURLs = { ...cfg.baseURLs, [id]: $('#llm-base').value.trim() };
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
    const p = providerById(c.provider);
    const via = () => (MOBILE && globalThis.__jarvisNetVia?.(c.baseURLs[p.id] || p.baseURL) === 'native' ? '（经手机系统网络）' : '');
    // 第一步：不经网关直连的 OpenAI 兼容接口，先查 /models，把网络 / 地址 / 密钥 / 型号问题分开说清楚
    const direct = p.kind === 'openai' && !getGateway();
    if (direct && p.kind === 'openai' && (p.custom ? c.baseURLs[p.id] : p.baseURL)) {
      status.textContent = '第 1 步：检查接口地址和密钥…';
      const r = await probeEndpoint({ baseURL: p.custom ? c.baseURLs[p.id] : p.baseURL, apiKey: c.keys[p.id] || '', model, phone: MOBILE });
      if (!r.ok && r.step !== 'model') { status.textContent = `连接失败：${r.message}${via()}`; return; }
      status.textContent = `${r.message}${via()}。第 2 步：让模型回一句话…`;
      if (r.step === 'model') status.textContent = `注意：${r.message}。仍然试一下对话…`;
    } else status.textContent = '正在连接…';
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      let out = '';
      await adapter.stream({ model, system: ['你是连接测试。只回复：连接成功', ''], messages: [{ role: 'user', content: 'ping' }], tools: [], signal: ctrl.signal, onText: (d) => { out += d; } });
      status.textContent = `连接成功（${Math.round(performance.now() - t0)}ms）${via()}：${out.replace(/<emotion>[^<]*<\/emotion>/, '').slice(0, 40)}`;
    } catch (e) {
      const cors = !MOBILE && /Failed to fetch|NetworkError|CORS/i.test(e.message) ? '（多半是跨域限制：双击 启动.bat 并保持窗口开着，本页面会自动连上本机网关）' : '';
      status.textContent = `连接失败：${e.name === 'AbortError' ? '模型 60 秒没有回复（接口是通的：可能型号不对，或这个模型太慢）' : e.message}${via()}${cors}`;
    } finally { clearTimeout(timer); }
  });
  $('#set-websearch').checked = cfg.claudeWebSearch;
  $('#set-websearch').addEventListener('change', (e) => { cfg = { ...cfg, claudeWebSearch: e.target.checked }; saveConfig(cfg); onConfigChange(cfg); });
  $('#tavily-key').value = cfg.tavilyKey || '';
  $('#bocha-key').value = cfg.bochaKey || '';
  $('#bocha-key').addEventListener('change', (e) => { cfg = { ...cfg, bochaKey: e.target.value.trim() }; saveConfig(cfg); onConfigChange(cfg); });
  $('#search-region').value = cfg.searchRegion || 'auto';
  $('#search-region').addEventListener('change', (e) => { cfg = { ...cfg, searchRegion: e.target.value }; saveConfig(cfg); onConfigChange(cfg); });
  $('#tavily-key').addEventListener('change', (e) => { cfg = { ...cfg, tavilyKey: e.target.value.trim() }; saveConfig(cfg); onConfigChange(cfg); });
  // 测试联网搜索：每个搜索源各搜一次，逐行说明能不能用、为什么不能用（截图就能看出问题在哪）
  $('#btn-search-test').addEventListener('click', async () => {
    const out = $('#search-test-result');
    out.style.whiteSpace = 'pre-line';
    out.textContent = '正在逐个测试搜索源…';
    const opts = { bochaKey: $('#bocha-key').value.trim(), tavilyKey: $('#tavily-key').value.trim(), fetchViaGateway: searchFetch?.(), searchRegion: $('#search-region').value };
    const engines = searchEngines(opts);
    if (!engines.length) { out.textContent = '当前环境没有可用的搜索：请填博查或 Tavily Key，或在电脑上运行启动程序'; return; }
    const region = await engines.at(-1).regionNow?.().catch(() => null);
    const lines = await Promise.all(engines.map(async (e) => {
      const t0 = Date.now();
      try {
        const hits = await e.search('今日新闻', 5);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        return hits.length ? `✓ ${e.name}：${hits.length} 条，${sec} 秒（第一条：${hits[0].title.slice(0, 20)}）` : `✕ ${e.name}：没有结果（${sec} 秒）`;
      } catch (err) { return `✕ ${e.name}：${err.message}`; }
    }));
    const version = globalThis.__jarvisAppUpdater?.state?.current ?? globalThis.jarvisDesktop?.version ?? '';
    out.textContent = [`${region ? `网络：${region === 'cn' ? '国内' : '国外'}` : ''}${version ? `　版本：${version}` : ''}`.trim(), ...lines].filter(Boolean).join('\n');
  });

  return {
    refreshFiles,
    openFile,
    markFresh(path) { fresh.add(path); },
    refreshKb,
    refreshMind,
    importToKb,
    refreshModels: fillModels,
    get config() { return cfg; },
    /** 配置被同步改了：重新读取并刷新界面 */
    reloadConfig() {
      cfg = loadConfig();
      sel.value = cfg.provider;
      fillModels();
      $('#set-websearch').checked = cfg.claudeWebSearch;
      $('#tavily-key').value = cfg.tavilyKey || '';
      $('#bocha-key').value = cfg.bochaKey || '';
      onConfigChange(cfg);
      return cfg;
    },
    /** 其他面板（如语音）修改配置：统一保存并通知 */
    patchConfig(fn) { cfg = fn(cfg); saveConfig(cfg); onConfigChange(cfg); return cfg; },
    /** 切换到指定服务商与型号（如本机模型面板里点“使用”） */
    useModel(provider, model) {
      cfg = { ...cfg, provider, models: { ...cfg.models, [provider]: model } };
      saveConfig(cfg);
      sel.value = provider;
      fillModels();
      onConfigChange(cfg);
    }
  };
}
