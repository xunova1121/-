/**
 * 手机端：遥控 + 审片。
 *
 * ── 它不是什么 ──
 *
 * 不是把电脑版缩小。电脑版那一屏摆着服务商、模型、种子、提示词、请求记录 ——
 * 那些是**配置和排错**，坐在电脑前做才合适。手机上真正要做的只有三件：
 *   看进度（一步跑十几分钟，你总不能一直守着电脑）
 *   审片（哪一镜不对，当场标出来重出）
 *   看成片
 *
 * ── 引擎在电脑上，手机只是遥控器 ──
 *
 * 密钥、FFmpeg、几百 MB 的中间文件都在那台机器上，也只该在那台机器上。
 * 手机丢了不等于密钥丢了。所以这一端不碰任何配置，只发指令、只看结果。
 *
 * ── 配对码 ──
 *
 * 局域网里谁都能扫到这个端口，后面挂着的是你的额度。所以除了这个页面本身，
 * 每一条请求都要带配对码（服务端 checkKey）。码存在 localStorage，
 * 电脑上点「换一个」就能把丢了的手机踢下线。
 */

const KEY_STORE = 'fd.m.key';
const PROJ_STORE = 'fd.m.project';

// ───────────────────────── 小工具 ─────────────────────────

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

let authKey = '';

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(authKey ? { 'X-FD-Key': authKey } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

/**
 * NDJSON 流。手机端也要能发起整步任务 —— 出门在外看到"第 3 镜失败了"，
 * 总得能当场点一下重出，而不是记在心里回去再说。
 */
async function stream(path, body, onEvent) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authKey ? { 'X-FD-Key': authKey } : {}) },
    body: JSON.stringify(body || {})
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* 半行，等下一块 */
      }
    }
  }
}

/** 图片和视频也要带配对码：<img> 没法加自定义头，所以走查询串 */
function media(p, v) {
  return `/media?p=${encodeURIComponent(p)}${v ? `&v=${v}` : ''}${authKey ? `&k=${encodeURIComponent(authKey)}` : ''}`;
}

// ───────────────────────── 流水线定义（和电脑端同一套口径）─────────────────────────

const STEPS = [
  { id: 'bible', label: '设定集' },
  { id: 'script', label: '分镜' },
  { id: 'assets', label: '镜头出图' },
  { id: 'video', label: '视频生成' },
  { id: 'voice', label: '配音' },
  { id: 'compose', label: '合成' }
];

function progressOf(project, id) {
  const shots = project?.shots || [];
  const bible = project?.bible;
  switch (id) {
    case 'bible': {
      const all = bible ? [...bible.characters, ...bible.scenes, ...(bible.props || [])] : [];
      return { done: all.filter((x) => x.sheetPath).length, total: all.length };
    }
    case 'script':
      return { done: shots.length, total: shots.length };
    case 'assets':
      return { done: shots.filter((s) => s.imagePath).length, total: shots.length };
    case 'video':
      return { done: shots.filter((s) => s.videoPath).length, total: shots.length };
    case 'voice': {
      const need = shots.filter((s) => s.dialogue?.trim());
      return { done: need.filter((s) => s.audioPath).length, total: need.length };
    }
    case 'compose':
      return { done: project?.outputs?.video ? 1 : 0, total: 1 };
    default:
      return { done: 0, total: 0 };
  }
}

function stateOf(project, id) {
  const { done, total } = progressOf(project, id);
  if (!total) return project?.stageStatus?.[id] === 'done' ? 'done' : 'pending';
  if (done >= total) return 'done';
  return done > 0 ? 'partial' : 'pending';
}

// ───────────────────────── 状态 ─────────────────────────

const app = document.querySelector('#app');
let project = null;
let projects = [];
let tab = 'flow';
const job = { running: false, label: '', message: '', fail: 0 };

// ───────────────────────── 配对 ─────────────────────────

