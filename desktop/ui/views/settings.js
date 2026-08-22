/**
 * 设置：能力路由 + 一致性引擎 + 本机环境。
 *
 * 能力路由是拆开的（剧本、复核、出图、视频、配音各选各的），
 * 因为各家强项差得很远，绑死一家反而处处将就。
 */
import { h, clear, add, api, stream, toast, fmtMs } from '../lib.js';
import { RATIOS } from '../ratios.js';

function statusGlyph(status) {
  return { running: '◐', ok: '✓', warn: '!', fail: '✕', skip: '–' }[status] || '·';
}

const CAP_META = [
  ['chat', '剧本与分镜', 'chatProvider', 'chatModel', '读剧本、拆分镜、写设定集。长文本能力优先'],
  /**
   * 调度和剧本分开，是因为要的能力不是一回事：
   * 写剧本是**生成**，写得顺就行；调度是**判断** —— 端着全片二十镜，
   * 判断"这两镜是不是同一场戏"、"这句话是谁说的"。
   * 便宜模型在判断题上会稳定地犯同一种错：每镜孤立地看都像那么回事，连起来全是矛盾。
   * 调用次数又极少（全片各一次），所以这一行值得单配一个更聪明的。
   */
  ['chat', '调度（挑技法 / 绑说话人 / 分章）', 'directorProvider', 'directorModel',
    '推荐火山方舟的 doubao-seed-1-6-thinking-250615（思考型）；DeepSeek R1、Qwen Max 也合适。不配就跟随剧本模型',
    { follow: true }],
  ['vision', '一致性复核', 'visionProvider', 'visionModel', '把成图和角色设定图放一起比对，必须选带视觉的模型'],
  ['t2i', '出图', 'imageProvider', 'imageModel', '角色设定图和每一镜的画面'],
  ['i2v', '视频', 'videoProvider', 'videoModel', '以镜头图为首帧生成视频片段'],
  ['tts', '配音', 'ttsProvider', 'ttsModel', '把台词合成语音'],
  /**
   * 音效和配音是**两种模型**，所以是两行，不是一行。
   *
   * 合成一行的诱惑很大（都是"出声音"），但拿配音模型去做"敲门声"，
   * 出来的是一个人念这三个字 —— 而且会被当成成片的一部分交付出去。
   * 不配就是不做音效，故意不回退。
   */
  ['sfx', '音效', 'sfxProvider', 'sfxModel',
    '把分镜里那栏「画外音效」（敲门声、脚步声）变成真的声音。不配就是不做音效 —— 故意不回退到配音模型，那会念出"敲门声"三个字',
    { none: '不做音效' }]
];

