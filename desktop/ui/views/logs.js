/**
 * 请求记录：所有出站调用的黑匣子。
 * 生产跑挂了先来这里 —— 每一条都留着当时的请求体、响应体和耗时。
 */
import { h, clear, api, toast, highlightJSON, fmtMs, fmtBytes, fmtTime, statusBadge } from '../lib.js';

export default {
  async render() {
    // cap:logs
    const data = await api('/logs?limit=120');
    const root = h('div', { class: 'stack' });
    const s = data.stats;

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '近期健康度',
          h('button', {
            class: 'btn ghost sm',
            onclick: async () => {
              if (!confirm('清空全部请求记录？')) return;
              await api('/logs', { method: 'DELETE' });
              toast('已清空', 'ok');
              document.querySelector('#btn-refresh').click();
            }
          }, '清空记录')
        ),
        h('p', { class: 'panel-hint' }, `按最近 ${s.sampled} 条统计。密钥在写入前就已脱敏，这些记录可以直接贴给同事看。`),
        h('div', { class: 'inline' },
          h('span', { class: 'badge ok' }, `成功 ${s.ok}`),
          h('span', { class: `badge ${s.failed ? 'err' : ''}` }, `失败 ${s.failed}`),
          h('span', { class: 'badge' }, `P50 ${fmtMs(s.p50Ms)}`),
          h('span', { class: 'badge' }, `P95 ${fmtMs(s.p95Ms)}`),
          h('span', { class: 'badge' }, `累计 ${s.total}`)
        )
      )
    );

    const detail = h('div', { class: 'panel', style: 'display:none' });

    function showDetail(entry) {
      detail.style.display = '';
      clear(detail).append(
        h('h2', { class: 'panel-title' },
          `${entry.method} ${entry.label || ''}`,
          h('span', { class: 'badge' }, entry.id)
        ),
        h('p', { class: 'panel-hint mono', style: 'word-break:break-all' }, entry.url),
        h('div', { class: 'inline', style: 'margin-bottom:12px' },
          statusBadge(entry.status),
          h('span', { class: 'badge' }, `首字节 ${fmtMs(entry.ttfbMs)}`),
          h('span', { class: 'badge' }, `总耗时 ${fmtMs(entry.totalMs)}`),
          h('span', { class: 'badge' }, fmtBytes(entry.bytes)),
          entry.stream ? h('span', { class: 'badge beam' }, 'SSE') : null,
          entry.error ? h('span', { class: 'badge err' }, entry.error) : null
        ),
        h('div', { class: 'grid2' },
          h('div', {},
            h('label', {}, '请求头'),
            h('pre', { class: 'out', html: highlightJSON(entry.requestHeaders || {}) }),
            h('label', { style: 'margin-top:12px' }, '请求体'),
            h('pre', { class: 'out', html: highlightJSON(entry.requestBody ?? '（无）') })
          ),
          h('div', {},
            h('label', {}, '响应头'),
            h('pre', { class: 'out', html: highlightJSON(entry.responseHeaders || {}) }),
            h('label', { style: 'margin-top:12px' }, '响应体'),
            h('pre', { class: 'out', html: highlightJSON(entry.responseBody ?? '（无）') })
          )
        )
      );
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const rows = data.items.map((e) =>
      h('tr', { onclick: () => showDetail(e), tabindex: '0' },
        h('td', { class: 'mono' }, fmtTime(e.at)),
        h('td', {}, h('span', { class: 'badge' }, e.provider)),
        h('td', {}, e.label || '—'),
        h('td', { class: 'mono' }, e.method),
        h('td', {}, statusBadge(e.status)),
        h('td', { class: 'mono' }, fmtMs(e.totalMs)),
        h('td', { class: 'mono' }, fmtBytes(e.bytes)),
        h('td', { class: 'mono wrap', style: 'max-width:340px;overflow:hidden;text-overflow:ellipsis' }, e.url)
      )
    );

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '调用明细'),
        h('p', { class: 'panel-hint' }, '点任意一行看完整请求与响应。'),
        rows.length
          ? h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {},
                  h('th', {}, '时间'), h('th', {}, '服务商'), h('th', {}, '用途'),
                  h('th', {}, '方法'), h('th', {}, '状态'), h('th', {}, '耗时'),
                  h('th', {}, '大小'), h('th', {}, '地址')
                )),
                h('tbody', {}, rows)
              )
            )
          : h('div', { class: 'empty' }, h('b', {}, '还没有调用记录'), '去联调台发一个请求，或者跑一遍流水线。')
      ),
      detail
    );

    return root;
  }
};