function paintPair(reason = '') {
  clear(app).append(
    h('div', { class: 'pair' },
      h('h1', {}, '未来创梦 · 手机端'),
      h('p', { class: 'muted' },
        '这台手机要和电脑上的应用配对一次。电脑上打开「设置 → 手机遥控」，把那串 8 位配对码敲进来。'),
      reason ? h('p', { class: 'muted', style: 'color:var(--alarm)' }, reason) : null,
      (() => {
        const input = h('input', {
          class: 'code',
          type: 'text',
          inputmode: 'latin',
          autocapitalize: 'characters',
          autocomplete: 'off',
          placeholder: 'ABCD2345',
          maxlength: 12
        });
        const go = h('button', { class: 'btn primary block', style: 'margin-top:14px' }, '连接');
        go.onclick = async () => {
          const code = input.value.trim().toUpperCase();
          if (!code) return toast('先把配对码敲进来', 'err');
          go.disabled = true;
          authKey = code;
          try {
            await api('/health');
            localStorage.setItem(KEY_STORE, code);
            toast('连上了', 'ok');
            boot();
          } catch (err) {
            authKey = '';
            go.disabled = false;
            toast(err.status === 401 ? '配对码不对' : err.message, 'err');
          }
        };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') go.click();
        };
        return h('div', { style: 'margin-top:20px' }, input, go);
      })(),
      h('p', { class: 'muted', style: 'margin-top:22px' },
        '连不上的话检查三件事：手机和电脑在同一个 Wi-Fi；电脑上的「手机遥控」开关是开着的；地址里的 IP 和电脑上显示的一致。')
    )
  );
}

// ───────────────────────── 主界面 ─────────────────────────

function paint() {
  clear(app).append(
    h('div', { class: 'top' },
      // 手上同时做着几部片子是常事 —— 写死"第一个项目"等于一半时候打开的是错的那部
      projects.length > 1
        ? h('select', {
            class: 'top-pick',
            onchange: async (e) => {
              localStorage.setItem(PROJ_STORE, e.target.value);
              await reload();
            }
          }, projects.map((p) => h('option', { value: p.id, selected: p.id === project?.id }, p.title)))
        : h('div', { class: 'top-title' }, project?.title || '未来创梦'),
      h('button', {
        class: 'btn sm',
        onclick: async () => {
          await reload();
          toast('已刷新');
        }
      }, '刷新')),
    h('div', { class: 'body' }, tab === 'flow' ? paintFlow() : tab === 'shots' ? paintShots() : paintFilm()),
    paintLive(),
    h('div', { class: 'tabs' },
      ...[
        ['flow', '◍', '流水线'],
        ['shots', '▤', '分镜'],
        ['film', '▶', '成片']
      ].map(([id, dot, label]) =>
        h('button', {
          class: `tab ${tab === id ? 'active' : ''}`,
          onclick: () => {
            tab = id;
            paint();
          }
        }, h('span', { class: 'tab-dot' }, dot), label))
    )
  );
}

function paintLive() {
  if (!job.running && !job.fail && !job.message) return h('div', { class: 'live', hidden: true });
  return h('div', { class: `live ${job.fail ? 'bad' : job.running ? '' : 'good'}` },
    h('div', { class: 'row' },
      job.running ? h('span', { class: 'spin' }, '◐') : h('span', {}, job.fail ? '✕' : '✓'),
      h('b', { class: 'grow' }, job.label || (job.running ? '运行中' : '完成')),
      !job.running
        ? h('button', {
            class: 'btn sm',
            onclick: () => {
              job.message = '';
              job.fail = 0;
              paint();
            }
          }, '知道了')
        : null),
    job.message ? h('div', { class: 'live-line' }, job.message) : null);
}

function paintFlow() {
  if (!project) return h('div', { class: 'card muted' }, '电脑上还没有项目。先在电脑上建一个、把剧本贴进去。');
  const box = h('div', { class: 'card', style: 'padding:0' });
  STEPS.forEach((s, i) => {
    const st = stateOf(project, s.id);
    const { done, total } = progressOf(project, s.id);
    box.append(
      h('div', { class: `step ${st}` },
        h('span', { class: 'step-num' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'step-name' }, s.label),
        total > 1 ? h('span', { class: 'step-count' }, `${done}/${total}`) : null,
        h('span', { class: 'step-mark' }, st === 'done' ? '✓' : st === 'partial' ? '◗' : ''),
        h('button', {
          class: 'btn sm',
          disabled: job.running,
          onclick: () => runStage(s.id, s.label)
        }, st === 'pending' ? '开始' : '继续'),
        // 出门在外最想按的其实是这个：把剩下几步一次串完，回去直接看成片。
        // 从这一步往后跑，前面几步的产出原样保留 —— 不重跑、不重复计费
        h('button', {
          class: 'btn sm',
          disabled: job.running,
          title: '从这一步一路跑到合成',
          onclick: async () => {
            const rest = STEPS.length - i;
            // eslint-disable-next-line no-alert
            if (!confirm(`从「${s.label}」一路跑到合成，共 ${rest} 步。视频那步按镜数计费，可能是最大的一笔开销。确定？`)) return;
            runStage('all', `${s.label} → 合成`, { from: s.id });
          }
        }, '往后全跑'))
    );
  });

  return [
    h('p', { class: 'muted', style: 'margin:2px 4px 10px' },
      '每一步都在电脑上跑，手机只是发个指令 —— 关掉这个页面也不影响它继续跑。'),
    box,
    h('div', { class: 'card' },
      h('div', { class: 'muted' },
        '剧本、设定集描述、能力路由这些要坐下来改的东西，都在电脑上。这里管的是"跑到哪儿了"和"哪一镜不对"。'))
  ];
}

