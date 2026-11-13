/**
 * “模型”面板里的本机模型：检测 Ollama → 一键启动 → 推荐清单一键下载（进度条）→ 一键切换使用。
 * 需要本机网关（桌面版或完整版）；单文件版只给出说明。
 */
import * as om from '../llm/localModels.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

export function initLocalModelsPanel({ getGateway, getConfig, useModel, patchConfig, toast }) {
  let state = null; // 网关返回的 status
  const pulling = new Map(); // name → { ctrl, text, percent }

  const origin = () => {
    const gw = getGateway();
    return gw?.ollama && !gw.cors ? gw.origin : null;
  };
  const installed = (name) => state?.models?.find((m) => m.name === name || m.name === `${name}:latest`);

  async function refresh() {
    const o = origin();
    if (!o) { state = null; return render(); }
    try { state = await om.status(o); } catch { state = null; }
    render();
  }

  function head() {
    const box = $('#local-status');
    if (!origin()) {
      box.replaceChildren(el('span', { textContent: '一键下载本机模型需要桌面版或完整版（双击 启动.bat）。单文件版仍可在上面选 “Ollama（本机模型）” 直连。' }));
      return;
    }
    if (!state) { box.replaceChildren(el('span', { textContent: '正在检测 Ollama…' })); return; }
    if (state.running) {
      const ram = state.ram ? ` · 本机内存 ${Math.round(state.ram / 1024 ** 3)} GB` : '';
      box.replaceChildren(el('span', { className: 'dot ok' }), el('span', { textContent: `Ollama ${state.version} 运行中${ram}` }));
      return;
    }
    if (state.binary) {
      const btn = el('button', { type: 'button', className: 'btn sm', id: 'btn-ollama-start', textContent: '启动 Ollama' });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '启动中…';
        try {
          const r = await om.start(origin());
          if (!r.ok) toast(r.error);
        } catch (e) { toast(e.message); }
        refresh();
      });
      box.replaceChildren(el('span', { className: 'dot off' }), el('span', { textContent: '已安装 Ollama，但没有运行' }), btn);
      return;
    }
    box.replaceChildren(
      el('span', { className: 'dot off' }),
      el('span', { textContent: '没有检测到 Ollama。它是免费的本机模型运行器，装好后回到这里即可一键下载模型。' }),
      el('a', { className: 'btn sm', href: 'https://ollama.com/download', target: '_blank', rel: 'noopener', textContent: '下载 Ollama' }),
      el('button', { type: 'button', className: 'btn ghost sm', textContent: '重新检测', onclick: refresh })
    );
  }

  function actions(m) {
    const cfg = getConfig();
    const name = m.name;
    const p = pulling.get(name);
    if (p) {
      const cancel = el('button', { type: 'button', className: 'btn ghost sm', textContent: '取消' });
      cancel.addEventListener('click', () => p.ctrl.abort());
      return [el('div', { className: 'lm-progress' },
        el('div', { className: 'lm-bar' }, el('i', { style: `width:${p.percent ?? 0}%` })),
        el('span', { className: 'lm-pct', textContent: p.text })), cancel];
    }
    if (!installed(name)) {
      const dl = el('button', { type: 'button', className: 'btn sm', textContent: '下载', disabled: !state?.running });
      dl.dataset.pull = name;
      dl.addEventListener('click', () => download(name));
      return [dl];
    }
    const out = [];
    if (m.embed) {
      const on = cfg.embedding?.engine === 'ollama' && (cfg.embedding.model || 'bge-m3') === name;
      const b = el('button', { type: 'button', className: `btn sm${on ? ' ghost' : ''}`, textContent: on ? '检索中使用' : '用于按意思检索', disabled: on });
      b.addEventListener('click', () => {
        patchConfig((c) => ({ ...c, embedding: { ...(c.embedding || {}), engine: 'ollama', model: name } }));
        toast('知识库和记忆改用本机向量检索。已有的文档可在“知识库”里补算向量');
        render();
      });
      out.push(b);
    } else {
      const using = cfg.provider === 'ollama' && cfg.models?.ollama === name;
      const b = el('button', { type: 'button', className: `btn sm${using ? ' ghost' : ''}`, textContent: using ? '使用中' : '使用', disabled: using });
      b.dataset.use = name;
      b.addEventListener('click', () => {
        useModel('ollama', name);
        toast(`已切换到本机模型 ${name}${m.tools === false ? '（这个模型只能聊天，不能调用工具）' : ''}`);
        render();
      });
      out.push(b);
    }
    const del = el('button', { type: 'button', className: 'x-btn', title: '删除这个模型（释放磁盘）', textContent: '✕' });
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '确认删除'; setTimeout(() => { del.dataset.armed = ''; del.textContent = '✕'; }, 3000); return; }
      try { await om.remove(origin(), name); toast(`已删除 ${name}`); } catch (e) { toast(e.message); }
      refresh();
    });
    out.push(del);
    return out;
  }

  function row(m) {
    const meta = m.size ? `约 ${m.size} GB · 建议内存 ${m.ram} GB` : om.formatSize(m.bytes || 0);
    const rec = state?.ram && m.name === om.recommend(state.ram);
    return el('li', { className: `lm-row${installed(m.name) ? ' have' : ''}` },
      el('div', { className: 'lm-info' },
        el('div', { className: 'lm-title' },
          el('b', { textContent: m.title || m.name }),
          rec ? el('span', { className: 'tag hot', textContent: '推荐' }) : null,
          ...(m.tags || []).map((t) => el('span', { className: 'tag', textContent: t }))),
        el('div', { className: 'lm-desc', textContent: m.desc ? `${m.desc} · ${meta}` : meta }),
        el('code', { className: 'lm-name', textContent: m.name })),
      el('div', { className: 'lm-actions' }, ...actions(m)));
  }

  function render() {
    head();
    const list = $('#local-list');
    if (!origin()) { list.replaceChildren(); $('#local-custom').hidden = true; return; }
    $('#local-custom').hidden = !state?.running;
    const extra = (state?.models ?? []).filter((x) => !om.catalogEntry(x.name)).map((x) => ({ name: x.name, title: x.name, bytes: x.size, tags: [x.params, x.quant].filter(Boolean), desc: '' }));
    list.replaceChildren(...[...om.LOCAL_CATALOG, ...extra].map(row));
  }

  async function download(name) {
    const o = origin();
    if (!o || pulling.has(name)) return;
    const ctrl = new AbortController();
    const p = { ctrl, text: '准备中…', percent: 0 };
    pulling.set(name, p);
    render();
    let last = 0;
    try {
      await om.pull(o, name, {
        signal: ctrl.signal,
        onProgress: ({ status, completed, total, percent }) => {
          p.percent = percent ?? p.percent;
          p.text = percent != null ? `${om.statusText(status)} ${percent.toFixed(0)}% · ${om.formatSize(completed)} / ${om.formatSize(total)}` : om.statusText(status);
          if (Date.now() - last > 250) { last = Date.now(); render(); }
        }
      });
      pulling.delete(name);
      await refresh();
      const m = om.catalogEntry(name);
      if (m?.embed) toast(`${name} 下载完成。点“用于按意思检索”启用本机向量`);
      else if (getConfig().provider !== 'ollama') {
        useModel('ollama', name);
        toast(`${name} 下载完成，已切换为当前模型`);
        render();
      } else toast(`${name} 下载完成`);
    } catch (e) {
      pulling.delete(name);
      toast(e.name === 'AbortError' ? `已取消下载 ${name}（已下载的部分会保留，下次继续）` : `${name}：${e.message}`);
      refresh();
    }
  }

  $('#local-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#local-custom-name');
    const name = input.value.trim();
    if (!/^[\w][\w.\-/:]{0,99}$/.test(name)) { toast('模型名形如 qwen3:8b，可在 ollama.com/library 查'); return; }
    input.value = '';
    download(name);
  });

  return { refresh, render, download, get state() { return state; } };
}
