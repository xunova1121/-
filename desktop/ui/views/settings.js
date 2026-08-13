/**
 * 设置：能力路由 + 一致性引擎 + 本机环境。
 *
 * 能力路由是拆开的（剧本、复核、出图、视频、配音各选各的），
 * 因为各家强项差得很远，绑死一家反而处处将就。
 */
import { h, api, toast } from '../lib.js';

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
          }
        },
        candidates.map((p) =>
          h('option', { value: p.id, selected: p.id === settings[provKey] },
            `${p.name}${p.credentials?.ready ? '' : ' ⚠ 未配密钥'}`)
        )
      );
      paintModels(settings[provKey]);

      routeGrid.append(
        h('div', { class: 'field' },
          h('label', {}, label),
          h('div', { class: 'row' }, h('div', {}, provSel), h('div', {}, modelSel)),
          customInput,
          h('div', { class: 'field-hint' }, hint)
        )
      );
    }

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '能力路由'),
        h('p', { class: 'panel-hint' },
          '每种能力单独挑服务商。各家强项差别很大 —— 剧本用便宜的长文本模型就够，出图和一致性复核才值得上好的。'),
        routeGrid
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