function paintShots() {
  const shots = (project?.shots || []).slice().sort((a, b) => a.index - b.index);
  if (!shots.length) return h('div', { class: 'card muted' }, '还没有分镜。先在流水线里跑到第 02 步。');
  const v = Date.parse(project.updatedAt || '') || 0;
  const portrait = /^9:16$|^3:4$/.test(project.aspectRatio || '');

  return shots.map((s) => {
    const c = s.consistency;
    return h('div', { class: 'card shot' },
      s.videoPath
        ? h('video', { class: `shot-media ${portrait ? 'portrait' : ''}`, src: media(s.videoPath, v), controls: true, preload: 'metadata', playsinline: true })
        : s.imagePath
          ? h('img', { class: `shot-media ${portrait ? 'portrait' : ''}`, src: media(s.imagePath, v), loading: 'lazy', alt: `第 ${s.index} 镜` })
          : h('div', { class: 'shot-media', style: 'display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:13px' }, '还没出图'),
      h('div', { class: 'shot-info' },
        h('div', { class: 'shot-no' }, `SH ${String(s.index).padStart(3, '0')} · ${Number(s.duration).toFixed(1)}s`),
        h('div', { class: 'shot-desc' }, s.description || '（无描述）'),
        s.dialogue ? h('div', { class: 'muted', style: 'margin-bottom:8px' }, `${s.speaker || '旁白'}：「${s.dialogue}」`) : null,
        h('div', { class: 'tags' },
          s.camera ? h('span', { class: 'tag' }, s.camera) : null,
          s.scene ? h('span', { class: 'tag' }, s.scene) : null,
          c?.score != null ? h('span', { class: `tag ${c.pass ? 'ok' : 'warn'}` }, `一致性 ${c.score}`) : null,
          s.imageSize && s.imageSize.ok === false
            ? h('span', { class: 'tag warn' }, `比例不符 ${s.imageSize.width}×${s.imageSize.height}`)
            : null,
          s.headMatch?.verdict === 'mismatch' ? h('span', { class: 'tag warn' }, '首帧没吃') : null),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn sm grow',
            disabled: job.running,
            onclick: () => regen(s, 'image')
          }, '重出这张图'),
          s.imagePath
            ? h('button', {
                class: 'btn sm grow',
                disabled: job.running,
                onclick: () => regen(s, 'video')
              }, '重出这段视频')
            : null),
        editRow(s)));
  });
}

/**
 * 就地改这一镜的文案。
 *
 * 审片的完整回路是**看到不对 → 改一句 → 重出**，缺了中间那步，
 * 手机端就只剩"看到不对，记在心里回去再说"—— 而回到电脑前你多半已经忘了是哪一镜。
 *
 * 只放开描述和时长两样。景别、技法、变体那些在手机上改起来又慢又容易点错，
 * 而且它们不是"审片当场想改"的东西 —— 描述才是。
 */
