/**
 * API 联调台。
 *
 * 这一页和 Studio 流水线走的是同一条出站通道（core/http-client.js），
 * 所以"在这里能调通"和"跑起来能调通"是同一件事 ——
 * 大多数工具的联调页是另写一套请求代码，联调过了照样翻车，就是差在这儿。
 */
import { h, clear, api, stream, toast, highlightJSON, fmtMs, fmtBytes, statusBadge } from '../lib.js';

let controller = null;

const draft = {
  provider: localStorage.getItem('fd.debug.provider') || 'volcengine',
  template: null,
  method: 'POST',
  url: '',
  headers: [],
  body: '',
  stream: false,
  async: false
};

export default {
  async render({ state }) {
    const providers = state.catalog.providers;

    // ── 左栏：请求 ──
    const providerSel = h(
      'select',
      {
        onchange: async (e) => {
          draft.provider = e.target.value;
          localStorage.setItem('fd.debug.provider', draft.provider);
          paintTemplates();
          await loadTemplate();
        }
      },
      providers.map((p) =>
        h('option', { value: p.id, selected: p.id === draft.provider }, `${p.name}${p.credentials?.ready ? '' : '（未配密钥）'}`)
      )
    );

    const templateSel = h('select', {
      onchange: async (e) => {
        draft.template = e.target.value;
        await loadTemplate();
      }
    });

    const methodSel = h(
      'select',
      { onchange: (e) => (draft.method = e.target.value) },
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h('option', { value: m }, m))
    );

    const urlInput = h('input', {
      type: 'text',
      class: 'mono',
      placeholder: 'https://…',
      oninput: (e) => (draft.url = e.target.value)
    });

    const headerList = h('div', { class: 'kv-list' });
    const bodyArea = h('textarea', { rows: 14, oninput: (e) => (draft.body = e.target.value) });

    const streamBox = h('input', {
      type: 'checkbox',
      onchange: (e) => (draft.stream = e.target.checked)
    });
    const asyncBox = h('input', {
      type: 'checkbox',
      onchange: (e) => (draft.async = e.target.checked)
    });

    const sendBtn = h('button', { class: 'btn primary', onclick: send }, '发送');
    const abortBtn = h('button', { class: 'btn ghost', disabled: true, onclick: abort }, '中止');
    const probeBtn = h(
      'button',
      {
        class: 'btn ghost',
        onclick: async () => {
          probeBtn.disabled = true;
          probeBtn.textContent = '自检中…';
          try {
            const r = await api(`/providers/${draft.provider}/probe`, { method: 'POST' });
            if (r.skipped) toast(r.reason);
            else if (r.ok) toast(`连通，${fmtMs(r.latencyMs)}`, 'ok');
            else toast(r.reason || `HTTP ${r.status}`, 'err');
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            probeBtn.disabled = false;
            probeBtn.textContent = '连通性自检';
          }
        }
      },
      '连通性自检'
    );

    // ── 右栏：响应 ──
    const metaRow = h('div', { class: 'resp-meta' }, h('span', { class: 'badge' }, '尚未发送'));
    const streamLog = h('div', { class: 'stream-log' }, h('div', {}, '事件流会实时出现在这里'));
    const outPre = h('pre', { class: 'out' }, '');
    let respTab = 'body';
    let lastResult = { headers: {}, events: [], text: '', json: null };

    const tabsBar = h('div', { class: 'tabs' });
    const TABS = [
      ['body', '响应体'],
      ['headers', '响应头'],
      ['events', '事件流'],
      ['curl', 'cURL / PowerShell']
    ];
    function paintTabs() {
      clear(tabsBar).append(
        ...TABS.map(([id, label]) =>
          h(
            'button',
            {
              class: `tab ${respTab === id ? 'active' : ''}`,
              onclick: () => {
                respTab = id;
                paintTabs();
                paintOut();
              }
            },
            label
          )
        )
      );
    }
    function paintOut() {
      if (respTab === 'headers') outPre.innerHTML = highlightJSON(lastResult.headers);
      else if (respTab === 'events') {
        outPre.textContent = lastResult.events.length
          ? lastResult.events.map((e) => `${e.event || 'message'}: ${e.data}`).join('\n')
          : '这次不是流式响应。';
      } else if (respTab === 'curl') outPre.textContent = buildCurl();
      else outPre.innerHTML = lastResult.json ? highlightJSON(lastResult.json) : highlightJSON(lastResult.text || '（空）');
    }
    paintTabs();

    // ── 逻辑 ──

    function readHeaders() {
      const out = {};
      for (const row of headerList.children) {
        const [k, v] = [row.children[0].value.trim(), row.children[1].value];
        if (k) out[k] = v;
      }
      return out;
    }

    function addHeaderRow(key = '', value = '') {
      const row = h(
        'div',
        { class: 'kv-row' },
        h('input', { type: 'text', value: key, placeholder: 'Header' }),
        h('input', { type: 'text', value, placeholder: '值（可用 {{密钥名}} 占位）' }),
        h('button', { class: 'btn ghost sm', onclick: () => row.remove(), title: '删除这一行' }, '×')
      );
      headerList.append(row);
    }

    function paintTemplates() {
      const provider = providers.find((p) => p.id === draft.provider);
      clear(templateSel).append(
        ...(provider?.templates || []).map((t) => h('option', { value: t.id }, t.label))
      );
      draft.template = provider?.templates?.[0]?.id || null;
    }

    async function loadTemplate() {
      if (!draft.template) return;
      try {
        const d = await api(`/providers/${draft.provider}/template/${draft.template}`);
        draft.method = d.method;
        draft.url = d.url;
        draft.body = d.body;
        draft.stream = d.stream;
        draft.async = d.async;
        methodSel.value = d.method;
        urlInput.value = d.url;
        bodyArea.value = d.body;
        streamBox.checked = d.stream;
        asyncBox.checked = d.async;
        clear(headerList);
        for (const [k, v] of Object.entries(d.headers || {})) addHeaderRow(k, v);
        addHeaderRow();
      } catch (err) {
        toast(err.message, 'err');
      }
    }

    function buildCurl() {
      const headers = readHeaders();
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const lines = [`curl -X ${draft.method} ${q(draft.url)}`];
      for (const [k, v] of Object.entries(headers)) lines.push(`  -H ${q(`${k}: ${v}`)}`);
      if (draft.body && draft.method !== 'GET') lines.push(`  --data ${q(draft.body)}`);
      const curl = lines.join(' \\\n');

      const ps = [
        '# PowerShell（Windows 自带，无需装 curl）',
        `$headers = @{ ${Object.entries(headers)
          .map(([k, v]) => `"${k}" = "${String(v).replace(/"/g, '`"')}"`)
          .join('; ')} }`,
        draft.body && draft.method !== 'GET'
          ? `$body = @'\n${draft.body}\n'@\nInvoke-RestMethod -Method ${draft.method} -Uri "${draft.url}" -Headers $headers -ContentType "application/json" -Body $body`
          : `Invoke-RestMethod -Method ${draft.method} -Uri "${draft.url}" -Headers $headers`
      ].join('\n');

      return `${curl}\n\n${'─'.repeat(60)}\n\n${ps}\n\n注：{{密钥名}} 占位符只有本应用会展开，复制出去前请替换成真实密钥。`;
    }

    function logEvent(ev) {
      const line = h('div', { class: `ev-${ev.type}` }, formatEvent(ev));
      streamLog.append(line);
      streamLog.scrollTop = streamLog.scrollHeight;
    }

    function formatEvent(ev) {
      switch (ev.type) {
        case 'meta':
          return `← HTTP ${ev.status} ${ev.statusText}  首字节 ${fmtMs(ev.ttfbMs)}`;
        case 'sse':
          return ev.delta ? `Δ ${ev.delta}` : `· ${ev.event}: ${(ev.data || '').slice(0, 120)}`;
        case 'text':
          return `· ${ev.text.slice(0, 160)}`;
        case 'poll':
          return `轮询 #${ev.attempt} → ${ev.state || '(无状态字段)'}`;
        case 'note':
          return `※ ${ev.message}`;
        case 'error':
          return `✕ ${ev.message}`;
        case 'done':
          return `完成：${ev.status}，共 ${fmtMs(ev.totalMs)}，${fmtBytes(ev.bytes)}`;
        default:
          return JSON.stringify(ev).slice(0, 200);
      }
    }

    async function send() {
      controller = new AbortController();
      sendBtn.disabled = true;
      abortBtn.disabled = false;
      clear(streamLog);
      clear(metaRow).append(h('span', { class: 'badge beam' }, h('span', { class: 'spin' }, '◐'), '请求中'));
      lastResult = { headers: {}, events: [], text: '', json: null };
      outPre.textContent = '';

      const spec = {
        provider: draft.provider,
        method: methodSel.value,
        url: urlInput.value,
        headers: readHeaders(),
        body: bodyArea.value || undefined,
        stream: streamBox.checked,
        async: asyncBox.checked
      };

      let assembled = '';
      try {
        await stream(
          '/debug/send',
          spec,
          (ev) => {
            logEvent(ev);
            if (ev.type === 'meta') lastResult.headers = ev.headers;
            if (ev.type === 'sse') {
              lastResult.events.push({ event: ev.event, data: ev.data });
              if (ev.delta) {
                assembled += ev.delta;
                lastResult.text = assembled;
                if (respTab === 'body') outPre.textContent = assembled;
              }
            }
            if (ev.type === 'text') {
              assembled += ev.text;
              lastResult.text = assembled;
            }
            if (ev.type === 'done') {
              lastResult.json = ev.json ?? null;
              if (!lastResult.text) lastResult.text = ev.text || '';
              clear(metaRow).append(
                statusBadge(ev.status),
                h('span', { class: 'badge' }, `首字节 ${fmtMs(ev.ttfbMs)}`),
                h('span', { class: 'badge' }, `总耗时 ${fmtMs(ev.totalMs)}`),
                h('span', { class: 'badge' }, fmtBytes(ev.bytes)),
                ev.stream ? h('span', { class: 'badge beam' }, 'SSE') : null
              );
              paintOut();
            }
            if (ev.type === 'error') {
              clear(metaRow).append(h('span', { class: 'badge err' }, '失败'), h('span', {}, ev.message));
              if (ev.missing?.length) {
                toast(`缺少密钥：${ev.missing.join('、')}，去「服务商与密钥」补上`, 'err');
              }
            }
            if (ev.type === 'finished' && ev.result) {
              logEvent({ type: 'note', message: `记录 ID ${ev.result.logId}` });
            }
          },
          { signal: controller.signal }
        );
      } catch (err) {
        if (err.name !== 'AbortError') toast(err.message, 'err');
      } finally {
        sendBtn.disabled = false;
        abortBtn.disabled = true;
        controller = null;
      }
    }

    function abort() {
      controller?.abort();
      toast('已中止');
    }

    paintTemplates();
    await loadTemplate();

    return h(
      'div',
      { class: 'debug-layout' },
      // 左：请求
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'panel' },
          h('h2', { class: 'panel-title' }, '请求'),
          h(
            'p',
            { class: 'panel-hint' },
            '这里发出的请求，走的是流水线跑生产时同一条通道。密钥用 {{名称}} 占位，发送时才展开，界面和历史记录里始终看不到明文。'
          ),
          h('div', { class: 'grid2' },
            h('div', { class: 'field' }, h('label', {}, '服务商'), providerSel),
            h('div', { class: 'field' }, h('label', {}, '请求模板'), templateSel)
          ),
          h('div', { class: 'field' },
            h('label', {}, '地址'),
            h('div', { class: 'row' },
              h('div', { class: 'shrink', style: 'width:104px' }, methodSel),
              urlInput
            )
          ),
          h('div', { class: 'field' },
            h('label', {}, '请求头'),
            headerList,
            h('button', { class: 'btn ghost sm', style: 'margin-top:7px', onclick: () => addHeaderRow() }, '+ 加一行')
          ),
          h('div', { class: 'field' }, h('label', {}, '请求体'), bodyArea),
          h('div', { class: 'inline' },
            sendBtn,
            abortBtn,
            probeBtn,
            h('label', { style: 'display:inline-flex;align-items:center;gap:6px;margin:0;text-transform:none;letter-spacing:0;font-size:12px;font-weight:400;color:var(--ink-dim)' },
              streamBox, '按 SSE 流式解析'),
            h('label', { style: 'display:inline-flex;align-items:center;gap:6px;margin:0;text-transform:none;letter-spacing:0;font-size:12px;font-weight:400;color:var(--ink-dim)' },
              asyncBox, '提交后自动轮询到终态')
          )
        )
      ),
      // 右：响应
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'panel' },
          h('h2', { class: 'panel-title' }, '响应'),
          metaRow,
          tabsBar,
          outPre
        ),
        h('div', { class: 'panel' },
          h('h2', { class: 'panel-title' }, '事件流'),
          h('p', { class: 'panel-hint' }, '流式分片、轮询状态、错误按发生顺序落在这里。'),
          streamLog
        )
      )
    );
  }
};
