/**
 * 服务商与密钥。
 *
 * 密钥只进不出：填进去存在加密的保险箱里，页面上永远只显示掩码。
 * 想确认某把钥匙对不对，用「自检」，不要靠肉眼比对。
 */
import { h, clear, api, toast, fmtMs } from '../lib.js';

/** 接口名 → 人话。中转平台的路径经常和官方对不上，得让人看懂在改什么 */
const ENDPOINT_LABELS = {
  chat: '对话',
  models: '列模型',
  images: '出图',
  t2i: '文生图',
  i2v: '图生视频',
  r2v: '参考图生视频',
  tts: '语音合成',
  videoTasks: '视频任务',
  videoCreate: '提交视频任务',
  videoQuery: '查视频任务',
  fileRetrieve: '取文件下载地址'
};

export default {
  async render({ state, refreshCatalog }) {
    const { providers } = state.catalog;
    const overrides = state.catalog.settings.endpointOverrides || {};
    const secretsInfo = await api('/secrets');
    const configured = new Set(secretsInfo.items.map((i) => i.name));
    const previews = Object.fromEntries(secretsInfo.items.map((i) => [i.name, i.preview]));

    const root = h('div', { class: 'stack' });

    // 有一份读不出来的旧密钥文件（典型情况：先用 exe 存过 DPAPI 密钥，
    // 后来改用只带 Node 的绿色版打开）。这时候最要紧的是让用户知道怎么脱身，
    // 而不是让他对着一排"未配置"发愣。
    const vaultLocked = state.health?.vault?.locked;
    if (vaultLocked) {
      root.append(
        h('div', { class: 'fail-box' },
          h('div', { class: 'fail-head' }, '有一份旧密钥读不出来'),
          h('div', { class: 'fail-row' }, h('span', { class: 'fail-msg' }, state.health.vault.reason)),
          h('div', { class: 'fail-row' }, h('span', { class: 'fail-msg' }, state.health.vault.fix)),
          h('div', { class: 'fail-tip' },
            '下面的卡片现在都显示"未配置"—— 那是因为读不出来，不是被删了。重新填一次就能继续用。')
        )
      );
    }

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '凭据保险箱',
          h('span', { class: `badge ${vaultLocked ? 'warn' : secretsInfo.backend === 'dpapi' ? 'ok' : 'warn'}` },
            vaultLocked ? '旧文件读不出' : secretsInfo.backend === 'dpapi' ? 'Windows DPAPI' : 'AES-256-GCM')
        ),
        h('p', { class: 'panel-hint' },
          secretsInfo.backend === 'dpapi'
            ? '密钥用 Windows DPAPI 加密，绑定当前用户账户 —— 文件被拷到别的机器或别的用户下解不开。'
            : '当前是命令行模式，密钥用本机 AES-256-GCM 加密。这能挡住"文件被顺手拷走"，挡不住已经拿到你登录态的人。这种格式桌面版也读得出来，两边通用。')
      )
    );

    /**
     * 接口地址（高级）。
     *
     * 加这块是因为踩过一次：中转平台只公开"提交任务"的地址，查任务的路径靠猜 ——
     * 猜错就会出现"厂商那边早就出片了，这边还在轮询到超时"。
     * 与其等我改目录再发一版，不如让你把在联调台里试通的那个地址直接填进来。
     */
    function endpointEditor(p) {
      const keys = Object.keys(p.endpoints || {});
      if (!keys.length) return null;
      const filled = keys.filter((k) => overrides[`${p.id}.${k}`]).length;

      const rows = keys.map((k) => {
        const key = `${p.id}.${k}`;
        return h('div', { class: 'field' },
          h('label', {}, ENDPOINT_LABELS[k] || k),
          h('input', {
            type: 'text', class: 'mono', 'data-endpoint': key,
            value: overrides[key] || '',
            placeholder: p.endpoints[k] || '（目录里没写，留空则自动探测）'
          }));
      });

      return h('details', { class: 'endpoint-editor', open: filled > 0 },
        h('summary', {}, `接口地址（高级）${filled ? ` · 已自定义 ${filled} 条` : ''}`),
        h('p', { class: 'field-hint' },
          '留空 = 用目录里的默认值（查任务那条留空则自动探测）。' +
          '地址里可以写 {{baseUrl}}；查任务那条还可以写 {taskId} 指定任务号的位置，不写就自动加 ?task_id=。'),
        ...rows,
        h('div', { class: 'inline', style: 'margin-top:8px' },
          h('button', {
            class: 'btn sm',
            onclick: async (e) => {
              const patch = {};
              for (const el of e.target.closest('.endpoint-editor').querySelectorAll('input[data-endpoint]')) {
                patch[el.dataset.endpoint] = el.value.trim();
              }
              await api('/settings', { method: 'POST', body: { endpointOverrides: patch } });
              await refreshCatalog();
              toast('接口地址已保存，下一次调用就用新的', 'ok');
            }
          }, '保存接口地址')));
    }

    const grid = h('div', { class: 'grid2' });

    for (const p of providers) {
      if (!p.secrets.length && p.id === 'raw') continue;

      const inputs = p.secrets.map((s) => {
        const input = h('input', {
          type: 'password',
          placeholder: configured.has(s.name) ? `已配置 ${previews[s.name]}` : '未配置',
          autocomplete: 'off'
        });
        input.dataset.secret = s.name;
        return h('div', { class: 'field' },
          h('label', {}, `${s.label}${s.required ? '' : '（可选）'}`),
          input,
          s.hint ? h('div', { class: 'field-hint' }, s.hint) : null
        );
      });

      const baseInput = p.editableBaseUrl
        ? h('input', { type: 'text', class: 'mono', value: p.baseUrl, placeholder: '接口根地址' })
        : null;

      const statusEl = h('span', { class: `badge ${p.credentials.ready ? 'ok' : ''}` },
        h('span', { class: `dot ${p.credentials.ready ? 'ok' : ''}` }),
        p.credentials.ready ? '已配置' : '缺密钥');

      // 自检失败的原因现在会带上服务端原话，多行且长，塞 toast 里看不全 —— 留在卡片上
      const reasonEl = h('div', { class: 'probe-reason', style: 'display:none' });

      const card = h('div', { class: 'provider-card' },
        h('div', { class: 'provider-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'provider-name' }, p.name),
            h('div', { class: 'provider-base' }, p.baseUrl || '（自由填写）')
          ),
          statusEl
        ),
        h('div', { class: 'cap-list' }, (p.capabilities || []).map((c) => h('span', { class: 'cap' }, c))),
        reasonEl,
        ...inputs,
        baseInput ? h('div', { class: 'field' }, h('label', {}, '接口根地址'), baseInput,
          h('div', { class: 'field-hint' }, '走内网网关或换中转线路时改这里。改完先自检再用。')) : null,
        endpointEditor(p),
        h('div', { class: 'inline' },
          h('button', {
            class: 'btn',
            onclick: async (e) => {
              const btn = e.target;
              btn.disabled = true;
              const payload = {};
              for (const el of card.querySelectorAll('input[data-secret]')) {
                if (el.value.trim()) payload[el.dataset.secret] = el.value.trim();
              }
              try {
                if (Object.keys(payload).length) await api('/secrets', { method: 'POST', body: { secrets: payload } });
                if (baseInput && baseInput.value.trim() !== p.baseUrl) {
                  await api('/settings', { method: 'POST', body: { baseUrls: { [p.id]: baseInput.value.trim() } } });
                }
                for (const el of card.querySelectorAll('input[data-secret]')) el.value = '';
                await refreshCatalog();
                toast(`${p.name} 已保存`, 'ok');
              } catch (err) {
                toast(err.message, 'err');
              } finally {
                btn.disabled = false;
              }
            }
          }, '保存'),
          p.probe
            ? h('button', {
                class: 'btn ghost',
                onclick: async (e) => {
                  const btn = e.target;
                  const label = btn.textContent;
                  btn.disabled = true;
                  btn.textContent = '自检中…';
                  try {
                    const r = await api(`/providers/${p.id}/probe`, { method: 'POST' });
                    clear(statusEl);
                    clear(reasonEl);
                    if (r.skipped) {
                      reasonEl.style.display = '';
                      reasonEl.append(r.reason);
                    } else if (r.ok) {
                      statusEl.className = 'badge ok';
                      statusEl.append(h('span', { class: 'dot ok' }), `连通 ${fmtMs(r.latencyMs)}`);
                      reasonEl.style.display = '';
                      reasonEl.className = 'probe-reason ok';
                      // note 是"通了，但有话要说"：比如这家没有便宜的接口可探，
                      // 自检发的是缺参数的请求，服务端挑参数恰好证明鉴权和路径都对
                      reasonEl.append(r.note || (r.model ? `用模型 ${r.model} 试通了。` : '连通。'));
                      toast(`${p.name} 连通，${fmtMs(r.latencyMs)}`, 'ok');
                    } else {
                      statusEl.className = 'badge err';
                      statusEl.append(h('span', { class: 'dot err' }), '不通');
                      reasonEl.style.display = '';
                      reasonEl.className = 'probe-reason err';
                      // 自检用的是哪个模型，是排查这类问题的第一条线索
                      if (r.model) reasonEl.append(h('div', { class: 'probe-model' }, `自检用的模型：${r.model}`));
                      reasonEl.append(r.reason || `HTTP ${r.status}`);
                      toast(`${p.name} 自检未通过，原因见卡片`, 'err');
                    }
                  } catch (err) {
                    toast(err.message, 'err');
                  } finally {
                    btn.disabled = false;
                    btn.textContent = label;
                  }
                }
              }, '自检')
            : null,
          p.docs ? h('a', { class: 'btn ghost sm', href: p.docs, target: '_blank', rel: 'noreferrer' }, '开发文档') : null,
          ...p.secrets
            .filter((s) => configured.has(s.name))
            .map((s) =>
              h('button', {
                class: 'btn ghost sm',
                title: `删除已保存的 ${s.name}`,
                onclick: async () => {
                  if (!confirm(`删除 ${s.name}？`)) return;
                  await api(`/secrets/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
                  await refreshCatalog();
                  toast('已删除', 'ok');
                  document.querySelector('#btn-refresh').click();
                }
              }, `清除 ${s.label}`)
            )
        )
      );

      grid.append(card);
    }

    root.append(grid);
    return root;
  }
};