function editRow(s) {
  const box = h('div', { style: 'display:none;margin-top:10px' });
  const desc = h('textarea', {
    rows: 3,
    style: 'width:100%;min-height:76px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font:inherit;font-size:16px'
  }, s.description || '');
  const dur = h('input', { type: 'number', step: '0.5', min: '1', max: '20', value: String(s.duration ?? 4), style: 'max-width:110px' });

  const save = h('button', { class: 'btn sm primary grow' }, '保存文案');
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api(`/projects/${project.id}/shots/${s.id}`, {
        method: 'PATCH',
        body: { description: desc.value, duration: Number(dur.value) || s.duration }
      });
      toast('已保存。重出这一镜才会按新描述生成', 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };

  const toggle = h('button', {
    class: 'btn sm grow',
    onclick: () => {
      const open = box.style.display === 'none';
      box.style.display = open ? '' : 'none';
      toggle.textContent = open ? '收起' : '改文案';
    }
  }, '改文案');

  box.append(
    desc,
    h('div', { class: 'row', style: 'margin-top:9px' },
      h('span', { class: 'muted' }, '时长（秒）'),
      dur),
    h('div', { class: 'row', style: 'margin-top:9px' }, save),
    h('div', { class: 'muted', style: 'margin-top:7px' },
      '保存只改文案，不重出 —— 一般是连着改好几镜再统一重出，改一个字就烧一次钱不划算。')
  );

  return [h('div', { class: 'row', style: 'margin-top:8px' }, toggle), box];
}

/** 一个可以存到手机上的素材行 */
function assetRow(label, note, href) {
  return h('div', { class: 'row', style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'grow' },
      h('div', {}, label),
      note ? h('div', { class: 'muted', style: 'margin-top:2px' }, note) : null),
    h('a', {
      class: 'btn sm',
      href,
      download: '',
      target: '_blank',
      style: 'display:flex;align-items:center;text-decoration:none'
    }, '存到手机'));
}

/**
 * 成片 + 交给剪映的素材。
 *
 * 为什么不在这儿做精剪：剪映的转场、音乐库、花字、封面是几百人做了几年的东西，
 * 硬碰硬赢不了。我们该做的是**把素材备齐**，让你进剪映就能直接开工：
 *   成片        直接发出去就能用的那一版
 *   每镜片段    进剪映后按顺序拖进时间线，想换顺序、想剪掉半秒都在那边做
 *   字幕 SRT    剪映专业版可以直接导入，省掉一次语音识别
 *   每条配音    想重配某一句时用得上
 *
 * 手机上"存到相册"最稳的还是**长按视频 → 存储视频**，下载按钮在部分浏览器里
 * 会存进"文件"而不是相册 —— 所以两条路都写出来，不替用户猜。
 */
function paintFilm() {
  const out = project?.outputs;
  const v = Date.parse(project?.updatedAt || '') || 0;
  const shots = (project?.shots || []).slice().sort((a, b) => a.index - b.index);
  const clips = shots.filter((s) => s.videoPath);
  const voices = shots.filter((s) => s.audioPath);

  const head = out?.video
    ? [
        h('div', { class: 'card', style: 'padding:0;overflow:hidden' },
          h('video', {
            src: media(out.video, v),
            controls: true,
            playsinline: true,
            style: 'width:100%;display:block;background:#000;max-height:70vh'
          })),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin-bottom:8px' },
            h('b', { class: 'grow' }, '成片'),
            out.seconds ? h('span', { class: 'muted' }, `${out.seconds}s`) : null),
          h('p', { class: 'muted' },
            '存到相册最稳的办法是长按上面的画面 → 存储视频；下面的按钮在有些浏览器里会存进「文件」而不是相册。'),
          assetRow('成片 mp4', out.durationPolicy === 'trim' ? '按分镜时长裁剪过' : '保留了完整片段', media(out.video, v)),
          out.subtitle ? assetRow('字幕 .srt', '剪映专业版可直接导入，省一次语音识别', media(out.subtitle, v)) : null)
      ]
    : [
        h('div', { class: 'card muted' },
          '还没有成片。流水线跑到最后一步「合成」之后，这里就能直接看。' +
          (clips.length ? `不过 ${clips.length} 段镜头片段已经在下面了，现在就能拿去剪映。` : ''))
      ];

  const material = clips.length || voices.length
    ? h('div', { class: 'card' },
        h('b', {}, '交给剪映的素材'),
        h('p', { class: 'muted', style: 'margin:6px 0 4px' },
          '精剪在剪映里做 —— 转场、音乐、花字那些它做得比我们好。这里负责把素材备齐：' +
          '每镜片段按顺序存下来，进剪映依次拖进时间线就是排好的初剪。'),
        // 二十镜就是四十来个文件，逐个点等于没做这个功能
        h('a', {
          class: 'btn primary block',
          style: 'display:flex;align-items:center;justify-content:center;text-decoration:none;margin:8px 0 4px',
          href: `/api/projects/${project.id}/export.zip${authKey ? `?k=${encodeURIComponent(authKey)}` : ''}`,
          download: ''
        }, `打包下载全部（${clips.length + voices.length + (out?.video ? 1 : 0)} 个文件）`),
        h('p', { class: 'muted', style: 'margin:0 0 8px' },
          '包里还有一张分镜表，写着每个片段是哪一镜、多长、说了什么 —— ' +
          '进剪映之后不用对着文件名猜。手机上会存进「文件」，在那儿解压再导入剪映。'),
        ...clips.map((s) =>
          assetRow(
            `第 ${s.index} 镜`,
            `${Number(s.duration).toFixed(1)}s · ${(s.description || '').slice(0, 18)}`,
            media(s.videoPath, v)
          )),
        ...voices.map((s) =>
          assetRow(`第 ${s.index} 镜 配音`, `${s.speakerUsed || s.speaker || '旁白'}：${(s.dialogue || '').slice(0, 14)}`, media(s.audioPath, v))))
    : null;

  return [...head, material];
}

