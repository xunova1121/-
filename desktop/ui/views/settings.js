/**
 * 设置：能力路由 + 一致性引擎 + 本机环境。
 *
 * 能力路由是拆开的（剧本、复核、出图、视频、配音各选各的），
 * 因为各家强项差得很远，绑死一家反而处处将就。
 */
import { h, clear, api, stream, toast, fmtMs } from '../lib.js';

function statusGlyph(status) {
  return { running: '◐', ok: '✓', warn: '!', fail: '✕', skip: '–' }[status] || '·';
}

const CAP_META = [
  ['chat', '剧本与分镜', 'chatProvider', 'chatModel', '读剧本、拆分镜、写设定集。长文本能力优先'],
  ['vision', '一致性复核', 'visionProvider', 'visionModel', '把成图和角色设定图放一起比对，必须选带视觉的模型'],
  ['t2i', '出图', 'imageProvider', 'imageModel', '角色设定图和每一镜的画面'],
  ['i2v', '视频', 'videoProvider', 'videoModel', '以镜头图为首帧生成视频片段'],
  ['tts', '配音', 'ttsProvider', 'ttsModel', '把台词合成语音']
];

export default {
  async render({ state, refreshCatalog }) {
    const { providers, settings } = state.catalog;
    const root = h('div', { class: 'stack' });
    const pending = {};

    // ── 能力路由 ──
    const routeGrid = h('div', { class: 'route-grid' });

    // 视频那一行换了服务商，下面的分辨率档位要跟着换 —— 各家档位完全不一样，
    // 留着上一家的选项会让人选中一个必然报错的值
    let repaintResolutions = () => {};

    // 同一家可能被四五条能力共用，列表拉一次就够
    const modelCache = new Map();
    async function fetchModels(providerId) {
      if (modelCache.has(providerId)) return modelCache.get(providerId);
      const r = await api(`/providers/${providerId}/models`);
      modelCache.set(providerId, r);
      return r;
    }

    for (const [cap, label, provKey, modelKey, hint] of CAP_META) {
      const candidates = providers.filter((p) => (p.capabilities || []).includes(cap));
      const modelSel = h('select', { onchange: (e) => (pending[modelKey] = e.target.value) });

      const paintModels = (providerId) => {
        const p = providers.find((x) => x.id === providerId);
        const models = (p?.models || []).filter((m) => !m.capability || m.capability === cap || cap === 'chat');
        modelSel.innerHTML = '';
        const list = models.length ? models : p?.models || [];
        for (const m of list) {
          modelSel.append(h('option', { value: m.id, selected: m.id === settings[modelKey] }, m.label || m.id));
        }
        // 中转网关/ 本地模型的可用列表因人而异，留一个手填口子
        modelSel.append(h('option', { value: '__custom__' }, '自定义（手动填写）…'));
        if (!list.some((m) => m.id === settings[modelKey])) {
          modelSel.append(h('option', { value: settings[modelKey], selected: true }, `${settings[modelKey]}（当前）`));
        }
      };

      const customInput = h('input', {
        type: 'text',
        class: 'mono',
        style: 'display:none;margin-top:6px',
        placeholder: '模型 ID 或推理接入点，如 ep-2026…',
        oninput: (e) => (pending[modelKey] = e.target.value.trim())
      });

      modelSel.addEventListener('change', (e) => {
        const custom = e.target.value === '__custom__';
        customInput.style.display = custom ? '' : 'none';
        if (custom) customInput.focus();
      });

      const provSel = h(
        'select',
        {
          onchange: (e) => {
            pending[provKey] = e.target.value;
            paintModels(e.target.value);
            pending[modelKey] = modelSel.value;
            if (cap === 'i2v') repaintResolutions();
          }
        },
        candidates.map((p) =>
          h('option', { value: p.id, selected: p.id === settings[provKey] },
            `${p.name}${p.credentials?.ready ? '' : ' ⚠ 未配密钥'}`)
        )
      );
      paintModels(settings[provKey]);

      // 「模型 ID 到底填什么」是配置这一步最大的卡点。
      // 与其让用户去控制台翻，不如拿他的密钥去问一次这家实际开通了哪些。
      const fetchHint = h('div', { class: 'field-hint' }, hint);
      const probeSlot = h('span', {});

      function fillModels(ids) {
        const current = pending[modelKey] || settings[modelKey];
        modelSel.innerHTML = '';
        for (const id of ids) modelSel.append(h('option', { value: id, selected: id === current }, id));
        modelSel.append(h('option', { value: '__custom__' }, '自定义（手动填写）…'));
        const known = ids.includes(current);
        if (!known) modelSel.append(h('option', { value: current, selected: true }, `${current}（当前，不在列表里）`));
        fetchHint.textContent = `${ids.length} 个可用${known ? '' : '；当前这个不在里面，建议换一个'}`;
        fetchHint.style.color = known ? 'var(--good)' : 'var(--caution)';
      }

      /** 列不出来就试出来：拿候选清单逐个发 max_tokens=1 的最小请求 */
      function showProbeOffer(providerId) {
        if (probeSlot.firstChild) return;
        probeSlot.append(
          h('button', {
            class: 'btn ghost sm',
            style: 'margin-left:6px',
            title: '这家不提供模型列表，改用候选清单逐个试。每个只发一个 token，几乎不花钱',
            onclick: async (e) => {
              const btn = e.target;
              btn.disabled = true;
              let done = 0;
              try {
                let result = null;
                await stream(`/providers/${providerId}/candidates`, {}, (ev) => {
                  if (ev.type === 'candidate') {
                    done += 1;
                    btn.textContent = `探测中 ${done}…`;
                  }
                  if (ev.type === 'finished') result = ev;
                  if (ev.type === 'error') toast(ev.message, 'err');
                });
                if (result?.available?.length) {
                  modelCache.set(providerId, { ok: true, models: result.available, reason: '' });
                  fillModels(result.available);
                  fetchHint.textContent = `试出 ${result.available.length}/${result.tried} 个能用`;
                  fetchHint.style.color = 'var(--good)';
                  toast(`探测完成：${result.available.length} 个可用`, 'ok');
                } else {
                  fetchHint.textContent = result?.reason || '一个都没试通';
                  fetchHint.style.color = 'var(--alarm)';
                }
              } catch (err) {
                toast(err.message, 'err');
              } finally {
                btn.disabled = false;
                btn.textContent = '逐个探测';
              }
            }
          }, '逐个探测')
        );
      }

      const fetchBtn = h('button', {
        class: 'btn ghost sm',
        title: '用你的密钥去问这家实际开通了哪些模型',
        onclick: async (e) => {
          const btn = e.target;
          const providerId = provSel.value;
          btn.disabled = true;
          btn.textContent = '拉取中…';
          try {
            const r = await fetchModels(providerId);
            if (!r.ok || !r.models.length) {
              fetchHint.textContent = r.reason || '没拿到模型列表';
              fetchHint.style.color = 'var(--caution)';
              // 拿不到列表不等于没办法：直接拿候选清单去试
              showProbeOffer(providerId);
            } else {
              fillModels(r.models);
            }
          } catch (err) {
            fetchHint.textContent = err.message;
            fetchHint.style.color = 'var(--alarm)';
          } finally {
            btn.disabled = false;
            btn.textContent = '拉取可用模型';
          }
        }
      }, '拉取可用模型');

      routeGrid.append(
        h('div', { class: 'field' },
          h('label', {}, label),
          h('div', { class: 'row' }, h('div', {}, provSel), h('div', {}, modelSel)),
          customInput,
          h('div', { style: 'margin-top:6px' }, fetchBtn, probeSlot),
          fetchHint
        )
      );
    }

    // ── 上线前体检 ──
    // 流水线跑一趟要几分钟到几十分钟。与其等第 04 步才发现视频模型 ID 填错，
    // 不如在这里用最小代价把五条腿挨个点一遍。
    const { checks } = await api('/preflight');
    const checkBoxes = new Map();
    const resultHost = h('div', { class: 'preflight-list' });

    const optionRow = h('div', { class: 'preflight-opts' },
      ...checks.map((c) => {
        const box = h('input', { type: 'checkbox', checked: c.defaultOn });
        checkBoxes.set(c.id, box);
        return h('label', { class: 'preflight-opt', title: c.note },
          box,
          h('span', {}, c.label),
          h('span', { class: 'preflight-cost' }, c.cost)
        );
      })
    );

    const runBtn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        const include = [...checkBoxes.entries()].filter(([, b]) => b.checked).map(([id]) => id);
        if (!include.length) return toast('至少勾一项', 'err');
        runBtn.disabled = true;
        runBtn.textContent = '体检中…';
        clear(resultHost);
        const rows = new Map();
        try {
          await stream('/preflight', { include }, (ev) => {
            if (ev.type === 'check') {
              let row = rows.get(ev.id);
              if (!row) {
                row = h('div', { class: 'preflight-row' });
                rows.set(ev.id, row);
                resultHost.append(row);
              }
              const meta = checks.find((c) => c.id === ev.id);
              clear(row);
              row.className = `preflight-row ${ev.status}`;
              row.append(
                h('span', { class: 'preflight-dot' }, statusGlyph(ev.status)),
                h('div', { class: 'preflight-body' },
                  h('div', { class: 'preflight-head' },
                    h('b', {}, meta?.label || ev.id),
                    h('span', { class: 'preflight-route' }, `${ev.provider} / ${ev.model || '未配置'}`),
                    ev.ms ? h('span', { class: 'preflight-ms' }, fmtMs(ev.ms)) : null
                  ),
                  ev.detail ? h('div', { class: 'preflight-detail' }, ev.detail) : null,
                  ev.message ? h('div', { class: 'preflight-msg' }, ev.message) : null,
                  ev.hint ? h('div', { class: 'preflight-hint' }, `→ ${ev.hint}`) : null
                )
              );
            }
            if (ev.type === 'poll') {
              const row = rows.get('i2v');
              if (row) row.querySelector('.preflight-detail')?.replaceChildren(`轮询第 ${ev.attempt} 次…`);
            }
            if (ev.type === 'summary') {
              resultHost.append(
                h('div', { class: `preflight-verdict ${ev.failed ? 'bad' : ev.warned ? 'warn' : 'good'}` }, ev.verdict)
              );
              toast(ev.verdict, ev.failed ? 'err' : 'ok');
            }
            if (ev.type === 'error') toast(ev.message, 'err');
          });
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = '开始体检';
        }
      }
    }, '开始体检');

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '上线前体检'),
        h('p', { class: 'panel-hint' },
          '按下面的路由配置，把五条能力各真跑一次最小调用。哪条不通、服务端原话是什么、下一步该改哪里，一次说清 —— 比跑到第 04 步才发现模型 ID 填错省事得多。'),
        optionRow,
        h('div', { class: 'inline', style: 'margin:12px 0' }, runBtn),
        resultHost
      )
    );

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '能力路由'),
        h('p', { class: 'panel-hint' },
          '每种能力单独挑服务商。各家强项差别很大 —— 剧本用便宜的长文本模型就够，出图和一致性复核才值得上好的。'),
        routeGrid
      )
    );

    // ── 画面规格 ──
    // 分辨率各家写法不统一（方舟 720p、万相 720P、秘塔 768P/2K），所以这里直接
    // 列出**当前视频服务商自己声明的那几档**，不做统一映射 —— 用户看到什么就发什么。
    const resSel = h('select', { onchange: (e) => (pending.videoResolution = e.target.value) });
    const resHint = h('div', { class: 'field-hint' });

    repaintResolutions = () => {
      const providerId = pending.videoProvider || settings.videoProvider;
      const p = providers.find((x) => x.id === providerId);
      const list = p?.videoDefaults?.resolutions || [];
      const current = pending.videoResolution || settings.videoResolution || 'auto';
      resSel.innerHTML = '';

      if (!list.length) {
        resSel.append(h('option', { value: 'auto', selected: true }, '跟随服务商默认'));
        resSel.disabled = true;
        resHint.textContent = `${p?.name || providerId} 的接口不收分辨率字段（清晰度由模型档位决定），这里不用选。`;
        return;
      }

      resSel.disabled = false;
      resSel.append(
        h('option', { value: 'auto', selected: current === 'auto' },
          `跟随服务商默认（${p.videoDefaults.resolution}）`)
      );
      for (const r of list) {
        resSel.append(h('option', { value: r, selected: r.toLowerCase() === String(current).toLowerCase() }, r));
      }
      resHint.textContent = `${p.name} 支持 ${list.join(' / ')}。选了这家没有的档位会自动退回默认档，不会让整条流水线报错。`;
    };
    repaintResolutions();

    const RATIOS = ['16:9', '9:16', '1:1', '4:3', '21:9'];
    const ratioSel = h('select', { onchange: (e) => (pending.aspectRatio = e.target.value) },
      RATIOS.map((r) => h('option', { value: r, selected: r === (settings.aspectRatio || '16:9') },
        r === '9:16' ? '9:16（竖屏短剧）' : r === '16:9' ? '16:9（横屏）' : r))
    );

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '画面规格'),
        h('p', { class: 'panel-hint' },
          '分辨率越高越贵、出得越慢。建议先用低档跑通全流程、确认分镜和人设都对，最后一遍再拉到高档重出。'),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '视频分辨率'), resSel, resHint),
          h('div', { class: 'field' }, h('label', {}, '画幅'), ratioSel,
            h('div', { class: 'field-hint' }, '竖屏短剧选 9:16。这个比例同时作用于出图和出视频，免得成片里两者打架。'))
        )
      )
    );

    // ── 一致性引擎 ──
    const verifyBox = h('input', { type: 'checkbox', checked: settings.consistencyVerify !== false,
      onchange: (e) => (pending.consistencyVerify = e.target.checked) });
    const refBox = h('input', { type: 'checkbox', checked: settings.useReferenceImages !== false,
      onchange: (e) => (pending.useReferenceImages = e.target.checked) });
    const thresholdInput = h('input', { type: 'number', min: 0, max: 100, value: settings.consistencyThreshold,
      oninput: (e) => (pending.consistencyThreshold = Number(e.target.value)) });
    const retryInput = h('input', { type: 'number', min: 0, max: 5, value: settings.consistencyMaxRetries,
      oninput: (e) => (pending.consistencyMaxRetries = Number(e.target.value)) });

    const check = (box, text) =>
      h('label', {
        style: 'display:flex;align-items:flex-start;gap:8px;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:400;color:var(--ink-dim);margin:0'
      }, box, h('span', {}, text));

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '一致性引擎'),
        h('p', { class: 'panel-hint' },
          '四层叠加：冻结设定 → 固定种子 → 参考图引用 → 视觉复核。第三层是效果最大的一层，第四层负责把"错了没人发现"变成"错了自动重来"。'),
        h('div', { class: 'stack', style: 'gap:10px' },
          check(refBox, '出镜头图时带上角色设定图作为参考图（最关键的一层，建议保持开启）'),
          check(verifyBox, '每张成图做视觉复核（会多一次模型调用，换来自动纠错）')
        ),
        h('div', { class: 'grid2', style: 'margin-top:14px' },
          h('div', { class: 'field' }, h('label', {}, '复核通过分数线'), thresholdInput,
            h('div', { class: 'field-hint' }, '低于这个分数判定人设漂了，会换一颗种子重出。75 是比较稳的起点。')),
          h('div', { class: 'field' }, h('label', {}, '单镜最多重试次数'), retryInput,
            h('div', { class: 'field-hint' }, '重试到头仍不达标的镜头会标成「待人工确认」，不会静悄悄放过去。'))
        )
      )
    );

    // ── 本机环境 ──
    const ffmpegInput = h('input', { type: 'text', class: 'mono', value: settings.ffmpegPath || '',
      placeholder: '留空则自动探测：先看应用 bin\\ 目录，再看 PATH',
      oninput: (e) => (pending.ffmpegPath = e.target.value.trim()) });
    const gatewayInput = h('input', { type: 'text', class: 'mono', value: settings.uploadGateway || '',
      placeholder: '留空则参考图以 base64 内联发送',
      oninput: (e) => (pending.uploadGateway = e.target.value.trim()) });
    const timeoutInput = h('input', { type: 'number', value: settings.requestTimeoutMs, min: 5000, step: 1000,
      oninput: (e) => (pending.requestTimeoutMs = Number(e.target.value)) });
    const pollInput = h('input', { type: 'number', value: settings.pollIntervalMs, min: 1000, step: 500,
      oninput: (e) => (pending.pollIntervalMs = Number(e.target.value)) });

    const ff = state.catalog.ffmpeg;
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '本机环境',
          h('span', { class: `badge ${ff.available ? 'ok' : 'warn'}` }, ff.available ? `FFmpeg ${ff.source}` : 'FFmpeg 未安装')
        ),
        h('p', { class: 'panel-hint' }, ff.available ? ff.version : ff.hint),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, 'FFmpeg 路径'), ffmpegInput),
          h('div', { class: 'field' }, h('label', {}, '图片上传网关'), gatewayInput,
            h('div', { class: 'field-hint' },
              '部分厂商的图生视频只认公网 URL，不收 base64。那种情况下填一个接收 multipart 上传、返回 {url} 的接口即可。'))
        ),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '单请求超时（毫秒）'), timeoutInput),
          h('div', { class: 'field' }, h('label', {}, '异步任务轮询间隔（毫秒）'), pollInput,
            h('div', { class: 'field-hint' }, '被限流（429）时把这个调大。'))
        )
      )
    );

    root.append(
      h('div', { class: 'inline' },
        h('button', {
          class: 'btn primary',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api('/settings', { method: 'POST', body: pending });
              await refreshCatalog();
              toast('设置已保存', 'ok');
            } catch (err) {
              toast(err.message, 'err');
            } finally {
              e.target.disabled = false;
            }
          }
        }, '保存设置'),
        h('span', { style: 'font-size:12px;color:var(--ink-faint)' },
          `配置文件：${state.health.dataDir}${state.health.platform === 'win32' ? '\\' : '/'}settings.json`)
      )
    );

    return root;
  }
};