export default {
  async render({ state, refreshCatalog }) {
    const { providers, settings } = state.catalog;
    const root = h('div', { class: 'stack' });
    const pending = {};

    const burnBox = h('input', {
      type: 'checkbox',
      checked: settings.burnSubtitles === true,
      onchange: (e) => (pending.burnSubtitles = e.target.checked)
    });

    const check = (box, text) =>
      h('label', {
        style: 'display:flex;align-items:flex-start;gap:8px;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:400;color:var(--ink-dim);margin:0'
      }, box, h('span', {}, text));

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

    for (const [cap, label, provKey, modelKey, hint, opts = {}] of CAP_META) {
      const candidates = providers.filter((p) => (p.capabilities || []).includes(cap));
      const modelSel = h('select', { onchange: (e) => (pending[modelKey] = e.target.value) });

      const paintModels = (providerId) => {
        // 「跟随剧本模型」这一档没有自己的模型可选 —— 摆一个占位，
        // 免得看起来像"还没选模型"
        if (opts.follow && !providerId) {
          modelSel.innerHTML = '';
          modelSel.append(h('option', { value: '', selected: true }, '（跟随剧本模型）'));
          return;
        }
        // 「不做」是一个正经的选择，不是"还没配"。摆个占位说清楚
        if (opts.none && !providerId) {
          modelSel.innerHTML = '';
          modelSel.append(h('option', { value: '', selected: true }, `（${opts.none}）`));
          return;
        }
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
        opts.follow
          ? h('option', { value: '', selected: !settings[provKey] }, '跟随剧本模型')
          : null,
        opts.none
          ? h('option', { value: '', selected: !settings[provKey] }, opts.none)
          : null,
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

    /**
     * 图生图模型单独摆一行。
     *
     * 它不是可有可无的选项 —— **一致性引擎第③层（参考图）全靠它**。
     * 文生图模型不认参考图字段，带上也会被直接忽略；这里配好之后，
     * 只要这一镜带了设定集参考图，出图就会自动切到它。
     * 之前这个字段藏在设置文件里、代码里从没用过，于是参考图一张都没生效。
     */
    const editModelInput = h('input', {
      type: 'text', class: 'mono',
      value: settings.imageEditModel || '',
      placeholder: '例：doubao-seededit-3-0-i2i-250628',
      oninput: (e) => (pending.imageEditModel = e.target.value.trim())
    });
    routeGrid.append(
      h('div', { class: 'field' },
        h('label', {}, '图生图模型（带参考图时用）'),
        editModelInput,
        h('div', { class: 'field-hint' },
          '一致性引擎的参考图这一层全靠它：带了设定集参考图的那一镜会自动切到这个模型出图。' +
          '留空 = 不切，那样参考图会被文生图模型忽略，人设只能靠文字撑着。'))
    );

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
        // cap:routing
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

    // 这里是**默认值**，不是最终值：每个项目可以有自己的画幅（新建项目时选，
    // 项目页也能改）。手上同时有横屏宣传片和竖屏短剧时，靠这一个全局开关来回切迟早出错。
    const ratioSel = h('select', { onchange: (e) => (pending.aspectRatio = e.target.value) },
      RATIOS.map((r) => h('option', { value: r.id, selected: r.id === (settings.aspectRatio || '16:9') },
        `${r.label} · ${r.hint}`))
    );

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '画面规格'),
        h('p', { class: 'panel-hint' },
          '分辨率越高越贵、出得越慢。建议先用低档跑通全流程、确认分镜和人设都对，最后一遍再拉到高档重出。'),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '视频分辨率'), resSel, resHint),
          h('div', { class: 'field' },
            h('label', {}, '字幕'),
            h('div', { class: 'stack', style: 'gap:4px' },
              check(burnBox, '把字幕烧进画面'),
              h('div', { class: 'field-hint', style: 'margin:0' },
                '不勾也会在成片旁边生成 .srt（那一步不花钱、也不会失败）。' +
                '烧字幕要 FFmpeg 编进了 libass、系统里还得有能显示中文的字体，缺哪个都会失败 —— ' +
                '所以默认不开。就算开了，烧失败也只丢字幕、不丢成片。')))),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '默认画幅'), ratioSel,
            h('div', { class: 'field-hint' },
              '这是', h('b', {}, '新建项目时的默认值'),
              '：每部片子的画幅记在项目上，在「项目」页可以单独改。同时作用于出图和出视频，免得成片里两者打架。')),
          /**
           * 视频提示词的详略。
           *
           * 默认精准是有理由的：带首帧图时，"人长什么样、穿什么、在哪儿、什么光、
           * 什么景别"这些问题**图已经回答了**。文字再复述一遍，模型就得在
           * "照着图"和"照着字"之间选边 —— 而它经常选错，表现就是"视频和分镜图不像"。
           */
          h('div', { class: 'field' },
            h('label', {}, '视频提示词'),
            h('select', { onchange: (e) => (pending.videoPromptMode = e.target.value) },
              h('option', { value: 'precise', selected: (settings.videoPromptMode || 'precise') === 'precise' },
                '精准（推荐）：只说图管不了的部分'),
              h('option', { value: 'full', selected: settings.videoPromptMode === 'full' },
                '完整：连外貌、场景、氛围一起发')),
            h('div', { class: 'field-hint' },
              '出视频时模型同时拿到', h('b', {}, '首帧图'), '和', h('b', {}, '一条提示词'),
              '。图已经定住了人、衣服、场景、光线、景别 —— 精准模式只发图回答不了的那部分：',
              '演什么动作、镜头怎么动、谁在说什么、和上一镜怎么接（约 80 字）。',
              '复述得越多，模型越容易偏离你审过的那张图。',
              '没有首帧的纯文生视频会自动按完整走。'))
        )
      )
    );

    // ── 一致性引擎 ──
    const verifyBox = h('input', { type: 'checkbox', checked: settings.consistencyVerify !== false,
      onchange: (e) => (pending.consistencyVerify = e.target.checked) });
    const refBox = h('input', { type: 'checkbox', checked: settings.useReferenceImages !== false,
      onchange: (e) => (pending.useReferenceImages = e.target.checked) });
    /**
     * 邻镜参考：让同一场戏的每一镜在光线、色调、质感上连得住。
     *
     * 三个选项的差别不在"效果好不好"，在**误差会不会累积** ——
     * 这一点在前五镜完全看不出来，第十镜才露馅，所以必须在选的时候就说清楚。
     */
    const neighborSel = h('select', {
      onchange: (e) => (pending.neighborRef = e.target.value)
    },
      h('option', { value: 'scene-anchor', selected: (settings.neighborRef || 'scene-anchor') === 'scene-anchor' },
        '场景锚（推荐）—— 同场景每一镜都参照该场景的第一张'),
      h('option', { value: 'prev', selected: settings.neighborRef === 'prev' },
        '链式 —— 各自参照上一镜（会逐镜累积误差）'),
      h('option', { value: 'off', selected: settings.neighborRef === 'off' },
        '关掉 —— 只靠设定集参考图'));

    /**
     * 接缝：标了「连续动作」的两镜之间，怎么让画面真的连上。
     *
     * 这一项存在的理由，是老办法有个**只在某些厂商上成立**的前提：
     * 把下一镜那张图锁成这一段的末帧 —— 而这要求厂商收末帧图。
     * 海螺官方口、百炼、Sora 都不收，用那几家时那条路整个是空的，
     * 我们只会说一句"这家不收末帧"，接缝就那么跳着。
     * （谁收谁不收看 catalog 的 videoDefaults.endFrame，不看这段话。）
     */
    const seamSel = h('select', {
      onchange: (e) => (pending.seamMode = e.target.value)
    },
      /**
       * 标签改过一次。原来写着「接住真实末帧（**推荐**）」和「**只**锁末帧」——
       * 这两个词把选择引偏了：
       *
       * 「只锁末帧」其实就是**首尾帧**，本镜的图当首帧、下一镜的图当末帧，
       * 两头都是你审过的图。而"推荐"那个是我在以为大多数厂商不收末帧时写的，
       * 后来发现秘塔、可灵、Vidu、方舟都收 —— 前提变了，标签没跟着变。
       *
       * 现在把两条各自的**代价**写在名字里，让人照着自己的厂商选，
       * 而不是照着一个过时的"推荐"选。
       */
      h('option', { value: 'tail', selected: settings.seamMode === 'tail' },
        '接住真实末帧 —— 上一段的最后一帧当首帧。所有厂商都支持，但误差会沿着链累积'),
      h('option', { value: 'lock', selected: (settings.seamMode || 'lock') === 'lock' },
        '首尾帧 —— 本镜的图当首帧、下一镜的图当末帧。两头都是你审过的图，要厂商收末帧'),
      h('option', { value: 'off', selected: settings.seamMode === 'off' },
        '关掉 —— 只靠提示词衔接'));

    const thresholdInput = h('input', { type: 'number', min: 0, max: 100, value: settings.consistencyThreshold,
      oninput: (e) => (pending.consistencyThreshold = Number(e.target.value)) });
    const retryInput = h('input', { type: 'number', min: 0, max: 5, value: settings.consistencyMaxRetries,
      oninput: (e) => (pending.consistencyMaxRetries = Number(e.target.value)) });


    /**
     * 「合成」这一整块原来**一个控件都没有**。
     *
     * 时长策略、自动剪辑、音效音量三样都只活在 settings.js 的默认值里 ——
     * 也就是说：谁都改不了，而它们恰恰决定了成片好不好看。
     * 用户看完成片报"画面还没演示完就切了""13个片13个音效很乱"，
     * 而我当时让他去「设置 → 音效音量」—— 那个地方不存在。
     *
     * 加一个功能却不给入口，和没加是一样的；更糟的是**我以为加了**。
     */
    const durSel = h('select', { onchange: (e) => (pending.durationPolicy = e.target.value) },
      h('option', { value: 'keep', selected: (settings.durationPolicy || 'keep') === 'keep' },
        '保留完整片段（推荐）—— 每一镜演完再切'),
      h('option', { value: 'trim', selected: settings.durationPolicy === 'trim' },
        '按分镜时长裁剪 —— 总长准，但可能切在动作中途'));
    const autoCutBox = h('input', {
      type: 'checkbox',
      checked: settings.autoCut !== false,
      onchange: (e) => (pending.autoCut = e.target.checked)
    });
    const sfxGainIn = h('input', {
      type: 'number', min: 0, max: 1, step: 0.05,
      value: settings.sfxGain ?? 0.35,
      oninput: (e) => (pending.sfxGain = Number(e.target.value))
    });

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '合成'),
        h('p', { class: 'panel-hint' },
          '这三样只影响**合成那一步**，改完重新合成一次就生效 —— 不用重新生成任何镜头，不花钱。'),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' },
            h('label', {}, '时长策略'), durSel,
            h('div', { class: 'field-hint' },
              '各家视频模型只出固定档（秘塔 5/10/15，海螺 6/10）。分镜写 4 秒、厂商给 5 秒时，',
              h('b', {}, '裁剪会切掉最后那一秒 —— 而那一秒正好是动作收尾'),
              '（模型是按"这一段演完"编排节奏的：起手慢、收在最后）。',
              '所以默认保留完整片段：目标时长决定拆多少镜，拆完之后让每一镜演完，',
              '比让总长精确命中一个估算值要紧得多。真要卡死总长再改回裁剪。')),
          h('div', { class: 'field' },
            h('label', {}, '音效音量'), sfxGainIn,
            h('div', { class: 'field-hint' },
              '相对台词的倍数，0.35 约等于 −9dB。音效必须压在台词底下 —— 等响的话一声关门就能盖掉一句台词。',
              h('b', {}, '填 0 = 这次不混音效'), '：音效文件还在，把值调回去重新合成就能听见。',
              '每一镜都配一个环境音的话，连起来是一串互不相干的响动，比完全没有音效更糟 —— ',
              '先调 0 听一遍纯净版，再决定留哪几处。'))),
        h('div', { class: 'stack', style: 'gap:10px' },
          check(autoCutBox,
            '自动剪辑：跳过每段开头不动的那几帧（图生视频"起势"时的首帧复制）'))),
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '一致性引擎'),
        h('p', { class: 'panel-hint' },
          '四层叠加：冻结设定 → 固定种子 → 参考图引用 → 视觉复核。第三层是效果最大的一层，第四层负责把"错了没人发现"变成"错了自动重来"。'),
        h('div', { class: 'stack', style: 'gap:10px' },
          check(refBox, '出镜头图时带上角色设定图作为参考图（最关键的一层，建议保持开启）'),
          check(verifyBox, '每张成图做视觉复核（会多一次模型调用，换来自动纠错）')
        ),
        h('div', { class: 'field', style: 'margin-top:14px' },
          h('label', {}, '邻镜参考（同一场戏的画面连贯）'), neighborSel,
          h('div', { class: 'field-hint' },
            '「链式」是最容易想到的做法：第 2 镜参照第 1 镜，第 3 镜参照第 2 镜……'
            + '但每次生成都有损耗，第 10 镜参照的已经是漂过八次的那张，而且回不去。'
            + '「场景锚」让同场景每一镜都参照**同一张**：效果一样（都像同一张，自然彼此也像），'
            + '误差却是常数而不是累加。只有标了「连续动作」的镜头才退回真链式 —— '
            + '那时候要的是"上一帧的下一瞬间"，锚给不了。'),
          h('div', { class: 'field-hint' },
            '⚠ 这一层要「分镜图用图生图」开着才生效（文生图通道收不了参考图）。')),
        h('div', { class: 'field', style: 'margin-top:14px' },
          h('label', {}, '接缝（「连续动作」两镜之间怎么连上）'), seamSel,
          /**
           * 这一句必须排在最前面。
           *
           * 用户按选项字面上那句"所有厂商都管用"出了一批片子，然后说"并不是这样啊"。
           * 他没看错：厂商侧确实没门槛，但接缝要真走这条路，前提是**这两镜标着
           * 「连续动作」**——而这个标记从来不会自动推断出来。这个前提原来写在
           * 第三条"⚠ 代价"里，等于藏起来了。前提不是代价，它得先说。
           */
          h('div', { class: 'field-hint' },
            '⚠ 先看这条：不管选哪个模式，接缝只在标着「连续动作」的两镜之间做。'
            + '「同场景换机位」和「换场景」本来就该硬切 —— 全都接上的话，整部片子会变成一个没剪过的长镜头。'
            + '而「连续动作」不会自动判出来，只可能是拆分镜时模型标的、或者你在分镜里手选的。'
            + '出视频前日志里会写清楚这一批有哪几处接缝会真接上。'),
          h('div', { class: 'field-hint' },
            '「只锁末帧」是老办法：要求上一段**结束在**下一镜那张图上。'
            + '问题是这要厂商收末帧图 —— 海螺官方口、百炼、Sora 都不收，'
            + '用那几家时这条等于没做，接缝会明显跳一下。'),
          h('div', { class: 'field-hint' },
            '「接住真实末帧」是反过来做：等上一段跑完，**抠出它真正的最后一帧**，'
            + '拿那一帧当这一镜的首帧。每一家 i2v 都收首帧图，所以这条在所有厂商上都成立，'
            + '而且用的是真渲染出来的那一帧，接缝在像素上就是连的。'),
          h('div', { class: 'field-hint' },
            '⚠ 代价：这一镜自己那张审过的分镜图就不当首帧用了（图还在，审片和重出还看它）；'
            + '而且这是链式，误差会沿着链累积 —— 所以只在「连续动作」上做，'
            + '而那种链一个场次里通常只有两三镜。末帧太糊时会自动退回用分镜图，并说一声。'),
          h('div', { class: 'field-hint' },
            '⚠ 抠帧要 FFmpeg。没装的话这一项不生效，会明确说出来。')),
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

    // 系统代理：只有桌面版有这条路。Node 自带的 fetch 不读系统代理，
    // 公司网络下就是连不上（UND_ERR_CONNECT_TIMEOUT），而这跟密钥毫无关系。
    const proxyAvailable = state.health?.systemProxyAvailable;
    const proxyBox = h('input', {
      type: 'checkbox',
      checked: settings.useSystemProxy === true,
      disabled: !proxyAvailable,
      onchange: (e) => (pending.useSystemProxy = e.target.checked)
    });

    const autoCheckBox = h('input', {
      type: 'checkbox',
      checked: settings.autoCheckOnStart !== false,
      onchange: (e) => (pending.autoCheckOnStart = e.target.checked)
    });

    let ff = state.catalog.ffmpeg;

    /**
     * FFmpeg 这一块单独重画，因为它是"放个文件进去就该立刻好"的东西。
     * 让人为了让应用发现一个文件而重启，是很没道理的一步。
     */
    const ffBadge = h('span', { class: 'badge' });
    const ffText = h('p', { class: 'panel-hint' });
    const ffWhere = h('div', { class: 'field-hint', style: 'margin-top:8px' });

    function paintFfmpeg() {
      clear(ffBadge).append(ff.available ? `FFmpeg ${ff.source}` : 'FFmpeg 未安装');
      ffBadge.className = `badge ${ff.available ? 'ok' : 'warn'}`;
      ffText.textContent = ff.available ? ff.version : ff.hint;
      clear(ffWhere);
      if (ff.available) {
        ffWhere.append(h('span', { class: 'mono' }, ff.path));
      } else if (ff.dropDir) {
        // 把绝对路径印出来，别让人猜"本应用的 bin 目录"是哪个 ——
        // 装完之后源码里那个 bin 根本不在安装目录里
        ffWhere.append(
          '把 ffmpeg.exe 放到这个目录（已经建好了），再点「重新检测」：',
          h('div', { class: 'mono', style: 'margin-top:4px;user-select:all' }, ff.dropDir)
        );
      }
    }

    const ffRecheck = h('button', {
      class: 'btn ghost sm',
      onclick: async () => {
        ffRecheck.disabled = true;
        try {
          ff = await api('/ffmpeg');
          state.catalog.ffmpeg = ff;
          paintFfmpeg();
          toast(ff.available ? `找到了：${ff.path}` : '还是没找到，看下面那个目录对不对', ff.available ? 'ok' : 'err');
        } finally {
          ffRecheck.disabled = false;
        }
      }
    }, '重新检测');

    paintFfmpeg();

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '本机环境', ffBadge, ffRecheck),
        ffText,
        ffWhere,
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
        ),
        h('div', { class: 'stack', style: 'gap:6px;margin-top:12px' },
          check(autoCheckBox,
            '打开应用时自动探一遍当前路由到的服务商（只发最便宜的探针，不出图不出视频）'),
          h('div', { class: 'field-hint', style: 'margin:0 0 6px 26px' },
            '配置坏了的代价不是"自检红一下"，而是你跑到第 04 步、等了两分钟，才被告知密钥没配。'),
          check(proxyBox,
            proxyAvailable
              ? '走 Windows 的系统代理（公司网络连不上厂商时打开）'
              : '走 Windows 的系统代理 —— 这是桌面版专有的，当前是命令行模式，用不了'),
          h('div', { class: 'field-hint', style: 'margin:0' },
            '默认关。关着的时候一律直连，和浏览器无关；如果厂商自检报 UND_ERR_CONNECT_TIMEOUT、' +
            '但浏览器打得开那个域名，多半就是缺代理，打开这个开关再试。'))
      )
    );

    /**
     * ── 手机遥控 ──
     *
     * 不需要任何服务器：手机和电脑在同一个 Wi-Fi 就够了。
     * 这条口子另开一个端口监听（0.0.0.0），规矩和本机那条分开写死 ——
     * 它后面挂着你的 API 密钥和额度，所以必须配对码，而且只认私网地址。
     *
     * 撤销权留在电脑上：手机丢了、给同事看过一次之后，点「换一个」就能把它踢下线。
     */
    const lanHost = h('div', {});
    async function paintLan(fresh = null) {
      const st = fresh || (await api('/lan').catch(() => null));
      clear(lanHost);
      if (!st) {
        lanHost.append(h('p', { class: 'field-hint' }, '读不到手机遥控的状态'));
        return;
      }
      const toggle = h('button', {
        class: `btn ${st.running ? 'ghost' : 'primary'}`,
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await api('/lan', { method: 'POST', body: { enabled: !st.running } });
            if (r.token) lastToken = r.token;
            await paintLan(r);
            toast(r.running ? '手机遥控已打开' : '已关闭', 'ok');
          } catch (err) {
            toast(err.message, 'err');
            e.target.disabled = false;
          }
        }
      }, st.running ? '关闭手机遥控' : '打开手机遥控');

      add(lanHost,
        h('div', { class: 'inline', style: 'margin-bottom:10px' },
          toggle,
          st.running
            ? h('button', {
                class: 'btn ghost',
                title: '把旧配对码作废。手机丢了、或者给别人看过一次之后用这个',
                onclick: async () => {
                  if (!confirm('换一个配对码？已经连上的手机会被踢下线，需要重新输入。')) return;
                  const r = await api('/lan', { method: 'POST', body: { rotate: true } });
                  lastToken = r.token || '';
                  await paintLan(r);
                  toast('配对码已更换', 'ok');
                }
              }, '换一个配对码')
            : null),
        st.running
          ? h('div', {},
              h('div', { class: 'field-hint', style: 'margin:0 0 6px' },
                '手机连上同一个 Wi-Fi，用浏览器打开下面任意一个地址，把配对码敲进去。'
                + '打开后点浏览器的「添加到主屏幕」，它就有了自己的图标，和 APP 一样全屏。'),
              ...(st.urls || []).map((u) =>
                h('div', { class: 'mono', style: 'font-size:13px;margin:3px 0' },
                  u,
                  h('button', {
                    class: 'btn ghost sm', style: 'margin-left:8px',
                    onclick: () => {
                      // 带上配对码的完整地址：手机上少敲一次
                      const full = lastToken ? `${u}?k=${lastToken}` : u;
                      navigator.clipboard?.writeText(full);
                      toast(lastToken ? '已复制（含配对码）' : '已复制', 'ok');
                    }
                  }, '复制'))),
              lastToken
                ? h('div', { style: 'margin-top:10px' },
                    h('label', {}, '配对码'),
                    h('div', { class: 'mono', style: 'font-size:22px;letter-spacing:.24em' }, lastToken),
                    h('div', { class: 'field-hint' },
                      '这串码只在这台电脑上显示。手机那一侧查不到它 —— 查得到的话，配对码就等于没有。'))
                : h('div', { class: 'field-hint', style: 'margin-top:8px' },
                    '配对码这次没回传（应用重启过）。点「换一个配对码」拿一串新的。'),
              (st.addresses || []).length === 0
                ? h('div', { class: 'note-line warn' }, '没找到局域网地址 —— 这台电脑可能没连 Wi-Fi/网线，或者被虚拟网卡挡住了。')
                : null)
          : h('div', { class: 'field-hint', style: 'margin:0' },
              '默认关着。打开之后会',
              h('b', {}, '另开一个端口'),
              '监听局域网，只认私网地址、必须配对码，错 10 次锁 10 分钟。'
              + '出门在外想用的话，装个 Tailscale 之类的组网工具就行，不用租服务器。'));
    }
    let lastToken = '';
    paintLan();

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '手机遥控'),
        h('p', { class: 'panel-hint' },
          '手机上看进度、审分镜、看成片，也能点「重出这一镜」。'
          + '引擎始终在这台电脑上 —— 密钥、FFmpeg、几百 MB 的中间文件都不该跑到手机里去。'),
        lanHost
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
          `配置文件：${state.health.dataDir}${state.health.platform === 'win32' ? '\\' : '/'}settings.json`),
        // 跑的是哪一版。服务器上更新完看这一行就知道生效没有 ——
        // 比"去点个新功能试试"可靠得多（试出来没有还分不清是哪种原因）
        h('span', { style: 'font-size:12px;color:var(--ink-faint)' },
          `版本 ${state.health.version || '?'}（${state.health.build || 'dev'}）`)
      )
    );

    /**
     * ── 对象存储（阿里云 OSS）──
     *
     * 最实际的理由不是"省服务器硬盘"，而是**参考图必须是公网 URL**：
     * 万相、即梦这些厂商的图生图通道只收 https 地址，不收本地文件也不收 base64。
     * 角色设定图躺在本机硬盘上就永远发不出去 —— 一致性链路里最关键的那一环
     * 因此断掉。有了 OSS，本地文件传上去就有了地址，这条路才通。
     *
     * AccessKey 走保险箱，和模型密钥同一套规矩：只在这台机器上，不落明文。
     */
    const ossHost = h('div', {});
    async function paintOss() {
      const cfg = await api('/oss').catch(() => null);
      clear(ossHost);
      if (!cfg) {
        ossHost.append(h('p', { class: 'field-hint' }, '读不到对象存储的配置'));
        return;
      }

      const enabled = h('input', { type: 'checkbox', checked: cfg.enabled });
      const region = h('select', {},
        ...cfg.regions.map((r) => h('option', { value: r.id, selected: r.id === cfg.region }, `${r.name}（${r.id}）`)));
      const bucket = h('input', { type: 'text', value: cfg.bucket, placeholder: 'my-bucket' });
      const prefix = h('input', { type: 'text', value: cfg.prefix, placeholder: 'futuredream' });
      const domain = h('input', { type: 'text', value: cfg.customDomain, placeholder: '绑了 CNAME 才填，例：cdn.example.com' });
      const publicRead = h('input', { type: 'checkbox', checked: cfg.publicRead });
      const keyId = h('input', { type: 'password', placeholder: cfg.hasKeyId ? '已配置（留空表示不改）' : 'AccessKey ID' });
      const keySecret = h('input', { type: 'password', placeholder: cfg.hasKeySecret ? '已配置（留空表示不改）' : 'AccessKey Secret' });
      const status = h('div', { class: 'field-hint', style: 'margin-top:10px' },
        cfg.ready ? `就绪：${cfg.host}` : '还没配齐');

      const save = async () => {
        // cap:oss-config
        const secrets = {};
        const idIn = keyId.value.trim();
        const secretIn = keySecret.value.trim();
        /**
         * 存进去之前先拦一道。
         *
         * 这两样的长度是**固定的、而且不一样**：ID 24 位 LTAI 开头，Secret 30 位。
         * 填反了的话，要等到点「测试连接」才会以 403 InvalidAccessKeyId 的形式
         * 冒出来 —— 而那个错误码字面上说的是"这个 ID 不存在"，
         * 没有一个字提到"你可能填反了"。用户于是回一句"我没有填反"，
         * 然后两边一起卡在那儿。
         *
         * 形状是当场看得出来的，就别等到那时候。
         */
        if (idIn && idIn.length === 30 && !/^LTAI/i.test(idIn)) {
          toast('「AccessKey ID」那一栏填的是 30 位、不是 LTAI 开头 —— 那是 Secret 的形状。两栏填反了，换过来再存。', 'err');
          return;
        }
        if (secretIn && /^LTAI/i.test(secretIn) && secretIn.length === 24) {
          toast('「AccessKey Secret」那一栏填的是 LTAI 开头的 24 位 —— 那是 ID 的形状。两栏填反了，换过来再存。', 'err');
          return;
        }
        if (idIn) secrets.ALIYUN_OSS_KEY_ID = idIn;
        if (secretIn) secrets.ALIYUN_OSS_KEY_SECRET = secretIn;
        if (Object.keys(secrets).length) await api('/secrets', { method: 'POST', body: { secrets } });
        await api('/settings', {
          method: 'POST',
          body: {
            oss: {
              enabled: enabled.checked,
              region: region.value,
              bucket: bucket.value.trim(),
              prefix: prefix.value.trim(),
              customDomain: domain.value.trim(),
              publicRead: publicRead.checked
            }
          }
        });
        keyId.value = '';
        keySecret.value = '';
      };

      /**
       * 「这几个框里到底该填什么」是配这一步唯一的卡点。
       *
       * 原来这个面板只解释了每个字段**是干什么的**，却没说**去哪儿拿**——
       * 而卡住人的从来是后者。四步写在这儿，不用去翻文档。
       */
      const guide = h('details', { class: 'field', style: 'margin-bottom:12px' },
        h('summary', { style: 'cursor:pointer;color:var(--beam)' }, '这几个值去哪儿拿？（四步，约五分钟）'),
        h('div', { class: 'field-hint', style: 'margin-top:8px;line-height:1.7' },
          h('div', {}, h('b', {}, '① 建一个 Bucket'), '　阿里云控制台 → 对象存储 OSS → 创建 Bucket。'),
          h('div', { style: 'margin-left:14px' },
            '名字随便起（填到下面「Bucket」），',
            h('b', {}, '地域要和你用的厂商同一侧'),
            '：秘塔、海螺、方舟、百炼都在国内，就选国内地域（北京/上海/杭州都行）。'
            + '桶在境外而厂商在境内，它很可能拉不到你的参考图 —— 那正是「cannot download media URL」最常见的原因。'),
          h('div', { style: 'margin-left:14px' }, '读写权限保持默认的', h('b', {}, '私有'), '，下面那个「桶是公共读」也别勾。'),
          h('div', { style: 'margin-top:8px' }, h('b', {}, '② 建一个 RAM 用户，只给它这一个桶的权限')),
          h('div', { style: 'margin-left:14px' },
            '控制台 → 访问控制 RAM → 用户 → 创建用户，勾', h('b', {}, '「使用永久 AccessKey 访问」'), '。'
            + '建完会给你一对 AccessKey ID / Secret —— ',
            h('b', {}, 'Secret 只显示这一次'), '，当场复制。'),
          h('div', { style: 'margin-left:14px' },
            '然后给它授权：AliyunOSSFullAccess 最省事；讲究一点就自定义策略，只放这一个桶。'
            + '别用主账号的 AccessKey —— 那把钥匙能动你账号里的一切。'),
          h('div', { style: 'margin-top:8px' }, h('b', {}, '③ 填下面这几个框')),
          h('div', { style: 'margin-left:14px' },
            '地域和 Bucket 照①填；AccessKey 那两个照②填；'
            + '「路径前缀」随便写一个（比如 futuredream），它让同一个桶还能放别的东西，也方便回头整批删；'
            + '「自定义域名」除非你绑过 CNAME，否则留空。'),
          h('div', { style: 'margin-top:8px' }, h('b', {}, '④ 点下面的「测试连接」')),
          h('div', { style: 'margin-left:14px' },
            '它会真的写一个小文件、读回来、再删掉 —— 签名对不对只有这么试才知道，而且不花钱。'
            + '通了就成了；不通的话报错里会点名是地域、Bucket 名、还是 RAM 权限。'),
          h('div', { style: 'margin-top:8px;color:var(--ink-dim)' },
            '花钱吗：存储费几乎可以忽略（一部片子的参考图就几 MB）；'
            + '真正计费的是外网流量，而厂商拉一次参考图也就几 MB。比起因为内联发图而反复失败重传，这条便宜得多。')));

      ossHost.append(
        guide,
        h('div', { class: 'field' },
          h('label', {}, h('span', { class: 'inline' }, enabled, ' 开启对象存储')),
          h('div', { class: 'field-hint' },
            '开了之后，出好的图和视频会传一份到 OSS，参考图也就有了公网地址 —— '
            + '万相这类只收 https 地址的出图模型靠的就是这个；'
            + '而且请求体会从几 MB 掉到几 KB，"图带多了""请求超时"那一类多半跟着消失。')),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '地域'), region),
          h('div', { class: 'field' }, h('label', {}, 'Bucket'), bucket)),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '路径前缀'), prefix),
          h('div', { class: 'field' }, h('label', {}, '自定义域名'), domain)),
        h('div', { class: 'grid2' },
          /**
           * 把**存着的那份**摆出来。
           *
           * 「已配置（留空表示不改）」这句话藏住了一件要命的事：只填一栏
           * 保存之后，另一栏还留着上回粘错的东西，而界面上永远只显示"已配置"。
           * 用户完全有理由说"我没有填反"—— 他这一次确实没有。
           * 错的是三次之前那一份，而它一直看不见。
           */
          h('div', { class: 'field' },
            h('label', {}, 'AccessKey ID'), keyId,
            cfg.keyIdHint
              ? h('div', { class: 'field-hint' },
                  `现在存着的是：${cfg.keyIdHint}`,
                  /^LTAI/i.test(cfg.keyIdHint) ? '' : '　⚠ 阿里云的 ID 是 LTAI 开头、24 位，这份不像',
                  /（30 位）/.test(cfg.keyIdHint) ? '　⚠ 30 位是 Secret 的长度 —— 这一栏多半存着一把 Secret' : '')
              : null),
          h('div', { class: 'field' },
            h('label', {}, 'AccessKey Secret'), keySecret,
            cfg.keySecretLen
              ? h('div', { class: 'field-hint' },
                  `现在存着的是 ${cfg.keySecretLen} 位`,
                  cfg.keySecretLen === 30 ? '（长度对）' : '　⚠ 阿里云的 Secret 是 30 位，这份不是')
              : null)),
        h('div', { class: 'field' },
          h('label', {}, h('span', { class: 'inline' }, publicRead, ' 桶是公共读')),
          h('div', { class: 'field-hint' },
            '公共读给的是永久地址；不勾则给限时签名地址。默认按私有办 —— '
            + '默认值必须是安全的那一个，想公开该是主动的选择。'
            + '但注意：出图模型要拉参考图，那个地址得让它拉得到。')),
        h('div', { class: 'inline' },
          h('button', {
            class: 'btn primary',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await save();
                toast('已保存', 'ok');
                await paintOss();
              } catch (err) {
                toast(err.message, 'err');
                e.target.disabled = false;
              }
            }
          }, '保存'),
          h('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              status.textContent = '正在传一个探针上去…';
              try {
                await save();
                const r = await api('/oss/probe', { method: 'POST' });
                status.textContent = (r.steps || [])
                  .map((x) => `${x.step}${x.ok ? ' ✓' : ` ✕ ${x.message || ''}`}`)
                  .join('　') + (r.ok ? `　—— 通了（签名 ${r.signVersion}，${r.host}）` : `　—— ${r.error || '没通'}`);
                toast(r.ok ? '对象存储可用' : '没通，看下面那行', r.ok ? 'ok' : 'err');
              } catch (err) {
                status.textContent = err.message;
                toast(err.message, 'err');
              } finally {
                e.target.disabled = false;
                await refreshCatalog().catch(() => {});
              }
            }
          }, '测试连接')),
        status
      );
    }

    /**
     * ── 账号与设备 ──
     *
     * 那串 32 位口令能用，但它只回答"你知不知道那个秘密"。真正要回答的是：
     * 谁进来了、怎么换、丢了一台怎么办。所以这里管的是后两件 ——
     * 尤其是**踢掉一台不影响别的**，那是这套东西存在的全部理由。
     */
    const acctHost = h('div', {});
    async function paintAccount() {
      const me = await api('/account/me').catch(() => null);
      clear(acctHost);
      if (!me?.user) {
        acctHost.append(h('p', { class: 'field-hint' },
          '这台服务还在用访问口令。想换成账号密码：退出登录后，在登录屏上顺手填一个用户名和密码就行。'));
        return;
      }

      const oldPw = h('input', { type: 'password', autocomplete: 'current-password' });
      const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
      // cap:account-devices
      const sessions = await api('/account/sessions').catch(() => ({ sessions: [] }));

      const rows = h('div', {});
      for (const s2 of sessions.sessions || []) {
        const current = s2.id === sessions.current;
        rows.append(
          h('div', { class: 'row', style: 'padding:9px 0;border-bottom:1px solid var(--line-soft)' },
            h('div', {},
              h('b', {}, s2.device),
              current ? h('span', { class: 'badge', style: 'margin-left:8px' }, '当前这台') : null,
              h('div', { class: 'field-hint' },
                `登录于 ${new Date(s2.createdAt).toLocaleString('zh-CN')}`)),
            h('div', { class: 'shrink' },
              h('button', {
                class: 'btn ghost sm',
                onclick: async (e) => {
                  e.target.disabled = true;
                  await api(`/account/sessions/${s2.id}`, { method: 'DELETE' });
                  toast(current ? '已退出这台，马上要重新登录' : '已踢下线', 'ok');
                  if (current) return location.reload();
                  return paintAccount();
                }
              }, current ? '退出登录' : '踢下线')))
        );
      }

      acctHost.append(
        h('p', { class: 'field-hint' }, `当前账号：${me.user}`),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '原密码'), oldPw),
          h('div', { class: 'field' }, h('label', {}, '新密码（至少 8 位）'), newPw)),
        h('div', { class: 'inline' },
          h('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api('/account/password', {
                  method: 'POST',
                  body: { oldPassword: oldPw.value, newPassword: newPw.value }
                });
                oldPw.value = '';
                newPw.value = '';
                // 改密码不踢已登录的设备 —— 否则每次改密码都要把所有设备重登一遍
                toast('密码已改。已登录的设备不受影响，想全踢就点下面那个', 'ok');
              } catch (err) {
                toast(err.message, 'err');
              } finally {
                e.target.disabled = false;
              }
            }
          }, '改密码')),
        h('h3', { style: 'margin:18px 0 6px;font-size:13px' }, '登录着的设备'),
        h('p', { class: 'field-hint' },
          '一台设备一个会话。手机丢了就在这里把它踢下线 —— 不影响别的设备，也不用改密码。'),
        rows,
        h('div', { class: 'inline', style: 'margin-top:12px' },
          h('button', {
            class: 'btn ghost',
            onclick: async (e) => {
              // "除了我"会让人以为安全了，而那台"我"可能正是被别人拿着的那台
              if (!confirm('把所有设备都踢下线？包括当前这台，之后要重新登录。')) return;
              e.target.disabled = true;
              await api('/account/sessions', { method: 'DELETE' });
              location.reload();
            }
          }, '全部踢下线'))
      );
    }

    /**
     * ── 镜头分级：贵模型只用在看得出差别的地方 ──
     *
     * 视频那一步是最大的一笔开销，而且按镜计费。但空镜、远景、过渡镜
     * 常常占一部片子的三四成 —— 那些地方便宜模型和贵模型看不出差别，
     * 全片一律用最贵的，等于为看不出差别的地方付全价。
     *
     * 界面上**先给这部片子的分档摘要**，人才判断得出值不值得配：
     * 低档只有一镜的话，配这一层就是白折腾。
     */
    const tierHost = h('div', {});
    async function paintTiers() {
      const info = await api('/tiers').catch(() => null);
      clear(tierHost);
      if (!info) {
        tierHost.append(h('p', { class: 'field-hint' }, '读不到镜头分级配置'));
        return;
      }
      const videoProviders = state.catalog.providers.filter((p) => (p.capabilities || []).includes('t2v'));
      const cfg = { ...info.config };

      // 当前项目分下来是什么样 —— 没打开项目就不显示，别摆一行"0/0/0"
      if (state.projectId) {
        api(`/projects/${state.projectId}/tiers`).then((t) => {
          const s2 = t.summary;
          tierHost.prepend(h('div', { class: 'note-line' },
            `当前项目 ${s2.total} 镜分下来：`,
            h('b', {}, ` 关键 ${s2.high}`), ` · 一般 ${s2.normal} · `,
            h('b', {}, `空镜 ${s2.low}`),
            s2.low ? `　—— 这 ${s2.low} 镜换便宜模型看不出差别` : '　—— 这部片子没有空镜，配了也省不下'));
        }).catch(() => {});
      }

      for (const t of info.tiers) {
        const provSel = h('select', {},
          h('option', { value: '' }, '跟随主路由（不额外指定）'),
          ...videoProviders.map((p) => h('option', { value: p.id, selected: cfg[t.id]?.provider === p.id }, p.name)));
        const modelInput = h('input', {
          type: 'text', placeholder: '模型 ID（留空 = 跟随主路由）',
          value: cfg[t.id]?.model || ''
        });
        const sync = () => {
          cfg[t.id] = provSel.value && modelInput.value.trim()
            ? { provider: provSel.value, model: modelInput.value.trim() }
            : null;
        };
        provSel.onchange = sync;
        modelInput.oninput = sync;

        tierHost.append(
          h('div', { class: 'field', style: 'margin-top:14px' },
            h('label', {}, t.label),
            h('div', { class: 'field-hint', style: 'margin-bottom:6px' }, t.hint),
            h('div', { class: 'grid2' }, provSel, modelInput)));
      }

      tierHost.append(
        h('div', { class: 'inline', style: 'margin-top:14px' },
          h('button', {
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                // cap:tier-routing
                await api('/settings', { method: 'POST', body: { videoTiers: cfg } });
                await refreshCatalog();
                toast('已保存。下一批出视频按这个走', 'ok');
              } catch (err) {
                toast(err.message, 'err');
              } finally {
                e.target.disabled = false;
              }
            }
          }, '保存分级')),
        h('div', { class: 'field-hint', style: 'margin-top:8px' },
          '判定依据只有两样看得懂的东西：景别 + 这一镜有没有角色。'
          + '不用模型打分 —— 判错时你得能一眼看出为什么，才知道该不该手动改它。'
          + '判错的那几镜，在分镜卡片上单独改。'));
    }

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '镜头分级（省钱）'),
        h('p', { class: 'panel-hint' },
          '不配就是现在的行为，一模一样 —— 这一层是选配。只有你明确给某一档指定了别的模型，它才开始起作用。'),
        tierHost)
    );
    paintTiers();

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '账号与设备'),
        h('p', { class: 'panel-hint' },
          '账号密码解决的是"谁能进"。数据在哪儿是另一件事 —— 想让电脑和手机看到同一份，'
          + '要让电脑版也连服务器（菜单「文件 → 引擎在哪儿跑…」）。'),
        acctHost)
    );
    paintAccount();

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '对象存储'),
        h('p', { class: 'panel-hint' },
          '真写、真读、真删一次才算通。只"看看能不能连上"是不够的 —— '
          + '一把只读的 AccessKey 在任何测试里都表现正常，直到第一次出图完才报错，那时候钱已经花了。'),
        ossHost)
    );
    paintOss();

    return root;
  }
};