// ───────────────────────── 动作 ─────────────────────────

async function runStage(stageId, label, extra = {}) {
  if (job.running) return;
  job.running = true;
  job.label = label;
  job.message = '正在提交…';
  job.fail = 0;
  paint();
  try {
    await stream(`/projects/${project.id}/stage/${stageId}`, extra, (ev) => {
      if (ev.type === 'error') {
        job.fail += 1;
        job.message = ev.message || '失败';
      } else if ((ev.type === 'shot' || ev.type === 'sheet') && ev.status === 'failed') {
        job.fail += 1;
        job.message = ev.message || '失败';
      } else if (ev.message) {
        job.message = ev.message;
      }
      updateLive();
    });
  } catch (err) {
    job.fail += 1;
    job.message = err.message;
  } finally {
    job.running = false;
    await reload();
  }
}

async function regen(shot, kind) {
  if (job.running) return;
  job.running = true;
  job.label = `第 ${shot.index} 镜${kind === 'video' ? '重出视频' : '重出图'}`;
  job.message = '正在提交…';
  job.fail = 0;
  paint();
  try {
    await stream(`/projects/${project.id}/shots/${shot.id}/regenerate`, { kind }, (ev) => {
      if (ev.type === 'error') {
        job.fail += 1;
        job.message = ev.message;
      } else if (ev.message) {
        job.message = ev.message;
      }
      updateLive();
    });
  } catch (err) {
    job.fail += 1;
    job.message = err.message;
  } finally {
    job.running = false;
    await reload();
  }
}

/**
 * 跑起来之后只重画**状态条那一块**。
 *
 * 整页重画在手机上代价更大：图和视频会重新加载一遍，正在播的那段会从头开始，
 * 滚动位置也丢了。而跑一步要十几分钟，这期间你多半正在翻分镜。
 */
function updateLive() {
  const old = document.querySelector('.live');
  if (old) old.replaceWith(paintLive());
}

async function reload() {
  const list = await api('/projects').catch(() => []);
  projects = list;
  const wanted = localStorage.getItem(PROJ_STORE);
  const pick = list.find((p) => p.id === wanted) || list[0];
  project = pick ? await api(`/projects/${pick.id}`).catch(() => null) : null;
  if (project) localStorage.setItem(PROJ_STORE, project.id);
  paint();
}

// ───────────────────────── 启动 ─────────────────────────

async function boot() {
  // 电脑上把带码的链接发到手机时，直接从地址里取，省得手敲
  const fromUrl = new URL(location.href).searchParams.get('k');
  if (fromUrl) {
    localStorage.setItem(KEY_STORE, fromUrl.toUpperCase());
    // 存下来之后就把它从地址栏抹掉：截图、分享、浏览器历史里都不该留着配对码
    history.replaceState(null, '', location.pathname);
  }
  authKey = localStorage.getItem(KEY_STORE) || '';
  if (!authKey) return paintPair();

  try {
    await api('/health');
  } catch (err) {
    localStorage.removeItem(KEY_STORE);
    authKey = '';
    return paintPair(err.status === 401 ? '配对码失效了 —— 电脑上换过码，重新敲一次。' : err.message);
  }
  await reload();
  return undefined;
}

boot();

// 装到主屏之后要能离线打开壳子（数据当然还得连上电脑才有）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/m/sw.js').catch(() => {});
}
