/**
 * 创作台：剧本、时长、章节、流水线阶段轨、分镜网格。
 * 阶段编号是真序列 —— 设定集必须在分镜之前跑，因为分镜要引用已冻结的人设。
 *
 * 项目的新建/切换/删除、以及画风，都在「项目」页 ——
 * 那些是项目级的事，和"这一部片子怎么往下做"混在一页上只会挡路。
 */
import { h, clear, add, api, stream, toast, mediaUrl, fmtMs } from '../lib.js';
import { openLightbox } from '../lightbox.js';
import { ratioLabel } from '../ratios.js';
import { skillPicker, customSkillForm } from '../skill-picker.js';
import { previzPanel, blankStage } from '../previz-canvas.js';
import { shotTable } from '../shot-table.js';
import { animatic } from '../animatic.js';
import { commandBox } from '../command-box.js';
import * as siteCanvasMod from '../site-canvas.js';
import * as OUTLINE from '/outline.js';
import { inheritStage } from '/previz.js';
/**
 * 转场表和效果表读的是**引擎那一份原件**（服务端把 core/transitions.js、
 * core/fx.js 原样发到 /transitions.js、/fx.js）。
 *
 * 在界面里另抄一份清单是很自然的写法，也是错的：加一个新转场就得记得改两处，
 * 而漏掉界面那份没人会发现（引擎支持但选不到），漏掉引擎那份用户会报"选了没反应"。
 */
import * as TRANS from '/transitions.js';
import * as FX from '/fx.js';
/**
 * 时间线量的必须和成片一模一样，所以它不自己算 —— 直接跑引擎那一份。
 * 服务端把 core/pipeline/edit.js 原样发到 /edit.js，两端是同一个文件。
 */
import * as EDIT from '/edit.js';
import * as DUR from '/duration.js';
/**
 * 预估和单价换算，取的是**服务端那两个文件的原件**（/estimate.js、/pricing.js）。
 *
 * 界面上那句"这一下大概多少钱"和跑完之后账本上记的，必须是同一套算法。
 * 在这边另抄一份的话，两边迟早会分叉，而分叉的样子是
 * "说好 ¥12、跑完变 ¥31" —— 那比不显示还坏，因为人是照着那个数下的手。
 */
import * as EST from '/estimate.js';
import * as PRICING from '/pricing.js';
import { stepsOf, stepProgress } from '../pipeline.js';
import bibleView from './bible.js';

/**
 * 说话人是**凭什么**定下来的。显示它是有用的：
 * "模型按上下文判的"值得你回头看一眼，"台词里带的署名"基本不用管。
 */
const SPEAKER_BY = {
  'dialogue-tag': '台词署名',
  'description-cue': '描述提示',
  'only-one': '独角戏',
  'narrator-marked': '标了旁白',
  ambiguous: '判不出',
  'fallback-narrator': '无线索',
  model: '模型判的',
  existing: '拆分镜时标的'
};

/**
 * 两个场景名算不算同一个地方（和后端 pipeline/continuity.js 里那条规则一致）。
 * 界面上要在**发请求之前**就把衔接关系显示出来，所以这条规则两边各有一份。
 */
function sameScene(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 正在跑的流水线任务。
 *
 * 刻意放在模块级、而不是某一次 render 的闭包里 —— 一步动辄跑十几分钟，
 * 中途切去别的页面看一眼是再正常不过的事。
 *
 * 早期版本把运行状态、进度、DOM 全绑在渲染闭包里，于是切走再回来会出现三件怪事：
 *   ① 界面停在"运行中"，因为新的这次渲染读到的 running 还是旧值，而通知它的人已经没了；
 *   ② 进度和"正在生成哪一镜"全喂给了一堆早就从文档里摘下来的元素；
 *   ③ 跑完了没人告诉新渲染去重新拉一次项目 —— 图和视频"要退出去再进来才看得到"。
 *
 * 现在状态归状态、视图归视图：任务往这里写，当前挂着的那次渲染注册一个回调来听。
 */
const job = {
  projectId: null,
  /** 正在跑的阶段 id；null = 没有整步任务在跑 */
  stage: null,
  /** 正在单独重出的镜头 */
  shots: new Set(),
  /** shotId → { status, message, attempt } */
  live: new Map(),
  /** 进度文本。切回来要能接着看，所以留在这儿而不是只写进 DOM */
  log: [],
  failures: [],
  /** 这一轮成了几个。job.live 在收尾时会被清空，所以单独记一份 */
  doneCount: 0,
  /** 跑的是哪一步。结束时 stage 会被清成 null，而结果提示还要用它的名字 */
  lastStage: null,
  /** 这一轮是被主动停掉的，不是失败。两者的收尾提示完全不一样 */
  cancelled: false,
  startedAt: 0,
  /** 只保留最新一次渲染的回调 —— 旧的那次已经不在文档里了，没必要留着 */
  onUpdate: null
};

function jobBusy() {
  return Boolean(job.stage) || job.shots.size > 0 || Boolean(job.serverRunning);
}

/**
 * ══════════ 到底在不在跑，只有服务端知道 ══════════
 *
 * ⚠ 原来这个判断**只看内存里那个变量**，而那是每个页面各存一份的。
 *
 * 于是：刷新一次、换台设备看、或者流断一次（手机锁屏、切个应用就够了），
 * 客户端就以为跑完了，按钮亮回来 —— 而服务器还在一镜一镜地出。
 * 人点下去，撞上一段"这个项目已经在跑（321 秒前开始）"的长文案，
 * 而那句话本身就说明**这一下压根不该点得动**。
 *
 * 活儿登记在服务端（jobs.js 的内存表），那才是唯一的事实。问它。
 */
async function syncJob(projectId) {
  if (!projectId) return;
  try {
    const live = await api(`/projects/${projectId}/job`);
    const was = Boolean(job.serverRunning);
    job.serverRunning = live?.running ? live : null;
    /**
     * ⚠ 只有**状态真的变了**才重画。
     *
     * 每三秒无条件重画一次的话，正在打字的输入框会被整个换掉 ——
     * 而那种"打着打着字没了"的 bug 极难往轮询上想。
     */
    if (Boolean(job.serverRunning) !== was) jobNotify('server');
  } catch {
    /* 问不到就保持原样：网络抖一下不该把按钮全锁死 */
  }
}

let jobPollTimer = 0;
function startJobPoll(projectId) {
  clearInterval(jobPollTimer);
  syncJob(projectId);
  jobPollTimer = setInterval(() => syncJob(projectId), 4000);
}

function jobNotify(kind) {
  try {
    job.onUpdate?.(kind);
  } catch {
    /* 视图已经被换掉了，通知失败无所谓 */
  }
}

/** 换项目时把上一份任务状态丢掉，别让 A 项目的进度显示在 B 项目上 */
function jobReset(projectId) {
  if (job.projectId === projectId) return;
  job.projectId = projectId;
  job.stage = null;
  job.shots.clear();
  job.live.clear();
  job.log = [];
  job.failures = [];
  job.doneCount = 0;
  job.lastStage = null;
}

export default {
  /**
   * ⚠ 这一页的请求**必须并行发**。
   *
   * 原来是一条 await 接一条：styles → projects → skills → project →
   * duration → bible-readiness → chapters，八个串行波次。
   * 在自己电脑上跑本地服务时每跳 1ms，完全看不出问题；
   * 而放到远端服务器上，每跳一两百毫秒，光是排队就白等一秒多 ——
   * 表现就是"点开工作流很慢"，而且慢在哪儿完全看不出来
   * （每一条单看都很快，慢的是它们**排成了一队**）。
   *
   * 现在分三波：
   *   ① 和项目无关的（styles / projects / skills）+ 已知 id 的项目本体
   *   ② 依赖项目、但彼此无关的三条（duration / readiness / chapters）
   *   ③ 用到的时候再 await
   * 依赖关系决定波次，其余一律并行。量出来 1465ms → 见 scripts/perfcheck.mjs。
   */
  async render({ state, go }) {
    // 先发出去，等会儿再取结果 —— 这几条互不依赖
    const stylesP = api('/styles');
    const projectsP = api('/projects');
    // 技法库：镜头运用、光线、动作、氛围。全局的，跨项目共用
    const skillsP = api('/skills').catch(() => null);
    // 已经知道是哪个项目就一起发；不知道才得等 /projects 回来才能挑默认那个
    const knownId = state.projectId;
    const projectP = knownId ? api(`/projects/${knownId}`).catch(() => null) : null;

    const { presets } = await stylesP;
    const projects = await projectsP;
    let skillGroups = (await skillsP)?.groups || [];
    let project = null;

    if (!state.projectId && projects.length) state.projectId = projects[0].id;
    if (state.projectId) {
      project = state.projectId === knownId
        ? await projectP
        : await api(`/projects/${state.projectId}`).catch(() => null);
      if (!project) state.projectId = null;
    }

    /**
     * 依赖项目、但三者互不依赖 —— 一起发出去，谁用到谁 await。
     * 项目没打开时这三条根本不该发（发了也是白等一跳）。
     */
    /**
     * 预取一份，但**只够用一次**。
     *
     * 时长这条会被反复调用（跑完一步要刷新数字）。如果每次都 await 同一个
     * Promise，拿到的永远是进页面那一刻的快照 —— 跑完视频回来还显示"合成后 —"，
     * 看着像没跑成。所以第一次用预取的，之后每次重新问。
     */
    let durationPrefetch = project ? api(`/projects/${project.id}/duration`).catch(() => null) : null;
    const durationInfo = () => {
      if (durationPrefetch) {
        const p2 = durationPrefetch;
        durationPrefetch = null;
        return p2;
      }
      return project ? api(`/projects/${project.id}/duration`).catch(() => null) : Promise.resolve(null);
    };
    const readinessP = project?.bible
      ? api(`/projects/${project.id}/bible-readiness`).catch(() => null)
      : null;
    const chaptersP = project ? api(`/projects/${project.id}/chapters`).catch(() => null) : null;

    const root = h('div', { class: 'stack' });
    const rerender = () => document.querySelector('#btn-refresh').click();

    if (!project) {
      root.append(
        h('div', { class: 'empty' },
          h('b', {}, '还没有选中项目'),
          h('div', {}, '先去「项目」页新建一个，或者打开一个已有的。'),
          h('div', { class: 'inline', style: 'margin-top:12px;justify-content:center' },
            h('button', { class: 'btn primary', onclick: () => go('projects') }, '去项目页')))
      );
      return root;
    }

    // ───────────── 当前项目（一行，够用就行）─────────────
    const styleName = presets.find((s) => s.id === (project.styleId || 'ink'))?.name || '自定义';
    root.append(
      h('div', { class: 'project-bar' },
        h('div', { class: 'project-bar-main' },
          h('b', {}, project.title),
          h('span', { class: 'badge' }, styleName),
          // 画幅摆在这儿是为了**下手之前**就看见：横竖搞反的话，
          // 整条流水线出完才发现，等于白跑一遍
          h('span', {
            class: 'badge',
            title: project.aspectRatio ? ratioLabel(project.aspectRatio) : '这个项目没单独设，跟随「设置 → 画幅」'
          }, project.aspectRatio || `${state.catalog?.settings?.aspectRatio || '16:9'}（跟随设置）`),
          project.style ? h('span', { class: 'badge' }, project.style) : null,
          projects.length > 1 ? h('span', { class: 'badge' }, `共 ${projects.length} 个项目`) : null),
        h('button', { class: 'btn ghost sm', onclick: () => go('projects') }, '切换项目 / 改画风比例'))
    );

    /**
     * 当前在流水线的哪一步。这份状态在 app.js 的 state 上 ——
     * 左边菜单要靠它高亮，这一页要靠它决定显示哪一块。
     *
     * 它不只是"看哪一步"，更决定**这一屏出现什么**：
     * 早先这一页从剧本一路铺到分镜网格，想点第 04 步得先滚过三屏。
     * 现在一步只显示这一步的东西，剩下的收起来。
     */
    const steps = stepsOf(state.catalog);
    if (!steps.some((x) => x.id === state.stage)) state.stage = 'script-src';

    /** 这一步该显示哪些东西 */
    function scope(stage = state.stage) {
      return {
        script: stage === 'script-src',
        // 时长是视频的输入：几秒的片段由它决定。分镜那步也要，因为拆镜时就在分配预算。
        duration: stage === 'script' || stage === 'video',
        image: stage === 'assets',
        video: stage === 'video',
        compose: stage === 'compose',
        // 设定集那步的产出在「设定集」页，分镜网格帮不上忙；剧本那步还没有分镜
        shots: stage !== 'bible' && stage !== 'script-src' && stage !== 'compose'
      };
    }

    /** 让左边菜单上的对勾跟着最新的项目状态走 */
    function syncNav() {
      window.dispatchEvent(new CustomEvent('fd:project', { detail: { project } }));
    }

    // ───────────── 剧本 ─────────────
    // 画风不在这儿 —— 建项目时已经定过了，摆两遍只会让人怀疑到底哪个算数。
    // 要改去「项目」页，那里会顺便提醒"设定集是按画风冻结的，改完得重跑第 01 步"。
    const scriptArea = h('textarea', { rows: 14 }, project.script || '');
    const shotCount = h('input', { type: 'number', value: 8, min: 2, max: 60 });

    const scriptPanel =
      h(
        'div',
        { class: 'panel' },
        h('h2', { class: 'panel-title' }, '剧本'),
        h('p', { class: 'panel-hint' }, '小说片段、大纲、完整剧本都行。保存之后，去左边菜单里点第 02 步「设定集」往下走。'),
        scriptArea,
        h('div', { class: 'row', style: 'margin-top:11px' },
          h('div', { class: 'shrink', style: 'width:150px' }, h('label', {}, '每章目标镜数'), shotCount),
          h('div', {}),
          h('div', { class: 'shrink' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                await api(`/projects/${project.id}`, {
                  method: 'PATCH',
                  body: { script: scriptArea.value }
                });
                toast('已保存', 'ok');
                rerender();
              }
            }, '保存剧本'))
        )
      );

    // ───────────── 时长 ─────────────
    // 三个数分开摆：目标是你要的，计划是分镜表算的，实际是厂商档位吃完剩的。
    // 混成一个数就会出现"界面说 32 秒、成片 40 秒"这种谁也说不清的情况。
    const durationHost = h('div', {});

    async function paintDuration() {
      const info = await durationInfo();
      if (!info) return;
      const { summary, policy, presets, suggestedShots } = info;
      // 厂商接受的时长档位，从 /api/catalog 拿（跟着当前路由到的视频模型走）
      const steps = state.catalog.videoDurations || [];
      clear(durationHost);

      const targetInput = h('input', { type: 'number', min: 5, max: 3600, value: summary.target || 60 });
      const presetRow = h('div', { class: 'inline' },
        presets.map((p) =>
          h('button', {
            class: `btn sm ${summary.target === p.seconds ? 'primary' : 'ghost'}`,
            title: p.note,
            onclick: () => { targetInput.value = p.seconds; }
          }, p.label))
      );

      const over = summary.target && summary.planned > summary.target;
      const cells = [
        { k: '目标', v: summary.target ? `${summary.target}s` : '未设', note: '你要的长度' },
        { k: '计划', v: `${summary.planned}s`, note: `${summary.shots} 镜相加`, cls: summary.target ? (summary.withinTolerance ? 'ok' : 'warn') : '' },
        { k: '模型实出', v: `${summary.generated}s`, note: summary.quantizationOverhead > 0 ? `档位多出 ${summary.quantizationOverhead}s` : '与计划一致' },
        { k: '成片', v: summary.videoReady ? `${summary.final}s` : '—', note: policy === 'trim' ? '按计划裁剪' : '保留完整片段' }
      ];

      add(durationHost,
        h('div', { class: 'duration-grid' },
          cells.map((c) =>
            h('div', { class: `duration-cell ${c.cls || ''}` },
              h('div', { class: 'duration-k' }, c.k),
              h('div', { class: 'duration-v' }, c.v),
              h('div', { class: 'duration-note' }, c.note)))),
        summary.target && !summary.withinTolerance
          ? h('div', { class: 'note-line warn' },
              `计划时长比目标${over ? '长' : '短'} ${Math.abs(summary.delta)} 秒。可以按目标重新分配每镜时长 —— 会保留原有的快慢节奏，只做整体缩放。`)
          : null,
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('div', { class: 'shrink', style: 'width:150px' }, h('label', {}, '目标时长（秒）'), targetInput),
          h('div', {}, h('label', {}, '常用长度'), presetRow),
          h('div', { class: 'shrink' },
            h('button', {
              class: 'btn',
              onclick: async (ev) => {
                ev.target.disabled = true;
                try {
                  await api(`/projects/${project.id}/duration/rescale`, {
                    method: 'POST',
                    body: { targetDuration: Number(targetInput.value) }
                  });
                  project = await api(`/projects/${project.id}`);
                  toast(project.shots.length ? '已按目标重新分配每镜时长' : '目标时长已保存', 'ok');
                  await paintDuration();
                  applyScope();
                  syncNav();
                } catch (err) {
                  toast(err.message, 'err');
                } finally {
                  ev.target.disabled = false;
                }
              }
            }, project.shots?.length ? '按目标重排时长' : '保存目标'))
        ),
        // 档位这件事必须**提前**说。等跑完才在日志里解释一句"已对齐到 5 秒"，
        // 用户看到的就是"我设了 4 秒，它不听话"。
        steps.length
          ? h('div', { class: 'note-line' },
              `当前视频模型（${state.catalog.routing.video.model}）只接受 ${steps.join(' / ')} 秒这几档。` +
                `每镜时长会**向上取整**到最近的档位 —— 设 4 秒就按 ${steps.find((x) => x >= 4) || steps.at(-1)} 秒出，` +
                `宁可多出来一点合成时裁掉，也不要少了把动作或台词切断。` +
                (policy === 'trim'
                  ? '合成时按每镜的计划时长裁剪，所以**成片总长仍然是你设的目标**，多出来的那部分被切掉了。'
                  : '当前策略是保留完整片段，所以成片会比计划长。想卡准目标就去「设置 → 时长策略」改成裁剪。')
            )
          : null,
        h('div', { class: 'field-hint' },
          project.shots?.length
            ? `每镜时长可以在分镜卡片里单独改。"模型实出"是厂商按档位实际给的长度，通常比"计划"长。`
            : `还没拆分镜。按这个目标，建议拆 ${suggestedShots} 个镜头左右，拆分镜时会把时长预算一并交给模型。`)
      );
    }

    await paintDuration();
    // 时长只在"分镜"和"视频"两步露面 —— 别的步骤看它没用，还会让人以为要先改它
    const durationPanel = h('div', { class: 'panel', style: 'display:none' },
      h('h2', { class: 'panel-title' }, '时长'),
      h('p', { class: 'panel-hint' },
        '目标时长是「输入」：分镜数由它反推，拆分镜时会把预算交给模型，让它自己分配节奏 —— 紧张段用短镜，抒情段用长镜。'),
      durationHost
    );

    // ───────────── 章节（长篇才出现）─────────────
    /**
     * 设定图齐了没。
     *
     * 缺一张，后面引用它的每一镜都少一张参考图、少一份复核基准 ——
     * 一致性就是从那儿开始塌的。所以在**下手之前**就把这件事摆出来，
     * 而不是等你点了「分镜」才拦一下。
     */
    const readiness = await readinessP;
    const readinessHost = h('div', {});
    if (readiness && !readiness.ok && readiness.total) {
      readinessHost.append(
        h('div', { class: 'note-line warn' },
          h('b', {}, `设定图还差 ${readiness.missing.length} 张`),
          `：${readiness.missing.slice(0, 8).join('、')}${readiness.missing.length > 8 ? ' 等' : ''}。`,
          '缺的那几张会让引用它们的每一镜都少一张参考图 —— 先把它们补出来再拆分镜。',
          h('button', {
            class: 'btn ghost sm', style: 'margin-left:8px',
            onclick: () => window.dispatchEvent(new CustomEvent('fd:goto-stage', { detail: { id: 'bible' } }))
          }, '去设定集补'))
      );
    }

    const chapterInfo = await chaptersP;
    const hasChapters = (project.chapters || []).length > 0;
    let chapterPanel = null;

    if (chapterInfo && (hasChapters || chapterInfo.advice?.suggested)) {
      const chapterHost = h('div', {});

      function paintChapters() {
        clear(chapterHost);
        if (!hasChapters) {
          chapterHost.append(
            h('p', { class: 'panel-hint' },
              `这段剧本有 ${chapterInfo.advice.chars} 字，建议分章跑。切完预计 ${chapterInfo.advice.preview.length} 章：`),
            h('div', { class: 'chapter-preview' },
              chapterInfo.advice.preview.map((c) =>
                h('span', { class: 'badge' }, `${c.title}（${c.chars} 字）`))),
            h('div', { class: 'inline', style: 'margin-top:12px;flex-wrap:wrap' },
              h('button', {
                class: 'btn',
                title: '按段落攒到目标字数就切。免费、瞬间、结果可复现',
                onclick: async () => {
                  await api(`/projects/${project.id}/chapters/split`, { method: 'POST', body: {} });
                  toast('已按字数分章', 'ok');
                  rerender();
                }
              }, '按字数切（免费）'),
              // 按字数切不懂剧情，可能把一场戏从中间劈开。
              // 让模型按情节单元切要花钱，但第一章结尾不会莫名其妙。
              (() => {
                const status = h('span', { class: 'field-hint', style: 'margin:0' });
                const btn = h('button', {
                  class: 'btn primary',
                  title: '模型按情节单元切：时间跳跃、地点转换、视角切换。会真的调用模型，按你的计费方式扣费',
                  onclick: async () => {
                    if (!confirm('让模型读一遍全文来分章？长篇会分成好几段问，每段一次调用，按你的计费方式扣费。')) return;
                    btn.disabled = true;
                    let err = null;
                    try {
                      await stream(`/projects/${project.id}/chapters/smart-split`, {}, (ev) => {
                        if (ev.type === 'note' || ev.type === 'stage') status.textContent = ev.message || '';
                        if (ev.type === 'error') err = ev.message;
                      });
                      if (err) throw new Error(err);
                      toast('模型已按情节分章', 'ok');
                      rerender();
                    } catch (e) {
                      status.textContent = e.message;
                      toast(e.message, 'err');
                    } finally {
                      btn.disabled = false;
                    }
                  }
                }, '让模型按情节切');
                return [btn, status];
              })())
          );
          return;
        }

        const list = h('div', { class: 'chapter-list' });
        for (const ch of project.chapters) {
          const shots = project.shots.filter((s) => s.chapterId === ch.id);
          const withImg = shots.filter((s) => s.imagePath).length;
          list.append(
            h('div', { class: `chapter-row ${ch.stageStatus.script === 'done' ? 'done' : ''}` },
              h('div', { class: 'chapter-main' },
                h('div', { class: 'chapter-title' }, ch.title),
                // 模型分章时顺带给的梗概。按字数切没有这个，那就不显示
                ch.summary ? h('div', { class: 'chapter-meta' }, ch.summary) : null,
                h('div', { class: 'chapter-meta' },
                  `${ch.chars} 字`,
                  shots.length ? ` · ${shots.length} 镜` : ' · 未拆分镜',
                  shots.length ? ` · 出图 ${withImg}/${shots.length}` : '')
              ),
              h('div', { class: 'inline' },
                h('button', {
                  class: 'btn sm',
                  disabled: jobBusy(),
                  onclick: () => runStage('script', { chapterId: ch.id })
                }, shots.length ? '重拆分镜' : '拆分镜'),
                h('button', {
                  class: 'btn sm',
                  disabled: jobBusy() || !shots.length,
                  onclick: () => runStage('assets', { chapterId: ch.id })
                }, '出图'),
                h('button', {
                  class: 'btn sm',
                  disabled: jobBusy() || !withImg,
                  onclick: () => runStage('video', { chapterId: ch.id })
                }, '出视频')
              )
            )
          );
        }
        chapterHost.append(
          h('p', { class: 'panel-hint' },
            '设定集是全片共享的，不随章节走 —— 这正是跨章不换脸的原因。每章的分镜、出图、视频各自独立，可以只跑第一章看效果。'),
          list,
          h('div', { class: 'inline', style: 'margin-top:12px' },
            h('button', {
              class: 'btn ghost sm',
              onclick: async () => {
                if (!confirm('重新切分会按当前剧本重算章节；正文没变的章节会保留已完成状态。继续？')) return;
                await api(`/projects/${project.id}/chapters/split`, { method: 'POST', body: {} });
                toast('已重新切分', 'ok');
                rerender();
              }
            }, '重新切分'),
            h('button', {
              class: 'btn ghost sm',
              onclick: async () => {
                if (!confirm('取消分章后，按整篇处理。已生成的分章镜头会被清掉。继续？')) return;
                await api(`/projects/${project.id}/chapters`, { method: 'DELETE' });
                toast('已取消分章', 'ok');
                rerender();
              }
            }, '取消分章'))
        );

        /**
         * ── 追加一章 ──
         *
         * 剧本一章一章来的时候，原来只能去剧本框里把新章粘到末尾。
         * 那件事最容易毁掉的是**前面的正文**：碰掉一个空格，那一章就被
         * 判定"改过了"，已经出好的分镜全部作废重跑 —— 而没有任何提示，
         * 你要到重新分章之后才发现前面几章的进度没了。
         *
         * 这条路只往末尾拼，碰不到前面。
         */
        const apTitle = h('input', { type: 'text', placeholder: `第 ${(project.chapters || []).length + 1} 章（留空就用这个）` });
        const apText = h('textarea', { rows: 5, placeholder: '把新一章的正文贴在这儿' });
        const apBtn = h('button', { class: 'btn primary' }, '追加这一章');
        apBtn.onclick = async () => {
          if (!apText.value.trim()) { toast('这一章是空的', 'err'); return; }
          apBtn.disabled = true;
          const old = apBtn.textContent;
          apBtn.textContent = '追加中…';
          try {
            // cap:append-chapter
            const r = await api(`/projects/${project.id}/chapters/append`, {
              method: 'POST', body: { title: apTitle.value, script: apText.value }
            });
            apText.value = '';
            apTitle.value = '';
            toast((r.added?.length > 1
              ? `已追加 ${r.added.length} 章：${r.added.map((c) => c.title).join('、')}`
              : `已追加${r.chapter?.title ? `「${r.chapter.title}」` : '一章'}`)
              + ' —— 前面几章的进度都还在。记得扫一遍设定集', 'ok');
            rerender();
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            apBtn.disabled = false;
            apBtn.textContent = old;
          }
        };
        /**
         * ── 新章还没扫过角色和场景 ──
         *
         * 加完章之后如果没人提一句，新章里的角色永远不会进设定集 ——
         * 而那件事是**静默**的：分镜照拆、图照出，只是那几镜没有参考图、
         * 没有外貌描述、复核没有基准，静默降级成"文生图"，流水线一路绿。
         *
         * 「补上新增的角色和场景」那颗按钮一直都在设定集页，
         * 但没人知道什么时候该点 —— 所以提示要出现在**刚贴完章的这里**。
         */
        const unscanned = (project.chapters || []).filter((c) => !c.castScanned);
        if (unscanned.length && project.bible) {
          const scan = h('button', { class: 'btn primary sm' }, `扫这 ${unscanned.length} 章`);
          const scanLog = h('span', { class: 'field-hint', style: 'margin:0' });
          scan.onclick = async () => {
            scan.disabled = true;
            const old = scan.textContent;
            scan.textContent = '扫描中…';
            try {
              // cap:extend-bible
              await stream(`/projects/${project.id}/extend-bible`, {}, (ev) => {
                if (ev.message) scanLog.textContent = ev.message;
                if (ev.type === 'error') toast(ev.message, 'err');
                if (ev.type === 'finished') {
                  project.bible = ev.project?.bible || project.bible;
                  toast(ev.added?.length
                    ? `补了 ${ev.added.length} 条：${ev.added.map((a) => a.name).join('、')}。已有的一条都没动`
                    : '这几章用的都是已有的角色和场景', 'ok');
                  rerender();
                }
              });
            } catch (err) { toast(err.message, 'err'); } finally {
              scan.disabled = false; scan.textContent = old;
            }
          };
          chapterHost.append(h('div', { class: 'ob-pending' },
            h('b', {}, `有 ${unscanned.length} 章还没对过设定集`),
            h('span', {},
              `${unscanned.map((c) => c.title).slice(0, 4).join('、')}${unscanned.length > 4 ? ' 等' : ''}。`
              + '扫一遍，只把**没见过的**角色和场景补进来 —— 已有的一条都不动、一张图都不重出。'
              + '不扫的话，新角色那几镜会没有参考图，而且不报错。'),
            scan, scanLog));
        }

        chapterHost.append(
          h('details', { class: 'append-chapter' },
            h('summary', {}, '追加一章'),
            h('p', { class: 'field-hint' },
              '往剧本末尾拼一章，前面的正文一个字都不会动 —— 所以已经跑完的章不会作废重跑。'
              + '正文里自带「第 X 章」这类标题行的话就不用再填标题。'),
            apTitle, apText,
            h('div', { class: 'inline', style: 'margin-top:8px' }, apBtn))
        );
      }

      paintChapters();
      chapterPanel = h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, '章节'), chapterHost);
    }

    // ───────────── 实时进度 ─────────────
    // 出视频一镜要几分钟，中间全靠轮询。不把"现在轮到谁、轮询到第几次"显示出来，
    // 用户看到的就是一个卡住不动的界面，只能猜是不是死了。
    jobReset(project.id);
    /**
     * 进这个视图就开始问服务端"现在在跑什么"。
     *
     * ⚠ 这一下**必须在进来时就做**，不能等用户点了才发现在跑。
     * 刷新、换设备、流断之后，页面自己那份状态全没了，
     * 而服务器可能已经跑了五分钟。
     */
    startJobPoll(project.id);
    const live = job.live; // 状态在模块级，切页面不丢
    const liveBadge = h('span', {});
    const liveEls = new Map(); // shotId → 卡片上那块状态区

    function trackLive(ev) {
      // 设定图出一张，设定集面板就跟一次 —— 不然要等整步跑完才看得到东西，
      // 而设定集这一步动辄十几张图，全程干等着最难受。
      // ⚠ 必须放在下面那个 `!ev.shotId` 的提前返回**之前**：
      // sheet 事件带的是 name（哪个角色/场景），根本没有 shotId
      if (ev.type === 'sheet') {
        if (ev.status === 'done') {
          job.doneCount += 1;
          remountBible({ delay: 1200 });
        }
        return;
      }
      if (!ev.shotId) return;
      const prev = live.get(ev.shotId) || {};
      if (ev.type === 'shot') {
        live.set(ev.shotId, { status: ev.status, message: ev.message || '', attempt: prev.attempt });
      } else if (ev.type === 'poll') {
        live.set(ev.shotId, { ...prev, status: 'running', attempt: ev.attempt, message: `轮询第 ${ev.attempt} 次（${ev.state || '排队中'}）` });
      } else if (ev.type === 'note') {
        live.set(ev.shotId, { ...prev, status: 'running', message: ev.message });
      } else {
        return;
      }
      paintLive(ev.shotId);
      // 这一镜出完了：立刻把**这一张卡**换成最新的（图/视频/复核分数都在里面），
      // 别等整步跑完，也别重画整页
      if (ev.type === 'shot' && ev.status === 'done') {
        job.doneCount += 1;
        touchedShots.add(ev.shotId);
        refreshShot(ev.shotId);
      }
    }

    function paintLive(shotId) {
      const el = liveEls.get(shotId);
      const info = live.get(shotId);
      if (el && info) {
        el.className = `shot-live ${info.status}`;
        el.textContent =
          info.status === 'running' ? (info.message || '生成中…')
            : info.status === 'failed' ? `失败：${info.message || ''}`
            : info.status === 'done' ? '完成' : info.message || '';
        el.style.display = '';
      }
      const busy = [...live.values()].filter((v) => v.status === 'running').length;
      const finished = [...live.values()].filter((v) => v.status === 'done').length;
      clear(liveBadge);
      if (jobBusy()) {
        liveBadge.append(
          h('span', { class: 'badge beam' }, h('span', { class: 'spin' }, '◐'),
            busy ? `正在生成 · 已完成 ${finished}` : `运行中 · 已完成 ${finished}`)
        );
      }
    }

    // ───────────── 阶段轨 ─────────────
    // 点阶段是「查看」，不是「开跑」—— 每一步都真花钱，误点一下代价不小。
    // 要跑必须在下面的详情面板里明确按运行。
    const progressLog = h('div', { class: 'stream-log', style: 'display:none' });
    const failHost = h('div', {});

    /**
     * 失败汇总。
     *
     * 报错里带的是服务端原话，所以这里原样摊开，不做二次加工 ——
     * "出视频一直失败"这种问题，答案几乎总在那句原话里，
     * 而它一旦被几十条轮询日志顶走，就只能靠猜了。
     */
    function paintFailures(list) {
      clear(failHost);
      if (!list.length) return;
      failHost.append(
        h('div', { class: 'fail-box' },
          h('div', { class: 'fail-head' }, `${list.length} 项没成功`),
          list.slice(0, 12).map((f) =>
            h('div', { class: 'fail-row' },
              h('span', { class: 'fail-who' }, f.who),
              h('span', { class: 'fail-msg' }, f.message))),
          list.length > 12 ? h('div', { class: 'fail-row' }, `…另外 ${list.length - 12} 项`) : null,
          h('div', { class: 'inline', style: 'margin-top:10px' },
            h('button', { class: 'btn ghost sm', onclick: () => go('logs') }, '看完整请求记录'),
            h('button', { class: 'btn ghost sm', onclick: () => go('settings') }, '去体检一遍')),
          h('div', { class: 'fail-tip' },
            '排查顺序：① 上面那句服务端原话；② 「设置 → 上线前体检」把这条能力真跑一次最小调用；' +
            '③ 模型 ID 是否是你账号里真实开通的那个。')
        )
      );
    }
    const stageDetail = h('div', { class: 'stage-detail' });

    /** 这一步做完了多少。和左边菜单上的对勾共用同一份算法，不各算各的 */
    const stageProgress = (id) => stepProgress(project, id);

    /**
     * 真正提交付费生成前，把本次会调用什么摊开给人看。
     *
     * 不在这里硬编码人民币价格：中转商、账号折扣和模型版本都会让“精确金额”变成假数。
     * 调用数和视频秒数是我们能可靠算出的计费量，最终金额以服务商账单为准。
     */
    function confirmGeneration(kind, targets, override = {}, action = '开始生成') {
      const route = kind === 'video' ? state.catalog.routing.video : state.catalog.routing.image;
      const providerId = override.provider || route.provider;
      const modelId = override.model || route.model;
      const provider = state.catalog.providers.find((x) => x.id === providerId);
      const model = (provider?.models || []).find((x) => x.id === modelId);
      const lines = [
        `${action}前请核对：`,
        `服务商：${provider?.name || providerId || '未配置'}`,
        `模型：${model?.label || modelId || '未配置'}`,
        `调用次数：${targets.length} 次`
      ];
      if (kind === 'video') {
        const allowed = DUR.allowedDurations(provider, modelId);
        const seconds = targets.reduce((sum, shot) =>
          sum + DUR.alignDuration(DUR.shotSeconds(shot), allowed, { mode: 'up' }), 0);
        lines.push(`预计生成量：${seconds} 视频秒`);
      }
      lines.push('', '这会调用第三方付费接口，实际金额以服务商账单为准。确认提交？');
      return confirm(lines.join('\n'));
    }

    /** 选中步骤的详情：产出统计 + 缺什么 + 明确的运行按钮 */
    function paintStageDetail() {
      clear(stageDetail);
      const meta = steps.find((s) => s.id === state.stage);
      if (!meta) return;

      // 剧本这一步没有服务端阶段可跑：它的"运行"就是保存，然后往下走一步
      if (state.stage === 'script-src') {
        const next = steps[1];
        add(stageDetail,
          h('div', { class: 'stage-detail-head' },
            h('div', {},
              h('div', { class: 'stage-detail-title' }, meta.label),
              h('div', { class: 'stage-detail-hint' }, meta.hint)),
            h('div', { class: 'inline' },
              h('button', {
                class: 'btn primary',
                onclick: async () => {
                  // cap:script-edit
                  await api(`/projects/${project.id}`, { method: 'PATCH', body: { script: scriptArea.value } });
                  project = await api(`/projects/${project.id}`);
                  toast('剧本已保存', 'ok');
                  syncNav();
                  paintStageDetail();
                }
              }, '保存剧本'),
              next
                ? h('button', {
                    class: 'btn ghost',
                    disabled: !project.script?.trim(),
                    onclick: () => window.dispatchEvent(new CustomEvent('fd:goto-stage', { detail: { id: next.id } }))
                  }, `下一步：${next.label}`)
                : null)),
          h('div', { class: 'progress-text' },
            project.script?.trim()
              ? `已有剧本 ${project.script.trim().length} 字${(project.chapters || []).length ? `，分成 ${project.chapters.length} 章` : ''}`
              : '还没有剧本 —— 贴进下面的框里保存即可'));
        return;
      }
      const { done, total, unit } = stageProgress(state.stage);
      const pct = total ? Math.round((done / total) * 100) : 0;
      const shots = project.shots || [];

      // 这一阶段还缺哪些，列出来点得到
      let missing = [];
      if (state.stage === 'assets') missing = shots.filter((s) => !s.imagePath);
      else if (state.stage === 'video') missing = shots.filter((s) => s.imagePath && !s.videoPath);
      else if (state.stage === 'voice') missing = shots.filter((s) => s.dialogue?.trim() && !s.audioPath);
      else if (state.stage === 'bible' && project.bible) {
        missing = [...project.bible.characters, ...project.bible.scenes, ...(project.bible.props || [])]
          .filter((x) => !x.sheetPath);
      }

      const runnable = !jobBusy();
      const isCostly = state.stage === 'video';
      const pendingCount = stageProgress('video').pending || 0;

      /**
       * 待认领的任务：提交成功了、钱花了、片子在厂商那边，我们没取回来。
       *
       * 这类状态最要命的地方在于它**卡住整条流水线**：既不算完成（合成时缺一块），
       * 也不算失败（重跑要再花一次钱）。所以给一个零成本的出口 ——
       * 重查一次不产生任何生成费用，刚在「接口地址」里填对路径的话，
       * 这一下能把之前卡住的全收回来。
       */
      /**
       * ══════════ 开跑之前的那张清单 ══════════
       *
       * ⚠ **摆在按钮上面，而且不是弹窗。**
       *
       * 弹窗每次都拦一下，三次之后就变成"闭着眼点确定"—— 那时候它连
       * blocker 一起被跳过了，比没有更坏。摆成一块常驻的、就在按钮上面的
       * 清单，看不看由人，但它一直在那儿。
       *
       * 只有 blocker 才真的拦一下（那种跑下去几乎一定要重来的）。
       *
       * ⚠ 没问题时也要显示"检查过了，没发现问题"——
       * 整块消失的话，"这里什么都没有"和"检查过了、干净的"就分不出来，
       * 而前者会让人自己再查一遍，那正是这个功能要消灭的往返。
       */
      const stepCheckBox = h('div', { class: 'stepcheck' });
      if (['assets', 'video', 'voice', 'compose'].includes(state.stage)) {
        api(`/projects/${project.id}/stepcheck?stage=${state.stage}`).then((r) => {
          if (!r) return;
          clear(stepCheckBox);
          const tone = r.blockers ? 'bad' : r.warns ? 'iffy' : 'ok';
          add(stepCheckBox,
            h('div', { class: `stepcheck-head ${tone}` }, r.summary),
            ...r.items.map((it) => h('div', { class: `stepcheck-item ${it.level}` },
              h('div', { class: 'stepcheck-what' },
                h('span', { class: `stepcheck-dot ${it.level}` },
                  it.level === 'blocker' ? '拦' : it.level === 'warn' ? '建议' : '可选'),
                it.what),
              h('div', { class: 'stepcheck-why' }, it.why),
              h('div', { class: 'stepcheck-fix' }, `→ ${it.fix}`),
              // 点镜号直接跳过去改 —— 说了"第 7、12、19 镜"却要人自己去翻，
              // 等于把清单的价值折掉一半
              it.shots?.length
                ? h('div', { class: 'stepcheck-shots' },
                    '涉及：',
                    ...it.shots.slice(0, 12).map((n) => h('button', {
                      class: 'btn ghost xs',
                      onclick: () => {
                        const card = document.querySelector(`[data-shot-index="${n}"]`);
                        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                    }, `第 ${n} 镜`)),
                    it.shots.length > 12 ? h('span', { class: 'muted' }, ` 等 ${it.shots.length} 镜`) : null)
                : null)),
            /**
             * 支点那句话。没有它的话，用户看到一堆黄字，
             * 最省事的做法永远是直接按「开始」。
             */
            r.skipCost ? h('div', { class: 'stepcheck-cost' }, r.skipCost) : null);
          state.lastStepCheck = r;
        }).catch(() => {});
      }

      const pendingBox = pendingCount && state.stage === 'video'
        ? h('div', { class: 'fail-box', style: 'margin-top:12px' },
            h('div', { class: 'fail-head' }, `${pendingCount} 个任务已提交，但没取回来`),
            // 纯文本节点里写 ** 只会原样印出来 —— 要强调就用元素
            h('div', { class: 'fail-tip' },
              '这些镜头的片子多半已经在厂商平台上出好了 —— 钱花了，只是我们查不到状态。重查一次 ',
              h('b', {}, '不重新生成、不花钱'),
              '；如果你刚在「服务商与密钥 → 接口地址（高级）」里填对了查任务的地址，这一下就能把它们全收回来。'),
            h('div', { class: 'inline', style: 'margin-top:10px' },
              h('button', {
                class: 'btn sm primary',
                disabled: !runnable,
                // cap:task-reclaim
                onclick: () => recheckTasks()
              }, '重查待认领任务（不花钱）'),
              h('button', { class: 'btn ghost sm', onclick: () => go('providers') }, '去填查任务地址')))
        : null;

      const ratio = project.aspectRatio || state.catalog?.settings?.aspectRatio || '16:9';
      add(stageDetail,
        h('div', { class: 'stage-detail-head' },
          h('div', {},
            h('div', { class: 'stage-detail-title' }, meta.label,
              // 画幅在**下手之前**就得看见：竖屏短剧出成横的，整条流水线白跑
              state.stage === 'assets' || state.stage === 'video'
                ? h('span', { class: 'badge', style: 'margin-left:8px',
                    title: '出图和出视频都按这个画幅。改它去「项目」页' }, `画幅 ${ratio}`)
                : null),
            h('div', { class: 'stage-detail-hint' }, meta.hint),
            /**
             * 这一下要花多少 —— 摆在按钮**上面**。
             *
             * 这句话是给"还没按"的那个人看的。按完再告诉他花了多少就晚了，
             * 而这条流水线上最贵的一步（出视频）恰恰是最没法反悔的一步。
             *
             * 没填单价就显示用量（12 张图、60 秒），那同样是一个能拿来
             * 做决定的数，而且一个字都不是猜的。
             */
            // cap:spend-estimate
            (() => {
              const line = costText(state.stage);
              if (!line) return null;
              const unpriced = line.includes('还没填单价') || line.includes('没算进去');
              return h('div', { class: `cost-line${unpriced ? ' unpriced' : ''}` }, line);
            })()
          ),
          h('div', { class: 'inline' },

            /**
             * ══════════ 在跑的时候，这颗按钮就是「停下来」 ══════════
             *
             * ⚠ 不是"变灰"，是**换成另一个动作**。
             *
             * 变灰的话，人看到的是一颗点不动的按钮和一段"已经在跑了"的长文案 ——
             * 他真正想干的那件事（停下来）藏在别处。用户的原话是
             * "你在出的话就不能点击继续出图，可以暂停"。
             *
             * 而且这里显示的是**服务端的进度**（第几镜、跑了多久），
             * 不是这个页面自己记的那份 —— 刷新、换设备、流断都不影响它。
             */
            job.serverRunning
              ? h('button', {
                  class: 'btn',
                  title: '停在当前这一镜之后。已经出好的都留着',
                  disabled: job.serverRunning.cancelling,
                  onclick: async () => {
                    try {
                      const r = await api(`/projects/${project.id}/cancel`, { method: 'POST' });
                      toast(r.message || '正在停…', 'ok');
                      syncJob(project.id);
                    } catch (err) { toast(err.message, 'err'); }
                  }
                }, job.serverRunning.cancelling ? '正在停…' : '■ 停下来')
              : h('button', {
              class: 'btn primary',
              disabled: !runnable,
              title: isCostly ? '视频按镜数计费，是这条流水线最大的开销' : '',
              onclick: () => {

                // 原来这里写的是"按镜数计费且耗时较长"—— 一句正确但没有信息量的话。
                // 现在把真数放进去（没填单价就放用量），人才有得判断
                /**
                 * ⚠ 只有 blocker 才拦。
                 *
                 * 把 warn 也拿来拦的话，这颗按钮会天天弹框 ——
                 * 三次之后人就学会闭着眼点确定，那时候 blocker 一起被跳过了。
                 */
                const sc = state.lastStepCheck;
                if (sc?.blockers && sc.stage === state.stage) {
                  const first = sc.items.find((i) => i.level === 'blocker');
                  if (!confirm(`${first.what}。\n\n${first.why}\n\n${first.fix}\n\n还是要现在跑吗？`)) return;
                }
                if (isCostly && missing.length > 3
                  && !costConfirm(`将为 ${missing.length} 个镜头生成视频，耗时较长。确定？`, state.stage)) return;

                runStage(state.stage);
              }
            }, done ? `继续（还差 ${total - done}）` : '开始'),
            /**
             * 在跑的时候把**服务端的进度**摆出来。
             * 页面自己记的那份一刷新就没了，而这个数是问出来的。
             */
            job.serverRunning
              ? h('span', { class: 'field-hint', style: 'margin:0 0 0 8px' },
                  `${job.serverRunning.stageLabel || job.serverRunning.stage} 中`
                  + (job.serverRunning.shotIndex ? ` · 第 ${job.serverRunning.shotIndex} 镜` : '')
                  + ` · 已跑 ${Math.round((job.serverRunning.elapsedMs || 0) / 1000)} 秒`)
              : null,
            done && done === total
              ? h('button', {
                  class: 'btn ghost',
                  disabled: !runnable,
                  onclick: () => {

                    // 整步重跑是**全部重出**，不是补缺口 —— 预估也要按 regenerate 算，
                    // 否则这里会显示一个"还差 0 个"的 ¥0，而实际要重出一整步
                    if (!costConfirm('这一步已经完成，重跑会覆盖已有产出并重新计费。确定？',
                      state.stage, { regenerate: true })) return;

                    runStage(state.stage, { regenerate: true });
                  }
                }, '整步重跑')
              : null
          )
        ),
        // cap:stepcheck
        stepCheckBox,
        total
          ? h('div', {},
              h('div', { class: 'progress-bar' }, h('div', { class: 'progress-fill', style: `width:${pct}%` })),
              h('div', { class: 'progress-text' }, `${done} / ${total} ${unit}（${pct}%）`)
            )
          : h('div', { class: 'progress-text' }, '这一步还没有可统计的产出'),
        pendingBox,
        missing.length
          ? h('div', { class: 'stage-missing' },
              h('span', { class: 'eyebrow' }, `还缺 ${missing.length} 项`),
              h('div', { class: 'inline', style: 'margin-top:6px' },
                missing.slice(0, 20).map((m) =>
                  h('span', { class: 'badge warn' }, m.name || `SH ${String(m.index).padStart(3, '0')}`)),
                missing.length > 20 ? h('span', { class: 'badge' }, `…另外 ${missing.length - 20} 项`) : null)
            )
          : null
      );
    }

    /**
     * 跑一个阶段。
     *
     * 注意这里**不碰任何 DOM**，只往模块级的 job 里写、然后喊一声。
     * 谁在听、听完画到哪儿，是视图自己的事 —— 中途切走再回来，
     * 换的只是听众，任务本身不受影响。
     */
    async function runStage(stageId, extra = {}) {
      if (jobBusy()) return;
      job.projectId = project.id;
      job.stage = stageId;
      job.lastStage = stageId;
      job.doneCount = 0;
      job.live.clear();
      job.log = [];
      job.failures = [];
      job.startedAt = Date.now();
      jobNotify('start');

      try {
        await stream(
          // cap:run-stage cap:run-from
          `/projects/${project.id}/stage/${stageId}`,
          { shotCount: Number(shotCount.value) || 8, ...extra },
          (ev) => {
            trackLive(ev);
            // 失败的镜头单独记一份：日志会被几十条轮询刷走，而"为什么失败"恰恰是
            // 最该留在眼前的一条。视频那一步尤其如此，跑十几分钟最后只看到一行红字。
            if ((ev.type === 'shot' || ev.type === 'sheet') && ev.status === 'failed') {
              const shot = (project.shots || []).find((s) => s.id === ev.shotId);
              job.failures.push({
                who: ev.name || (shot ? `第 ${shot.index} 镜` : ev.shotId),
                message: ev.message || '未说明原因'
              });
            }
            // 整步就没跑起来（缺前置产出、缺密钥、服务不通）也是失败，一样要摊开
            if (ev.type === 'error') job.failures.push({ who: '整步', message: ev.message });
            // 主动停下来**不是失败**。混进失败清单里，会让人回头去查一个
            // 根本不存在的问题 —— 而他自己按的那一下才是原因
            if (ev.type === 'cancelled') job.cancelled = true;

            const text = describe(ev);
            if (text) {
              job.log.push({ type: ev.type, text });
              // 日志留个上限，跑几百镜不至于把内存堆爆
              if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
            }
            jobNotify('tick');
          }
        );
      } catch (err) {
        job.failures.push({ who: '整步', message: err.message });
      } finally {
        const spent = Date.now() - job.startedAt;
        const failed = job.failures.length;
        const cancelled = job.cancelled;
        job.cancelled = false;
        job.stage = null;
        job.live.clear();
        jobNotify('done');
        /**
         * 跑完把账重新拉一遍。
         *
         * 不拉的话，刚花完钱的那一刻账面上还是上一次的数 —— 而
         * "我刚跑完这一步，到底花了多少"正是最想当场知道的那个问题。
         * 停下来和失败也要拉：那两种情况下钱**照样花了一部分**。
         */
        loadSpend();
        toast(
          cancelled
            ? `已停下，用时 ${fmtMs(spent)}。已经跑完的都存着了，接着跑就从这一步「往后全跑」`
            : failed
              ? `${failed} 项失败，看流水线下面的失败原因`
              : `完成，用时 ${fmtMs(spent)}`,
          cancelled ? 'ok' : failed ? 'err' : 'ok'
        );
      }
    }

    /** 重查待认领的任务。只是再问一次，不重新生成，所以不花钱。 */
    async function recheckTasks() {
      if (jobBusy()) return;
      job.projectId = project.id;
      job.stage = 'video';
      job.lastStage = 'video';
      job.doneCount = 0;
      job.live.clear();
      job.log = [];
      job.failures = [];
      job.startedAt = Date.now();
      jobNotify('start');
      try {
        await stream(`/projects/${project.id}/tasks/recheck`, {}, (ev) => {
          trackLive(ev);
          if (ev.type === 'error') job.failures.push({ who: '重查', message: ev.message });
          const text = describe(ev);
          if (text) job.log.push({ type: ev.type, text });
          jobNotify('tick');
        });
      } catch (err) {
        job.failures.push({ who: '重查', message: err.message });
      } finally {
        job.stage = null;
        job.live.clear();
        jobNotify('done');
        toast(job.failures.length ? '有任务还是没收回来，看下面的原因' : '重查完成', job.failures.length ? 'err' : 'ok');
      }
    }

    /**
     * 任务有动静时重画。这是视图和任务之间**唯一**的接口。
     *
     * done 的时候必须重新拉一次项目：新出的图和视频在服务端已经落盘了，
     * 手里这份 project 还是旧的 —— "要退出去再进来才看得到"就是这么来的。
     */
    async function onJobUpdate(kind) {
      // 有活儿在跑才摆「停」。平时摆一个灰着的按钮是纯噪音
      stopBtn.style.display = jobBusy() ? '' : 'none';
      if (kind === 'start') {
        stopBtn.disabled = false;
        clear(progressLog);
        painted = 0;
        clear(failHost);
        progressLog.style.display = '';
        syncNav();
        paintStageDetail();
        hideResult();
        return;
      }
      if (kind === 'tick') {
        // 跑的过程只更新日志和**卡片自己的状态条**，右下角一声不吭
        paintLog();
        return;
      }
      /**
       * ⚠ 问服务端问出"在跑 / 不在跑"变了 —— 只重画**那一块面板**。
       *
       * 少了这一下，轮询把状态更新了却没人重画，按钮照旧是「继续出图」——
       * 也就是用户撞到的那个：点下去回一段"这个项目已经在跑（321 秒前开始）"。
       *
       * ⚠ 只画 stage-detail，**不重画整页**。你可能正在某张卡片里改台词，
       * 而这个轮询每四秒响一次 —— 重画整页等于每四秒把你打的字吃掉一次。
       */
      if (kind === 'server') {
        paintStageDetail();
        syncNav();
        return;
      }
      // done
      paintLog();
      clear(liveBadge);
      paintFailures(job.failures);

      /**
       * 跑完之后**尽量不重画整页**，但该重画的必须重画。
       *
       * 不重画整页的理由：你正在某张卡片里改台词，一镜出完了，整个网格被推倒重建 ——
       * 输入框连同还没保存的字一起没了。出图出视频动辄十几分钟，
       * 这段时间正是拿来改后面几镜文案的。
       *
       * 但有两步的产出**根本不在分镜卡里**：设定集出的是设定图、分镜出的是
       * 一整张新的分镜表。这两步跑完只补几张卡等于什么都没补 ——
       * 页面停在跑之前的样子，看着就像"跑完了什么也没有"。
       *
       * ⚠ 这里曾经判的是 `job.stage`，而 runStage 的 finally 里**先把它清成 null**
       * 才通知 done —— 于是这个判断永远为假，设定集和分镜跑完页面一动不动。
       * 现在用 lastStage（专门为收尾留的那份），并且项目数据无论如何都重新拉一次：
       * 拉数据不碰 DOM，代价只有一次请求，而拉漏了就是"生成完没东西"。
       */
      project = (await api(`/projects/${project.id}`).catch(() => project)) || project;
      const structural = ['script', 'all', 'bible'].includes(job.lastStage);
      if (structural) {
        await paintDuration();
        // 设定集那一步的产出在设定集面板里，它是懒挂的 —— 不重挂就还是跑之前那份
        remountBible();
        applyScope();
      } else {
        // 逐镜补最新状态：跑的时候已经边跑边换了，这里兜底收一遍漏网的
        await Promise.all([...touchedShots].map((id) => refreshShot(id)));
        touchedShots.clear();
        if (state.stage === 'video') paintDurationLine();
      }
      syncNav();
      paintStageDetail();
      // 设定集、分镜这两步不是按镜头逐个报完成的，doneCount 会是 0 ——
      // 报"0 项完成"等于告诉人家白跑了一趟。这两步按**产出**报数。
      const prog = stepProgress(project, job.lastStage);
      showResult({
        ok: job.doneCount || prog.done,
        unit: job.doneCount ? '项完成' : `${prog.unit || '项'}`,
        fail: job.failures.length,
        label: steps.find((x) => x.id === job.lastStage)?.label || '这一轮'
      });
    }

    /**
     * 右下角的**结果**提示。
     *
     * 刻意不是一块常驻面板：跑的时候盯着一个不停跳数字的框没有意义，
     * 而且它一直压在右下角会挡住分镜卡 —— 而生成那十几分钟正是拿来改文案的。
     *
     * "现在跑到哪一镜"这件事在**卡片上**说（每张卡自己的状态条），那儿才是它该在的地方。
     * 这里只在**出结果**时冒一次：几成几败，成功的几秒后自己消失，
     * 失败的留着不走 —— 失败原因是要读的，读完自己关。
     */
    let hudTimer = null;
    function showResult({ ok, fail, label, unit = '项完成' }) {
      const hud = document.querySelector('#job-hud');
      if (!hud) return;
      clearTimeout(hudTimer);
      clear(hud);
      hud.hidden = false;
      hud.className = `job-hud ${fail ? 'bad' : 'good'}`;
      add(hud,
        h('div', { class: 'job-hud-head' },
          h('span', {}, fail ? '✕' : '✓'),
          h('b', {}, fail ? `${label}：${fail} 项失败` : `${label}完成`),
          h('button', {
            class: 'job-hud-x',
            onclick: () => { hud.hidden = true; }
          }, '×')),
        h('div', { class: 'job-hud-line' },
          fail
            ? (job.failures[0]?.message || '').slice(0, 120)
            : `${ok} ${unit}`),
        fail
          ? h('div', { class: 'job-hud-foot' },
              h('button', {
                class: 'btn ghost sm',
                onclick: () => {
                  progressLog.style.display = '';
                  failHost.scrollIntoView({ block: 'center' });
                  hud.hidden = true;
                }
              }, '看失败原因'))
          : null);
      // 成功的自己走；失败的留着 —— 那句报错是要读的
      if (!fail) hudTimer = setTimeout(() => { hud.hidden = true; }, 6000);
    }

    function hideResult() {
      const hud = document.querySelector('#job-hud');
      if (!hud) return;
      clearTimeout(hudTimer);
      hud.hidden = true;
    }

    /**
     * 只把**一张卡片**换成最新的。
     *
     * 这是"生成的地方加载最新状态、别整篇重来"的落点：出完一镜就换那一镜，
     * 其余卡片连同你正在编辑的输入框原样不动。
     * 正在编辑的那张卡跳过 —— 换掉它等于把人家打了一半的字扔掉，
     * 等编辑器关掉时再补。
     */
    const touchedShots = new Set();
    const shotCards = new Map(); // shotId → { card, editing }

    async function refreshShot(shotId) {
      const entry = shotCards.get(shotId);
      if (!entry?.card?.isConnected) return;
      if (entry.editing) {
        entry.pending = true; // 正在改文案，等改完再换
        return;
      }
      const r = await api(`/projects/${project.id}/shots/${shotId}`).catch(() => null);
      if (!r?.shot) return;
      const i = (project.shots || []).findIndex((x) => x.id === shotId);
      if (i === -1) return;
      project.shots[i] = r.shot;
      if (r.updatedAt) project.updatedAt = r.updatedAt;
      const next = renderShotCard(project.shots[i]);
      entry.card.replaceWith(next);
      entry.card = next;
    }

    // 已经画到 job.log 的第几条。轮询事件来得密，每次全量重画会让滚动明显发卡
    let painted = 0;

    /** 把 job.log 画到面板上。平时只补新增的几条；切回来时整份重画一次 */
    function paintLog({ full = false } = {}) {
      if (!job.log.length) {
        progressLog.style.display = 'none';
        painted = 0;
        return;
      }
      progressLog.style.display = '';
      // 只保留最后 120 条：再多也没人看，DOM 还会拖慢滚动
      if (full || painted > job.log.length) {
        clear(progressLog);
        painted = Math.max(0, job.log.length - 120);
      }
      for (const line of job.log.slice(painted)) {
        progressLog.append(h('div', { class: `ev-${line.type}` }, line.text));
      }
      painted = job.log.length;
      while (progressLog.childElementCount > 120) progressLog.removeChild(progressLog.firstChild);
      progressLog.scrollTop = progressLog.scrollHeight;
      for (const shotId of job.live.keys()) paintLive(shotId);
    }

    paintStageDetail();
    /**
     * 当前这一步的操作台。
     *
     * 横向的阶段轨拆掉了 —— 它现在在左边菜单里，而且带完成标记。
     * 这里只留"这一步是什么、跑到哪儿了、点哪儿开跑"，
     * 加上一个从头跑到尾的入口。
     */
    /**
     * 一键跑完：必须先问"从哪儿开始"。
     *
     * 只给"从头跑"是不够用的 —— 日常最常见的情形是设定集和分镜早就审过了，
     * 只想把后面几步串起来跑。从头跑一遍不但白花钱，还会**把你改过的分镜文案冲掉**
     * （重拆分镜等于推翻重来）。所以摆两条路，并且把各自会跑哪几步写清楚。
     */
    /**
     * ══════════════ 这一下要花多少 ══════════════
     *
     * 界面里讲了一整年的钱 —— "视频那步最贵""改这个要重出""重跑按镜数计费" ——
     * 却从来没给过一个数。这几个函数就是把那些话变成数。
     *
     * 算在**浏览器这一边**，用的是和服务端同一份 estimate.js / pricing.js
     * （从 /estimate.js 直接取原件）。不走接口是因为这个数要跟着
     * "切了一下阶段""勾了整步重跑"实时变 —— 每次都发一趟请求的话，
     * 数字会比手慢半拍，而慢半拍的价钱等于没有。
     */
    function costRouting() {
      const r = state.catalog?.routing || {};
      return {
        image: { provider: r.image?.provider, model: r.image?.model },
        video: {
          provider: r.video?.provider,
          model: r.video?.model,
          // 厂商档位必须带上：分镜写 4 秒、厂商只出 5 秒档、按 5 秒计费
          durations: state.catalog?.videoDurations || []
        },
        tts: { provider: r.tts?.provider, model: r.tts?.model }
      };
    }

    function costRates() {
      return state.catalog?.settings?.rates || {};
    }

    function costRetries() {
      const s = state.catalog?.settings || {};
      return s.consistencyVerify ? Number(s.consistencyMaxRetries) || 0 : 0;
    }

    /** 某一步的预估。stage 传 'all' 时按「从这一步往后跑」算。 */
    function costPlan(stage, { regenerate = false, from = null } = {}) {
      const shots = project.shots || [];
      const routing = costRouting();
      const maxRetries = costRetries();
      return from
        ? EST.forRun({ shots, from, routing, maxRetries })
        : EST.forStage({ shots, stage, routing, regenerate, maxRetries });
    }

    function costText(stage, opts = {}) {
      try {
        return EST.describe(costPlan(stage, opts), costRates());
      } catch {
        // 预估算不出来绝不能挡住跑流水线这件事本身
        return '';
      }
    }

    /**
     * 确认框里的那句话。
     *
     * 原来写的是"按镜数计费且耗时较长"—— 一句正确但没有信息量的话。
     * 现在把真数放进去。没填单价的时候放**用量**（12 张图、60 秒），
     * 那同样是一个能拿来做决定的数，而且一个字都不是猜的。
     */
    function costConfirm(question, stage, opts = {}) {
      const line = costText(stage, opts);
      return confirm(line ? `${question}\n\n${line}` : question);
    }

    /**
     * ══════════════ 这个项目到现在花了多少 ══════════════
     *
     * 和上面那个是**两种不同的真相**，所以摆在不同的地方、用不同的措辞：
     * 上面讲还没发生的（"要发"），这里讲已经发生的（"已经发了"）。
     *
     * 用量是记下来的事实；钱是拿你填的单价现算的。没填就只显示用量 ——
     * 那部分永远是真的，而且已经比什么都不说强得多。
     */
    const spendHost = h('div', { class: 'card', style: 'margin-top:14px' });
    let spend = null;
    let spendOpen = false;

    async function loadSpend() {
      try {
        // cap:spend-project
        spend = await api(`/projects/${project.id}/spend`);
      } catch (err) {
        spend = { error: err.message };
      }
      paintSpend();
    }

    function paintSpend() {
      clear(spendHost);
      if (!spend) {
        add(spendHost, h('div', { class: 'field-hint' }, '正在读这个项目的账…'));
        return;
      }
      if (spend.error) {
        add(spendHost, h('div', { class: 'field-hint' }, `账读不出来：${spend.error}`));
        return;
      }

      const missing = spend.total?.missing || [];
      const head = h('summary', { class: 'card-title' },
        '这个项目花了多少',
        h('span', { class: 'badge', style: 'margin-left:8px' },
          spend.calls ? `${spend.calls} 次调用` : '还没花过'));

      const body = h('div', {});

      add(body, h('div', { class: 'spend-line' }, spend.line));

      /**
       * 分口径摊开。只摊有数的那些 —— 一整排 0 是噪音，
       * 而"这个项目一次视频都没出"本来就该由那一行的缺席来表达。
       */
      const rows = [];
      for (const [kind, spec] of Object.entries(spend.kinds || {})) {
        const b = spend.total?.byKind?.[kind];
        if (!b || !b.calls) continue;
        const money = PRICING.fmtMoney(b.cny);
        rows.push(h('div', { class: 'spend-row' },
          h('span', { class: 'spend-kind' }, spec.label),
          h('span', { class: 'spend-units' }, PRICING.describeUnits(kind, b.units)),
          h('span', { class: 'spend-money' },
            b.priced ? money : h('span', { class: 'field-hint' }, '没填单价'))));
      }
      if (rows.length) add(body, h('div', { class: 'spend-table' }, ...rows));

      /**
       * 漏账要说出来。
       *
       * "有 3 次调用厂商没回用量"是一句难看的话，但它是真的 ——
       * 而一个悄悄少了 3 次的总数看起来完全正常，那才是真正的问题。
       */
      if (spend.unmetered) {
        add(body, h('div', { class: 'field-hint', style: 'margin-top:8px' },
          `另有 ${spend.unmetered} 次调用没记上账 —— `,
          spend.blind?.length
            ? `${spend.blind.map((x) => `${x.provider}/${x.model}`).join('、')} 没在响应里回用量。`
            : '厂商没在响应里回用量。',
          '这几次的钱确实花了，只是我们数不出来。'));
      }

      // 还差哪些单价 —— 就地填，不用跑去设置页
      if (missing.length) add(body, rateFiller(missing, '这几样已经用过了，但还没填单价：'));

      add(spendHost, h('details', { open: spendOpen, ontoggle: (e) => { spendOpen = e.target.open; } },
        head, body));
    }

    /**
     * 就地填单价。
     *
     * ⚠ 这里**不预填任何厂商的价**。理由见 core/pricing.js 开头：
     * 各家单价我只有个印象，印象填进输入框就变成了一个看起来权威的默认值，
     * 而用户多半会直接点保存。而且标价根本不是他的价 ——
     * 有额度包、有企业协议、走中转的能差一倍。让他照着自己的账单抄。
     */
    function rateFiller(missing, title) {
      const box = h('div', { class: 'rate-filler' });
      const inputs = new Map();

      add(box, h('div', { class: 'field-hint', style: 'margin:10px 0 6px' }, title));
      for (const m of missing) {
        const spec = PRICING.KINDS[m.kind] || {};
        const row = h('div', { class: 'rate-row' });
        add(row, h('span', { class: 'rate-who' }, PRICING.describeMissing(m)));
        if (spec.pair) {
          const i1 = h('input', { class: 'input sm', type: 'number', step: 'any', min: '0', placeholder: '输入' });
          const i2 = h('input', { class: 'input sm', type: 'number', step: 'any', min: '0', placeholder: '输出' });
          inputs.set(m.key, { pair: true, i1, i2 });
          add(row, i1, i2);
        } else {
          const i1 = h('input', { class: 'input sm', type: 'number', step: 'any', min: '0', placeholder: spec.priceUnit || '单价' });
          inputs.set(m.key, { pair: false, i1 });
          add(row, i1);
        }
        add(box, row);
      }

      add(box,
        h('div', { class: 'inline', style: 'margin-top:8px' },
          h('button', {
            class: 'btn sm primary',
            // cap:spend-rates
            onclick: async (e) => {
              const rates = {};
              for (const [key, f] of inputs) {
                if (f.pair) {
                  // 进出两个都得填 —— 只填一个算不出钱，存下来只会让人以为填过了
                  if (f.i1.value === '' || f.i2.value === '') continue;
                  rates[key] = { in: Number(f.i1.value), out: Number(f.i2.value) };
                } else {
                  if (f.i1.value === '') continue;
                  rates[key] = { cny: Number(f.i1.value) };
                }
              }
              if (!Object.keys(rates).length) return toast('还没填任何单价');
              e.target.disabled = true;
              try {
                await api('/rates', { method: 'PUT', body: { rates } });
                // 目录里那份 settings 要一起刷新，不然预估还在用旧单价
                state.catalog = await api('/catalog');
                await loadSpend();
                // 预估那几行也要跟着重画 —— 刚填完单价，上面还写着
                // "还没填单价，算不出钱"的话，人会以为没存进去
                paintStageDetail();
                toast('单价存下了，过去的账也按新单价重算了');
              } catch (err) {
                toast(`存不下：${err.message}`);
              } finally {
                e.target.disabled = false;
              }
            }
          }, '存单价'),
          h('span', { class: 'field-hint' },
            '照你自己账单上的价填。我们不预填任何数 —— 标价不是你的价，'
            + '有额度包、有协议、走中转的能差一倍。')));
      return box;
    }

    const runChoice = h('div', { style: 'display:none;margin:8px 0 2px' });

    function paintRunChoice() {
      const order = ['bible', 'script', 'assets', 'video', 'voice', 'compose'];
      const at = order.indexOf(state.stage);
      const label = steps.find((x) => x.id === state.stage)?.label || '';
      const rest = at >= 0 ? order.length - at : 0;
      clear(runChoice);
      add(runChoice,
        h('div', { class: 'inline', style: 'flex-wrap:wrap' },
          h('button', {
            class: 'btn sm',
            disabled: jobBusy(),
            title: '设定集 → 分镜 → 出图 → 视频 → 配音 → 合成，六步全跑',
            onclick: () => {
              if (!confirm('从头跑完整条：会重跑设定集和分镜，已经审过、手改过的分镜文案会被覆盖。确定？')) return;
              runChoice.style.display = 'none';
              runStage('all');
            }
          }, `从头跑完整条（${order.length} 步）`),
          at >= 0
            ? h('button', {
                class: 'btn sm primary',
                disabled: jobBusy(),
                title: '前面几步保留已有产出，不重跑、不重复计费',
                onclick: () => {
                  if (!costConfirm(`从「${label}」往后跑 ${rest} 步。`, 'all', { from: state.stage })) return;
                  runChoice.style.display = 'none';
                  runStage('all', { from: state.stage });
                }
              }, `从「${label}」往后跑（${rest} 步）`)
            : null,
          h('button', {
            class: 'btn ghost sm',
            onclick: () => { runChoice.style.display = 'none'; }
          }, '取消')),
        h('div', { class: 'field-hint', style: 'margin:6px 0 0' },
          at >= 0
            ? '从这一步往后跑：前面几步的产出原样保留，不重跑也不重复计费。日常用这条。'
            : '当前这一步不在流水线里（比如「剧本」），只能从头跑。'),
        // 「往后跑」那几步加起来多少钱 —— 这是整条链路上最该有个数的地方
        at >= 0 ? h('div', { class: 'cost-line' }, costText('all', { from: state.stage })) : null);
    }

    /**
     * 停下来。
     *
     * 只在真的有活儿在跑时才出现 —— 平时摆一个灰着的「停」是纯噪音。
     *
     * 按钮上的字是「停在这一镜之后」而不是「取消」，这一条是有意的：
     * 取消不会掐断手上正在跑的那一镜（钱已经花了，掐掉等于白花），
     * 写「取消」的话，用户点完看到它又跑完一镜会以为按钮坏了。
     */
    const stopBtn = h('button', {
      class: 'btn ghost sm danger',
      style: 'margin-left:8px',
      title: '手上这一镜会跑完并存下来（钱已经花了），后面还没开始的一镜都不发',
      onclick: async () => {
        stopBtn.disabled = true;
        try {
          // cap:job-cancel
          const r = await api(`/projects/${project.id}/cancel`, { method: 'POST' });
          toast(r.message, 'ok');
          job.log.push({ type: 'note', text: `※ ${r.message}` });
          jobNotify('tick');
        } catch (err) {
          toast(err.message, 'err');
          stopBtn.disabled = false;
        }
      }
    }, '■ 停在这一镜之后');
    stopBtn.style.display = jobBusy() ? '' : 'none';

    const stagePanel = h('div', { class: 'panel' },
      h('h2', { class: 'panel-title' }, '这一步', liveBadge,
        h('button', {
          class: 'btn ghost sm',
          style: 'margin-left:auto',
          disabled: jobBusy(),
          title: '一路跑到底。点开会先问从哪一步开始 —— 从头跑会覆盖已经审过的分镜',
          onclick: () => {
            const open = runChoice.style.display === 'none';
            if (open) paintRunChoice();
            runChoice.style.display = open ? '' : 'none';
          }
        }, '▶ 一键跑完'),
        stopBtn),
      runChoice,
      stageDetail,
      progressLog,
      failHost
    );

    // ───────────── 分镜网格 ─────────────
    const shotHost = h('div', {});

    /**
     * 出图/出视频的服务商 + 模型下拉，重出时用。
     * 视频这一路多一个分辨率档位 —— 单镜返工往往就是为了"这一镜换个清晰度再试"，
     * 没必要为它跑一趟设置页。档位跟着所选服务商走，各家写法不一样。
     */
    function modelPicker(capability, defaults) {
      const candidates = state.catalog.providers.filter((p) => (p.capabilities || []).includes(capability));
      const provSel = h('select', { class: 'mini' },
        h('option', { value: '' }, `默认（${defaults.provider}）`),
        ...candidates.map((p) => h('option', { value: p.id }, p.name)));
      const modelSel = h('select', { class: 'mini' }, h('option', { value: '' }, '默认模型'));
      const resSel = capability === 'i2v' ? h('select', { class: 'mini' }) : null;

      const refill = () => {
        const p = state.catalog.providers.find((x) => x.id === (provSel.value || defaults.provider));
        clear(modelSel).append(h('option', { value: '' }, `默认（${defaults.model}）`));
        for (const m of (p?.models || []).filter((m) => !m.capability || m.capability === capability)) {
          modelSel.append(h('option', { value: m.id }, m.label || m.id));
        }
        if (resSel) {
          const list = p?.videoDefaults?.resolutions || [];
          clear(resSel).append(h('option', { value: '' }, list.length ? '默认清晰度' : '该家不可选'));
          resSel.disabled = !list.length;
          for (const r of list) resSel.append(h('option', { value: r }, r));
        }
      };
      provSel.addEventListener('change', refill);
      refill();

      return {
        el: h('div', { class: 'shot-model-row' }, provSel, modelSel, resSel),
        values: () => ({
          provider: provSel.value || undefined,
          model: modelSel.value || undefined,
          resolution: resSel?.value || undefined
        })
      };
    }

    async function regenerate(shot, kind, picker, btn) {
      if (job.shots.has(shot.id)) return;
      const picked = picker.values();
      if (!confirmGeneration(kind, [shot], picked, kind === 'video' ? `重出第 ${shot.index} 镜视频` : `重出第 ${shot.index} 镜图片`)) return;
      job.projectId = project.id;
      job.lastStage = kind === 'video' ? 'video' : 'assets';
      job.doneCount = 0;
      job.shots.add(shot.id);
      job.live.set(shot.id, { status: 'running', message: '提交中…' });
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '生成中…';
      const failures = [];
      try {
        await stream(
          // cap:shot-regen
          `/projects/${project.id}/shots/${shot.id}/regenerate`,
          { kind, ...picked },
          (ev) => {
            // 单镜重出的事件不带 shotId（后端只往流里写这一镜的），补上再走同一套
            trackLive({ ...ev, shotId: ev.shotId || shot.id });
            if (ev.type === 'error') failures.push({ who: `第 ${shot.index} 镜`, message: ev.message });
            const text = describe({ ...ev, shotId: shot.id });
            if (text) job.log.push({ type: ev.type, text });
            jobNotify('tick');
          }
        );
      } catch (err) {
        failures.push({ who: `第 ${shot.index} 镜`, message: err.message });
      } finally {
        job.shots.delete(shot.id);
        job.live.delete(shot.id);
        btn.disabled = false;
        btn.textContent = label;
        if (failures.length) {
          job.failures = failures;
          toast(failures[0].message, 'err');
        } else {
          toast(`第 ${shot.index} 镜已重出`, 'ok');
        }
        // 重出完必须重新拉项目：新文件在服务端，手里这份还是旧的
        jobNotify('done');
      }
    }

    /**
     * 画一张分镜卡。
     *
     * 单独抽出来是为了能**只换一张** —— 出完一镜就替换那一张，
     * 其余卡片（包括你正在编辑的那个输入框）原样不动。
     */
    function renderShotCard(shot) {
      const sc = scope();
      const ordered = (project.shots || []).slice().sort((a, b) => a.index - b.index);
      const ordinal = ordered.findIndex((x) => x.id === shot.id);
      {
        // 上一镜。跨章不算 —— 跨章的"上一镜"不是同一段戏。
        const prevShot =
          ordinal > 0 && (ordered[ordinal - 1].chapterId || null) === (shot.chapterId || null)
            ? ordered[ordinal - 1]
            : null;
        const link = shot.link || (!prevShot ? 'new-scene' : sameScene(prevShot.scene, shot.scene) ? 'cut' : 'new-scene');
        const c = shot.consistency;
        const flagged = c?.needsReview;
        const failed = shot.status === 'failed' || !shot.imagePath;

        let thumb;
        // 重出的文件路径不变，光靠 URL 相同浏览器就会拿缓存 —— 带上项目的更新时间戳，
        // 内容一变链接就变。（服务端也回了 no-store，两头都堵上）
        const v = Date.parse(project.updatedAt || '') || 0;
        /**
         * 这一步该看图还是看视频。
         *
         * 早先是"只要出了视频就一律显示播放器"。于是回到出图那一步想检查
         * "这张脸对不对"，看到的却是一格视频封面 —— 而封面是压过的、
         * 还可能是黑帧。判断画质、看手指崩没崩，必须看那张原图。
         * 所以：出图那步看图，出视频那步看视频（还没出视频的仍然退回看图）。
         */
        const showVideo = sc.video && shot.videoPath;
        if (showVideo) {
          thumb = h('video', { src: `${mediaUrl(shot.videoPath)}&v=${v}`, controls: true, preload: 'metadata' });
        } else if (shot.imagePath) {
          // 点开看大图：缩略图两百来像素，判断"这张脸对不对""手指崩没崩"根本不够
          thumb = h('img', {
            class: 'zoomable',
            src: `${mediaUrl(shot.imagePath)}&v=${v}`,
            alt: `第 ${shot.index} 镜`,
            loading: 'lazy',
            title: '点开看大图（滚轮缩放，← → 翻页）',
            onclick: () => {
              const withImg = project.shots.filter((x) => x.imagePath).sort((a, b) => a.index - b.index);
              openLightbox(
                withImg.map((x) => ({
                  src: `${mediaUrl(x.imagePath)}&v=${v}`,
                  title: `SH ${String(x.index).padStart(3, '0')} · ${x.description || ''}`,
                  note: [
                    x.consistency?.score != null ? `一致性 ${x.consistency.score}` : '',
                    x.modelUsed || '',
                    x.seed ? `seed ${x.seed}` : ''
                  ].filter(Boolean).join('  ·  ')
                })),
                withImg.findIndex((x) => x.id === shot.id)
              );
            }
          });
        } else {
          thumb = h('span', {}, shot.status === 'failed' ? '生成失败' : '待生成');
        }

        // 用不上的那个下拉干脆不建，省得白拉一遍模型列表
        const imgPicker = sc.image ? modelPicker('t2i', state.catalog.routing.image) : null;
        const vidPicker = sc.video ? modelPicker('i2v', state.catalog.routing.video) : null;
        const imgBtn = h('button', { class: 'btn sm', onclick: () => regenerate(shot, 'image', imgPicker, imgBtn) },
          shot.imagePath ? '重出图' : '出图');
        const vidBtn = h('button', {
          class: 'btn sm',
          disabled: !shot.imagePath,
          onclick: () => regenerate(shot, 'video', vidPicker, vidBtn)
        }, shot.videoPath ? '重出视频' : '出视频');

        /**
         * 预演台的入口要在**卡片上**，不能只藏在「改这一镜」里面。
         *
         * 原来它是编辑面板底部的一个折叠块 —— 要先点开编辑、再往下翻过
         * 描述/台词/景别/时长/场次/档位/技法一大串才看得到。
         * 用户的原话是"没找到预演台"。**功能找不到等于没做**，
         * 而且这种漏法比崩溃更隐蔽：功能在、测试绿、就是没人用得上。
         *
         * 排过位的镜头按钮上带个点，扫一眼就知道哪几镜排过了。
         */
        const stageBtn = h('button', {
          class: 'shot-edit-btn',
          title: shot.stage?.cam
            ? '这一镜排过位了。点开调整机位、看景别、查越轴'
            : '排一下机位：拖人、拖机位，景别和越轴当场算给你看',
          onclick: () => {
            // 编辑面板里那块才是真正的画布，这里负责把它打开并滚过去
            openEdit();
            const box = editor.querySelector('.shot-previz');
            if (box) {
              box.open = true;
              box.dispatchEvent(new Event('toggle'));
              box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }, shot.stage?.cam ? '预演台 ·' : '预演台');

        /**
         * 历史版本。
         *
         * 每一次重出写的都是同一个路径，上一版原来是**直接被覆盖**的 ——
         * "重出三次，第二次最好"这种再常见不过的情形没有出路，只能再赌一次。
         * 而每一版都是真金白银出的：丢掉的不是文件，是已经花掉的钱。
         *
         * 按需拉，不预取：二十镜各拉一次目录列表，光是打开分镜页就要等。
         */
        const verBtn = h('button', {
          class: 'shot-edit-btn',
          title: '这一镜之前出过的版本，可以挑一版换回来',
          onclick: async () => {
            verBtn.disabled = true;
            try {
              // cap:shot-versions
              const v = await api(`/projects/${project.id}/shots/${shot.id}/versions`);
              const rows = [
                ...v.image.versions.map((x) => ({ ...x, kind: 'image', label: '图' })),
                ...v.video.versions.map((x) => ({ ...x, kind: 'video', label: '视频' }))
              ].sort((a, b) => (a.at < b.at ? 1 : -1));
              if (!rows.length) return toast('这一镜还没有历史版本 —— 重出一次之后，上一版就会留在这儿', 'ok');
              const box = h('div', { class: 'shot-versions' },
                h('div', { class: 'field-hint' },
                  `留最近 ${rows.length} 版。换回某一版之后，现在这一版也会被存起来 —— 换回去是可逆的。`),
                ...rows.map((x) => h('div', { class: 'inline', style: 'gap:8px;margin-top:6px' },
                  h('img', {
                    src: `${mediaUrl(x.path)}`,
                    style: 'width:56px;height:36px;object-fit:cover;border-radius:4px;background:#000',
                    onerror: (e) => { e.target.style.display = 'none'; }
                  }),
                  h('span', { class: 'badge' }, `${x.label} v${x.n}`),
                  h('span', { class: 'field-hint', style: 'margin:0' },
                    new Date(x.at).toLocaleString('zh-CN')),
                  h('button', {
                    class: 'btn ghost sm',
                    onclick: async (e) => {
                      e.target.disabled = true;
                      try {
                        const r = await api(`/projects/${project.id}/shots/${shot.id}/versions/restore`, {
                          method: 'POST', body: { kind: x.kind, n: x.n }
                        });
                        project = r.project;
                        toast(`已换回${x.label} v${x.n}`, 'ok');
                        paintShots();
                      } catch (err) {
                        toast(err.message, 'err');
                        e.target.disabled = false;
                      }
                    }
                  }, '换回这一版'))));
              const old = editor.querySelector('.shot-versions');
              if (old) old.remove();
              editor.append(box);
              openEdit();
              box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (err) {
              toast(err.message, 'err');
            } finally {
              verBtn.disabled = false;
            }
          }
        }, '历史版本');

        const manifestBtn = h('button', {
          class: 'shot-edit-btn', title: '查看每次生成用过的服务商、模型、提示词、种子、参考图和产物',
          onclick: async () => {
            try {
              const m = await api(`/projects/${project.id}/shots/${shot.id}/manifest`);
              const rows = [...m.history].reverse();
              const box = h('div', { class: 'shot-manifest' },
                h('b', {}, `第 ${shot.index} 镜生产清单`),
                rows.length ? rows.map((x) => h('details', {},
                  h('summary', {}, `${x.kind === 'video' ? '视频' : x.kind === 'previz' ? '3D预演控制包' : '图片'} · ${x.provider} / ${x.model} · ${new Date(x.at).toLocaleString('zh-CN')}`),
                  h('div', { class: 'shot-prompt-body' },
                    x.seed !== undefined ? `种子：${x.seed}\n` : '',
                    x.resolution ? `清晰度：${x.resolution}\n` : '',
                    x.renderedFrames ? `真实3D帧：${x.renderedFrames} 张 · ${x.controlFps || '—'}fps · ${x.keyframes || 0} 个关键帧\n` : '',
                    x.controlReferenceAccess ? `秘塔参考回读：${x.controlReferenceAccess.ok ? `通过（HTTP ${x.controlReferenceAccess.status}，${x.controlReferenceAccess.latencyMs}ms）` : `失败（${x.controlReferenceAccess.status ? `HTTP ${x.controlReferenceAccess.status}` : x.controlReferenceAccess.message || x.controlReferenceAccess.code}）`}\n` : '',
                    x.refs?.length ? `参考：${x.refs.join('、')}\n` : '',
                    x.prompt ? `提示词：${x.prompt}\n` : '',
                    `产物：${x.output || '—'}${x.controlReferenceVideo ? `\n参考视频：${x.controlReferenceVideo}` : ''}`)
                )) : h('div', { class: 'field-hint' }, '旧版本还没有生产清单；下一次单镜重出开始自动记录。'));
              editor.querySelector('.shot-manifest')?.remove();
              editor.append(box); openEdit(); box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (err) { toast(err.message, 'err'); }
          }
        }, '生产清单');

        const reviewCurrent = shot.review && shot.review.revision === [
          shot.imagePath || '', shot.videoPath || '', shot.editedAt || '',
          shot.controls?.at || '', shot.controls?.manifest || '', (shot.generationHistory || []).at(-1)?.at || ''
        ].join('|');
        const reviewBtn = h('button', {
          class: `shot-edit-btn ${reviewCurrent && shot.review.status === 'approved' ? 'ok' : ''}`,
          title: reviewCurrent
            ? `${shot.review.reviewer}：${shot.review.status === 'approved' ? '已通过' : shot.review.status === 'rejected' ? '已退回' : '待审'}${shot.review.note ? ` · ${shot.review.note}` : ''}`
            : shot.review ? '镜头已返工，上一版审批自动失效，请重新审核' : '给当前图片/视频版本签字',
          onclick: async () => {
            const note = prompt('审片意见（通过可留空；需要返工时请写清楚）', reviewCurrent ? shot.review.note || '' : '') ?? null;
            if (note === null) return;
            const status = note.trim() ? (confirm('这条意见是“退回返工”吗？\n确定 = 退回，取消 = 带意见通过') ? 'rejected' : 'approved') : 'approved';
            try {
              const r = await api(`/projects/${project.id}/shots/${shot.id}/review`, { method: 'POST', body: { status, note } });
              project = r.project;
              toast(status === 'approved' ? `第 ${shot.index} 镜已通过` : `第 ${shot.index} 镜已退回`, status === 'approved' ? 'ok' : 'err');
              paintShots();
            } catch (err) { toast(err.message, 'err'); }
          }
        }, reviewCurrent
          ? (shot.review.status === 'approved' ? '✓ 已审' : shot.review.status === 'rejected' ? '↩ 退回' : '待审')
          : (shot.review ? '审批已过期' : '审片'));

        // 厂商的时长档位：设 4 秒而模型只出 5/10 秒时，得在这儿就说清楚
        const steps = state.catalog.videoDurations || [];
        const aligned = steps.find((x) => x >= shot.duration) || steps.at(-1);

        // ── 手改这一镜的文案 ──
        // 分镜描述是这一镜出图、出视频的**唯一输入**。模型拆分镜时写偏一句
        //（把"雨夜"写成"清晨"、把"特写"写成"全景"），后面每次重出都是在错的基础上重来。
        // 所以描述本身就是可点的：点一下直接改，比"发现不对 → 重跑整个分镜"快得多，也不会把别的镜头一起冲掉。
        const editor = h('div', { class: 'shot-edit', style: 'display:none' });
        const pickedSkills = [...(shot.skills || [])];
        const pickedVariants = { ...(shot.variants || {}) };
        const descEl = h('div', {
          class: 'shot-desc editable',
          title: '点一下改这一镜的描述'
        }, shot.description || '（无描述）');

        /**
         * 预演台：把这一镜的机位从一句话变成一组数。
         *
         * 默认**折叠**。不是每一镜都值得排位 —— 空镜、过渡镜写句"全景"就够了。
         * 值得排的是对话戏和动作接续：那两种地方越轴和景别跳最要命，
         * 而它们恰恰是逐镜看都没问题、连起来才露馅的那类。
         *
         * 排过位之后，提示词里的机位那句由几何算出来（previz.cameraLine），
         * 上面那个 camera 文本框只在没排位时兜底 —— 两个都留着是有意的。
         */
        let stageDraft = shot.stage || null;
        const previzHost = h('details', { class: 'shot-previz' },
          h('summary', {}, stageDraft ? '预演台 · 已排位（点开调整）' : '预演台 · 排一下机位（可选）'));
        previzHost.addEventListener('toggle', () => {
          if (!previzHost.open || previzHost.dataset.built) return;
          previzHost.dataset.built = '1';
          if (!stageDraft) {
            const names = String(shot.characters || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
            /**
             * 接着上一镜排，不是从零开始。
             *
             * 同一场戏里人不会在两镜之间瞬移 —— 每镜重摆一遍不只是重复劳动，
             * 更坏的是**轴线会跟着变**：人的位置一变，两人之间那条线就转了，
             * 越轴检查跟着乱报，而乱报的检查比没有检查更糟。
             * 跨场次不继承 —— 那是另一个地方、另一段时间。
             */
            const sameSeg = prevShot && Number(prevShot.segment || 1) === Number(shot.segment || 1);
            // ⚠ 第三个参数是**这一镜的道具清单**：地标整场继承，道具按清单筛。
            // 不传的话，上一镜摆过的刀会一路跟到最后一镜，提示词里也一直说它在画面上
            stageDraft = (sameSeg && inheritStage(prevShot.stage, names, shot.props || []))
              || blankStage(names);
          }
          // 上一镜的排位拿来比对轴线 —— 越轴是**两镜之间**的事，单看一镜看不出来
          const panel = previzPanel(stageDraft, {
            prevStage: prevShot?.stage || null,
            duration: shot.duration || 5,
            assets: [
              ...[
                ['character', project.bible?.characters || []],
                ['scene', project.bible?.scenes || []],
                ['prop', project.bible?.props || []]
              ].flatMap(([kind, list]) => list.map((x) => {
                const wanted = shot.variants?.[x.name];
                const variant = (x.variants || []).find((v) => v.id === wanted) || x.variants?.[0] || x;
                const sheetPath = variant.sheetPath || x.sheetPath;
                return {
                  kind, name: x.name, ref: x.id || x.name, variantId: variant.id || 'default',
                  image: sheetPath ? mediaUrl(sheetPath) : '',
                  textureLayout: kind === 'character' ? 'quad-character' : 'single',
                  modelUrl: variant.modelPath ? mediaUrl(variant.modelPath) : x.modelPath ? mediaUrl(x.modelPath) : ''
                };
              }))
            ],
            onExportControls: async (stage, capture = {}) => {
              const r = await api(`/projects/${project.id}/shots/${shot.id}/controls`, {
                method: 'POST', body: {
                  stage,
                  renderedFrame: capture.renderedFrame || '',
                  renderedSequence: capture.renderedSequence || []
                }
              });
              const referenceCheck = await api(`/projects/${project.id}/shots/${shot.id}/controls/reference`, {
                method: 'POST', body: {}
              });
              const v = Date.now();
              return {
                previews: Object.fromEntries(['rendered', 'start', 'end', 'depth', 'pose', 'edge', 'mask']
                  .filter((key) => r.controls[key]).map((key) => [key, `${mediaUrl(r.controls[key])}&v=${v}`])),
                frameCount: r.controls.sequence?.length || 0,
                renderedFrameCount: r.controls.renderedSequence?.length || 0,
                referenceAccess: referenceCheck.reference?.access || null,
                referenceNotes: (referenceCheck.events || []).map((event) => event.message).filter(Boolean),
                controlFps: r.controls.controlFps || 0,
                issues: r.controls.issues || [],
                manifest: r.controls.manifest ? `${mediaUrl(r.controls.manifest)}&v=${v}` : ''
              };
            },
            // 同一个场景往往会反复回来（第 3 镜在码头、第 11 镜又回码头）——
            // 逐镜继承在中间隔了一场之后就断了，所以布局要能挂到场景上
            scene: shot.scene || '',
            sceneLayout: (project.bible?.scenes || []).find((x) => x.name === shot.scene)?.layout || null,
            onSaveScene: async (layout) => {
              try {
                // cap:scene-layout
                const p2 = await api(`/projects/${project.id}/scene-layout`, {
                  method: 'POST',
                  body: { scene: shot.scene, stage: { ...stageDraft, ...layout } }
                });
                project.bible = p2.bible;
                toast(`已存成「${shot.scene}」的默认布局 —— 用到这个场景的镜头都从它起步`, 'ok');
              } catch (err) {
                toast(err.message, 'err');
              }
            },
            onChange: () => { /* 拖动时只更新读数，存盘等你点保存 */ },
            /**
             * 设定集里的道具。摆上去之后，提示词里会多一句「柴刀在画面右」——
             * 和门窗桌椅走同一套数学，只是它跟着这一镜的关键道具清单走。
             */
            bibleProps: (project.bible?.props || []).map((x) => x.name)
          });

          previzHost.append(
            h('div', { class: 'shot-edit-tip' },
              '拖大圆点摆人，拖小圆点转身，拖「机」摆机位。两个人之间那条线就是轴线 —— '
              + '机位跨过去，成片上两人就左右对调了。排完点下面的保存。'),
            panel.node
          );
        });

        const fields = {
          description: h('textarea', { rows: 3 }, shot.description || ''),
          camera: h('input', { type: 'text', placeholder: '中景 / 特写 / 航拍…', value: shot.camera || '' }),
          motion: h('input', { type: 'text', placeholder: '镜头缓慢推进…', value: shot.motion || '' }),
          // 这一镜走哪一档视频模型。自动判定给一个，判错的那几镜由人改
          tier: h('select', {},
            h('option', { value: '', selected: !shot.tier }, '自动判定'),
            h('option', { value: 'high', selected: shot.tier === 'high' }, '关键镜（用最好的）'),
            h('option', { value: 'normal', selected: shot.tier === 'normal' }, '一般叙事镜'),
            h('option', { value: 'low', selected: shot.tier === 'low' }, '空镜 / 远景（用便宜的）')),
          scene: h('input', { type: 'text', placeholder: '场景名（要和设定集里的一致）', value: shot.scene || '' }),
          characters: h('input', {
            type: 'text', placeholder: '出场角色，逗号分隔', value: (shot.characters || []).join('、')
          }),
          /**
           * 这一镜画面里**看得见**的关键道具。
           *
           * 它撑着"道具消失又回来"那条检查。⚠ 只填真的在画面里的：
           * 特写里看不见的东西填上去，那条检查就会开始乱报，
           * 而乱报的检查比没有检查更糟。
           */
          // cap:shot-props
          props: h('input', {
            type: 'text', placeholder: '画面里看得见的道具，逗号分隔', value: (shot.props || []).join('、')
          }),
          dialogue: h('input', { type: 'text', placeholder: '这一镜的台词（没有就留空）', value: shot.dialogue || '' }),
          // 听得见、看不见的东西。**不进出图提示词** —— 这正是它单独一栏的理由：
          // "敲门声"写在画面描述里，出图模型画不出声音，就会去画一扇开着的门
          sound: h('input', {
            type: 'text', placeholder: '敲门声、脚步声、远处汽笛…（不会画进画面）', value: shot.sound || ''
          }),
          /**
           * 这一镜属于哪个场次。
           *
           * 放开给人改，是因为**边界划错的代价很具体**：划漏了，跨着二十年的
           * 两镜会去锁末帧；划多了，同一场戏被切断，动作接不上。
           * 而模型划边界是靠读剧本猜的，猜错很正常。
           */
          segment: h('input', {
            type: 'number', min: 1, max: 99, style: 'width:70px',
            value: String(shot.segment || 1)
          }),
          // 怎么进入这一镜。绝大多数时候该是硬切 —— 满屏叠化是最典型的业余做法
          transition: h('select', {},
            h('option', { value: 'cut', selected: (shot.transition || 'cut') === 'cut' }, '硬切（默认）'),
            h('option', { value: 'fade', selected: shot.transition === 'fade' }, '黑场（换时间换地点）'),
            h('option', { value: 'dissolve', selected: shot.transition === 'dissolve' }, '叠化（时间流逝，吃 0.5 秒）')),
          // 谁说的 —— 决定用哪个角色的音色。留空 = 旁白
          speaker: h('select', {},
            h('option', { value: '', selected: !shot.speaker }, '旁白'),
            (project.bible?.characters || []).map((c) =>
              h('option', { value: c.name, selected: c.name === shot.speaker },
                `${c.name}${c.voice ? `（${c.voice}）` : ''}`))),
          /**
           * 台词类型。和「谁说的」是两件事，摆在一起才不会被当成同一个选择：
           *   谁说的   = 用谁的**声音**
           *   台词类型 = 嘴动不动、声音从哪儿来
           *
           * 漏掉它的时候「心里话」根本没法表达：填了说话人，画面就被要求
           * 口型对上台词（成了自言自语）；留空当旁白，声音又换成了旁白音色。
           */
          lineKind: h('select', {},
            (state.catalog.lineKinds || []).map((k) =>
              h('option', {
                value: k.id,
                title: k.hint,
                selected: k.id === (shot.lineKind || (shot.speaker ? 'speech' : 'voiceover'))
              }, k.label))),
          // 和上一镜什么关系。它决定这一镜出视频时要不要把上一镜的末帧锁住 ——
          // 三种关系各有各的代价，见下面那行说明
          link: h('select', {},
            (state.catalog.links || []).map((l) =>
              h('option', { value: l.id, selected: l.id === link, title: l.hint }, l.label)))
        };

        const saveEdit = h('button', {
          class: 'btn sm primary',
          onclick: async () => {
            saveEdit.disabled = true;
            try {
              // cap:shot-text cap:shot-dialogue cap:shot-camera
              const r = await api(`/projects/${project.id}/shots/${shot.id}`, {
                method: 'PATCH',
                body: {
                  description: fields.description.value,
                  camera: fields.camera.value,
                  motion: fields.motion.value,
                  // cap:tier-routing
                  tier: fields.tier.value,
                  scene: fields.scene.value,
                  characters: fields.characters.value,
                  props: fields.props.value,
                  dialogue: fields.dialogue.value,
                  // cap:shot-sound
                  sound: fields.sound.value,
                  // cap:shot-transition
                  transition: fields.transition.value,
                  // cap:shot-segment
                  segment: Number(fields.segment.value) || 1,
                  link: fields.link.value,
                  skills: pickedSkills,
                  variants: pickedVariants,
                  speaker: fields.speaker.value,
                  // cap:line-kind
                  lineKind: fields.lineKind.value,
                  // cap:shot-stage
                  ...(stageDraft ? { stage: stageDraft } : {})
                }
              });
              project = r.project;
              // 互斥组会在服务端被规整掉，如实说一声，别让人以为界面吞了他的选择
              for (const d of r.dropped || []) toast(`${d.why}，已忽略一项`, 'err');
              if (!r.changed?.length) {
                toast('没有改动', 'ok');
              } else {
                // 说清楚"存了但还没重出"—— 不自动重出是有意的：
                // 一般人会连着改好几镜再统一重出，改一个字就烧一次钱不是好事。
                toast(`第 ${shot.index} 镜已改。下次重出这一镜才会按新描述生成`, 'ok');
              }
              // 只换这一张卡：整页重画会把别处正在编辑的输入框一起冲掉
              const entry = shotCards.get(shot.id);
              if (entry) entry.editing = false;
              await refreshShot(shot.id);
            } catch (e) {
              toast(e.message, 'err');
              saveEdit.disabled = false;
            }
          }
        }, '保存文案');

        const mark = (editing) => {
          const entry = shotCards.get(shot.id);
          if (!entry) return;
          entry.editing = editing;
          // 编辑期间攒下的更新，等收工再补上 —— 否则打了一半的字会被生成结果冲掉
          if (!editing && entry.pending) {
            entry.pending = false;
            refreshShot(shot.id);
          }
        };
        const closeEdit = () => {
          editor.style.display = 'none';
          descEl.style.display = '';
          mark(false);
        };
        /** 「为什么不对」的结果挂这儿。默认空的 —— 不点就不占地方 */
        const diagHost = h('div', { class: 'diag-host' });

        const openEdit = () => {
          editor.style.display = '';
          descEl.style.display = 'none';
          fields.description.focus();
          mark(true);
        };
        descEl.onclick = openEdit;

        /**

         * 从表格里按回车过来的那一镜，落地就展开编辑器。
         *
         * ⚠ 标记要**当场清掉**。不清的话，下一次任何原因的重画都会再展开一次 ——
         * 人正在别处看，编辑器自己弹开，而且看不出是谁干的。
         */
        if (state.openShotId === shot.id) {
          state.openShotId = null;
          queueMicrotask(() => { openEdit(); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
        }

        /**

         * ════════ 按**下游**分组 ════════
         *
         * 用户问的是"标连续动作、选技法、绑说话人到底该出现在哪一步"。
         * 答案不是"分镜之前还是之后"，而是：**每一样属于它喂的那一步**。
         *
         *   技法卡     → 出图。改了图要重出（视频跟着图走，也得跟着重出）
         *   连续动作   → 出视频。改了只要重出视频，图不受影响
         *   谁说的     → 配音。改了只要重配音，图和视频都不受影响
         *
         * 原来这些平铺成一长条，四个步骤里长得一模一样 —— 看不出谁管谁，
         * 也看不出改一样东西要付多少代价（重出图和重配音，差着几十倍的钱）。
         *
         * 每一组下面那句「改了要重出 X」**只在那样产物已经出过时**才显示：
         * 还没出过的时候它是废话，而废话会把真正要紧的那句挤没。
         */
        const group = (title, note, done, redo, ...kids) => h('div', { class: 'shot-group' },
          h('div', { class: 'shot-group-head' },
            h('b', {}, title),
            h('span', {}, note)),
          ...kids.filter(Boolean),
          done ? h('div', { class: 'shot-group-redo' }, redo) : null);

        // 用 add 而不是 editor.append：原生 append 不会摊平数组，也不会跳过 null ——
        // 直接 append 的话，"和上一镜的关系"那一组会被转成字符串印在界面上，
        // 第一镜（没有上一镜）还会真的显示一个 "null"。
        add(editor,
          group('出图用的', '改这些要重出图', shot.imagePath,
            '⚠ 这一镜已经出过图了。改完要**重出这一镜的图**才生效 —— '
            + '而视频是跟着图走的，所以视频也得跟着重出。',
            h('label', {}, '画面描述'),
            fields.description,
            h('div', { class: 'shot-edit-grid' },
              h('div', {}, h('label', {}, '景别'), fields.camera),
              h('div', {}, h('label', {}, '场景'), fields.scene),
              h('div', {}, h('label', {}, '出场角色'), fields.characters),
              h('div', {}, h('label', {}, '画面里的道具'), fields.props)),
            h('div', { class: 'field-hint' },
              '道具只填**这一镜真的看得见**的。特写里看不见的东西填上去，'
              + '「道具消失又回来」那条检查会开始乱报 —— 而乱报的检查比没有更糟。'),
            h('div', { class: 'shot-edit-tip' },
              '只写画面，别写外貌 —— 长相由设定集定，写在这儿反而会和设定集打架。'),
          // ── 这一镜谁穿哪套、场景是什么时段 ──
          // 只在真的有多版时才摆出来：大多数条目只有一版，摆一排"默认"是纯噪音
          (() => {
            const bible = project.bible;
            if (!bible) return null;
            const pool = [
              ...(bible.characters || []).filter((c) => (shot.characters || []).includes(c.name)),
              ...(bible.scenes || []).filter((sc) => sameScene(sc.name, shot.scene))
            ].filter((x) => (x.variants || []).length > 1);
            if (!pool.length) return null;
            return [
              h('label', { style: 'margin-top:8px' }, '这一镜用哪一版'),
              h('div', { class: 'shot-edit-grid' },
                pool.map((x) =>
                  h('div', {},
                    h('label', {}, x.name),
                    (() => {
                      const sel = h('select', {},
                        (x.variants || []).map((v) =>
                          h('option', {
                            value: v.id,
                            selected: (shot.variants?.[x.name] || x.variants[0].id) === v.id,
                            title: v.appearance || ''
                          }, v.sheetPath ? v.name : `${v.name}（还没出图）`)));
                      pickedVariants[x.name] = shot.variants?.[x.name] || x.variants[0].id;
                      sel.addEventListener('change', () => (pickedVariants[x.name] = sel.value));
                      return sel;
                    })()))),
              h('div', { class: 'shot-edit-tip' },
                '换的只是这一版的描述和参考图，脸和身份锚不变 —— 所以还是同一个人、同一个地方。')
            ];
          })(),
          // ── 技法 ──
          // 模型拆出来的 motion 大多是"镜头缓慢推进"这种放之四海皆准的话，
          // 真正让画面有电影感的是具体手法。术语你未必天天记得住，模型却认得很准。
          skillGroups.length
            ? [
                h('label', { style: 'margin-top:8px' }, '技法'),
                (() => {
                  const host = h('div', {});
                  host.append(skillPicker(skillGroups, pickedSkills, () => {}));
                  return host;
                })(),
                h('div', { class: 'shot-edit-tip' },
                  '选完点「保存文案」才生效。运镜类只作用于视频，出图那一步不会有变化。'),
                h('div', { class: 'inline', style: 'margin-top:6px' },
                  h('button', {
                    class: 'btn ghost sm',
                    title: '同一场戏的镜头往往用同一套手法，一个个点太慢',
                    onclick: async () => {
                      const targets = ordered.filter((x) => x.id !== shot.id && sameScene(x.scene, shot.scene));
                      if (!targets.length) return toast('同场景没有别的镜头', 'err');
                      if (!confirm(`把这 ${pickedSkills.length} 个技法套到同场景的另外 ${targets.length} 个镜头上？会覆盖它们已选的技法。`)) return;
                      for (const t of targets) {
                        await api(`/projects/${project.id}/shots/${t.id}`, {
                          method: 'PATCH', body: { skills: pickedSkills }
                        });
                      }
                      project = await api(`/projects/${project.id}`);
                      toast(`已套用到 ${targets.length} 个同场景镜头`, 'ok');
                      paintShots();
                    }
                  }, '套用到同场景的其它镜'),
                  customSkillForm(skillGroups, (groups) => {
                    skillGroups = groups;
                    paintShots();
                  }))
              ]
            : null,
            previzHost),

          group('出视频用的', '改这些只要重出视频，图不用动', shot.videoPath,
            '⚠ 这一镜已经出过视频了。改完要**重出视频**才生效。图不受影响，不用重出。',
          prevShot
            ? [
                h('label', { style: 'margin-top:8px' }, `和上一镜（SH ${String(prevShot.index).padStart(3, '0')}）的关系`),
                fields.link,
                // 说清楚代价：选「连续动作」要重出的是**上一镜**，不是这一镜 ——
                // 末帧锁在上一镜身上，改完只重出这一镜是白重
                h('div', { class: 'shot-edit-tip' },
                  '「连续动作」会把这一镜的图锁成上一镜的末帧，两镜之间无缝；' +
                  `改成它之后要重出的是 SH ${String(prevShot.index).padStart(3, '0')}，不是这一镜。` +
                  '同场景换机位保持默认就好 —— 每一镜都接上的话，整部片子会变成一个没剪过的长镜头。')
              ]
            : null,
            h('div', { class: 'shot-edit-grid' },
              h('div', {}, h('label', {}, '运镜'), fields.motion),
              h('div', {}, h('label', {}, '时长'), fields.duration),
              h('div', {}, h('label', {}, '模型档位'), fields.tier),
              h('div', {}, h('label', {}, '第几场'), fields.segment)),
            h('div', { class: 'hint' },
              '场次 = 同一时间同一地点的一段戏。跨场次不能锁末帧、不能拿邻镜当参考图，'
              + '转场也只该出现在场次之间 —— 划错了这几件事都会做在错的地方。')),

          group('配音用的', '改这些只要重配音，图和视频都不用动', shot.audioPath,
            '⚠ 这一镜已经配过音了。改完要**重新配音**才生效。图和视频都不受影响。',
            h('label', {}, '台词'),
            fields.dialogue,
            h('div', { class: 'shot-edit-grid' },
              h('div', {}, h('label', {}, '谁说的'), fields.speaker),
              h('div', {}, h('label', {}, '台词类型'), fields.lineKind)),
            h('label', {}, '画外音效'),
            fields.sound,
            h('div', { class: 'hint' },
              '听得见但看不见的东西写这里。写进"画面描述"的话，出图模型画不出声音，'
              + '会去画那个声音最像的东西 ——「敲门声」最常见的下场是画出一扇**开着的门**。')),

          group('合成用的', '改这个不重新生成任何素材，也就不花钱', Boolean(project.outputs?.video),
            '改完点「重新合成」就生效 —— 它只是重新拼一遍，不花钱。',
            h('div', { class: 'shot-edit-grid' },
              h('div', {}, h('label', {}, '转场'), fields.transition))),

          h('div', { class: 'inline', style: 'margin-top:8px' },
            saveEdit,
            h('button', { class: 'btn ghost sm', onclick: closeEdit }, '取消'))
        );

        const liveEl = h('div', { class: 'shot-live', style: 'display:none' });
        liveEls.set(shot.id, liveEl);
        const cached = live.get(shot.id);
        if (cached) {
          liveEl.style.display = '';
          liveEl.className = `shot-live ${cached.status}`;
          liveEl.textContent = cached.message || '';
        }

        const card =
          h('article', {
            class: `shot-card ${flagged ? 'flagged' : ''} ${failed ? 'failed' : ''}`,
            // 开跑前清单里的「第 7 镜」按钮靠它跳过来。没有这个属性的话，
            // 那颗按钮点了**什么都不会发生**，而且不报错
            'data-shot-index': String(shot.index)
          },
            h('div', { class: 'shot-thumb' }, thumb, liveEl),
            h('div', { class: 'shot-body' },
              h('div', { class: 'shot-head' },
                h('span', { class: 'shot-no' }, `SH ${String(shot.index).padStart(3, '0')}`),
                h('span', { class: 'shot-no', title: shot.actualDuration && shot.actualDuration !== shot.duration
                  ? `计划 ${shot.duration}s，模型实出 ${shot.actualDuration}s`
                  : '计划时长' },
                  `${Number(shot.duration).toFixed(1)}s`,
                  shot.actualDuration && shot.actualDuration !== shot.duration
                    ? h('span', { style: 'color:var(--caution)' }, ` →${shot.actualDuration}s`)
                    : null),
                // 光靠"描述可点"没人发现得了，摆个明确的入口
                h('button', { class: 'shot-edit-btn', title: '改这一镜的描述、景别、台词', onclick: openEdit }, '改文案'),
                // 和「改文案」并排。藏在编辑面板底部时用户根本找不到它
                stageBtn,

                /**
                 * ══════════ 「为什么不对」 ══════════
                 *
                 * ⚠ 出图之后才有意义，所以只在有图时摆出来。
                 *
                 * 不满意的时候，人手里只有一张图和一个「重出」按钮 ——
                 * 而再来一次多半还是那样，因为他不知道该改什么。
                 * 这颗按钮回答的就是那个问题，而且只说**数据里有证据**的原因。
                 */
                shot.imagePath
                  ? h('button', {
                      class: 'shot-edit-btn',
                      title: '这一镜不满意？看看数据里查得出什么原因',
                      onclick: async (e) => {
                        const btn = e.currentTarget;
                        btn.disabled = true;
                        try {
                          // cap:diagnose-shot
                          const r = await api(`/projects/${project.id}/shots/${shot.id}/diagnose`);
                          clear(diagHost);
                          add(diagHost, ...(r.items || []).map((it) => h('div', { class: 'diag-item' },
                            h('div', { class: 'diag-what' }, it.what),
                            h('div', { class: 'diag-why' }, it.why),
                            h('div', { class: 'diag-how' }, `→ ${it.how}`),
                            // 花不花钱要写在动作旁边，不能只写在别处
                            it.costs ? h('span', { class: 'diag-cost' }, '这一下要重新出图（花钱）') : null)));
                        } catch (err) {
                          clear(diagHost);
                          add(diagHost, h('div', { class: 'diag-item' }, err.message));
                        } finally { btn.disabled = false; }
                      }
                    }, '为什么不对')
                  : null,
                verBtn,
                manifestBtn,
                reviewBtn

              ),
              diagHost,
              descEl,
              editor,
              h('div', { class: 'shot-meta' },
                shot.camera ? h('span', { class: 'badge' }, shot.camera) : null,
                shot.scene ? h('span', { class: 'badge' }, shot.scene) : null,
                ...(shot.characters || []).map((n) => h('span', { class: 'badge beam' }, n)),
                c?.score !== null && c?.score !== undefined
                  ? h('span', {
                      class: `badge ${c.stale ? 'warn' : c.pass ? 'ok' : 'warn'}`,
                      // 描述被手改过之后，这个分数是对**旧描述**打的 —— 说一声，别让它冒充现在的结论
                      title: c.stale
                        ? '这个分数是改文案之前打的，重出这一镜后才会重新复核'
                        : (c.issues || []).join('；') || '一致性复核通过'
                    }, `一致性 ${c.score}${c.stale ? '（已过时）' : ''}`)
                  : null,
                // 手改过的镜头值得标一下：出来的图和自动拆的分镜对不上时，先想到的就该是"我改过它"
                shot.editedAt ? h('span', { class: 'badge' }, '文案已手改') : null,
                reviewCurrent && shot.review.status === 'approved' ? h('span', { class: 'badge ok' }, '当前版已审') : null,
                reviewCurrent && shot.review.status === 'rejected' ? h('span', { class: 'badge warn' }, '当前版退回') : null,
                !reviewCurrent && shot.review ? h('span', { class: 'badge warn' }, '审批已过期') : null,
                // 模型挑技法时给的理由：要判断的是"它为什么这么挑"，不是盯着一串 id 猜
                shot.skillWhy ? h('span', { class: 'badge', title: shot.skillWhy }, '技法由模型挑') : null,
                // 用了非默认的那一版要看得见：出来的图"衣服不对"时，先看这里
                ...Object.entries(shot.variants || {}).map(([who, vid]) => {
                  const item = [
                    ...(project.bible?.characters || []),
                    ...(project.bible?.scenes || []),
                    ...(project.bible?.props || [])
                  ].find((x) => x.name === who);
                  const v = (item?.variants || []).find((x) => x.id === vid);
                  return v && v.id !== 'v-default'
                    ? h('span', { class: 'badge', title: v.appearance || '' }, `${who}·${v.name}`)
                    : null;
                }),
                // 用了哪些技法要看得见 —— 出来的画面不对时，这是最先要排查的一项
                ...(shot.skills || []).map((id) => {
                  const card = skillGroups.flatMap((g) => g.skills || []).find((x) => x.id === id);
                  return card
                    ? h('span', { class: 'badge beam', title: card.fragment }, card.name)
                    : null;
                }),
                // 衔接：在出视频那一步才有意义，出图那步摆着只是噪音
                sc.video && prevShot
                  ? h('span', {
                      class: `badge ${link === 'continuous' ? 'beam' : ''}`,
                      title: (state.catalog.links || []).find((l) => l.id === link)?.hint || ''
                    }, `接 ${(state.catalog.links || []).find((l) => l.id === link)?.label || link}`)
                  : null,
                // 标了"连续动作"但末帧其实没锁上（换了家不收末帧的），必须说出来 ——
                // 否则用户会一直以为这两镜是无缝的，直到把成片放出来
                sc.video && shot.videoPath && shot.link === 'continuous' && shot.endFrameChained === false
                  ? h('span', { class: 'badge warn', title: '这一家不收末帧图，这段是按普通图生视频出的，和下一镜之间是硬切' }, '末帧没锁上')
                  : null,
                // 首帧核对：厂商到底有没有吃我们给的那张分镜图。
                // 对上了不用喊（那是应该的），对不上必须喊 —— 那意味着这一段
                // 从第一帧起就和分镜没关系了，再怎么调提示词都白搭
                sc.video && shot.headMatch?.verdict === 'mismatch'
                  ? h('span', {
                      class: 'badge warn',
                      title:
                        `视频第一帧和这一镜的图只有 ${shot.headMatch.similarity}% 像。` +
                        '这家多半没吃我们给的首帧图（提示词和图打架时自己重画了，或者退化成了文生视频）。' +
                        '换一家，或者把提示词里和画面冲突的话去掉再重出。'
                    }, '首帧没吃')
                  : null,
                /**
                 * 音效跟不跟得上改动。
                 *
                 * 改了「画外音效」那一栏之后，旧的那声还在成片里 ——
                 * 你以为改了，实际上没重出。这类"改了没生效"必须看得见，
                 * 否则只会在放成片时才发现，而那时候已经合成过一遍了。
                 */
                shot.sfxPath
                  ? h('span', {
                      class: `badge ${shot.sfxOf === shot.sound ? 'ok' : 'warn'}`,
                      title: shot.sfxOf === shot.sound
                        ? `画外音效：${shot.sound}（合成时压在台词底下）`
                        : `音效是按「${shot.sfxOf}」出的，而现在写的是「${shot.sound}」—— 重跑配音那一步才会换`
                    }, shot.sfxOf === shot.sound ? '有音效' : '音效已过时')
                  : shot.sound
                    ? h('span', { class: 'badge', title: `还没出：${shot.sound}` }, '待出音效')
                    : null,
                // 末帧复核：视频的人设漂移几乎都在后半段，首帧永远是像的
                shot.videoConsistency
                  ? h('span', {
                      class: `badge ${shot.videoConsistency.pass ? 'ok' : 'warn'}`,
                      title: shot.videoConsistency.pass
                        ? `末帧复核通过（${shot.videoConsistency.character}）`
                        : `末帧和设定图对不上：${(shot.videoConsistency.issues || []).join('；') || '未说明'}`
                    }, `末帧 ${shot.videoConsistency.score}`)
                  : null,
                c?.attempts > 1 ? h('span', { class: 'badge warn' }, `重试 ${c.attempts - 1}`) : null,
                flagged ? h('span', { class: 'badge warn' }, '待人工确认') : null,
                // 描述改了、图还是改之前那张。这时候去出视频，首帧是旧画面、
                // 提示词是新描述，两边打架 —— 而模型多半跟着图走，于是"改了等于没改"。
                // 这条必须摆在卡片上，不能藏在折叠面板里
                // 出来的图比例不对：这个错会顺着首帧图传到视频，再传到成片。
                // 越早看见越好 —— 发现得晚等于整条流水线白跑
                // 这一镜是用另一个模型出的：画风会和其余镜头对不上，
                // 而这件事不报任何错，只是"从某一镜开始变了"
                shot.modelUsed && state.catalog?.routing?.image
                  && shot.modelUsed !== `${state.catalog.routing.image.provider} / ${state.catalog.routing.image.model}`
                  ? h('span', {
                      class: 'badge warn',
                      title: `这一镜是 ${shot.modelUsed} 出的，当前路由是 ${state.catalog.routing.image.provider} / ${state.catalog.routing.image.model}。不同模型画风对不上，要统一就用同一个模型重出`
                    }, '另一个模型出的')
                  : null,
                shot.imageSize && shot.imageSize.ok === false
                  ? h('span', {
                      class: 'badge warn',
                      title:
                        `这张图是 ${shot.imageSize.width}×${shot.imageSize.height}，和项目画幅 ${shot.imageSize.wanted} 对不上。` +
                        (shot.imageSize.asked ? `我们发出去的是 ${String(shot.imageSize.asked).replace('*', '×')} —— 说明这一家没按我们给的尺寸出。` : '') +
                        '图生视频会继承首帧图的比例，不换一家重出的话成片也是这个比例。'
                    }, `比例不符 ${shot.imageSize.width}×${shot.imageSize.height}`)
                  : null,
                shot.imagePath && shot.editedAt && (!shot.imageAt || Date.parse(shot.editedAt) > Date.parse(shot.imageAt))
                  ? h('span', {
                      class: 'badge warn',
                      title: '描述改过了，但这张图是改之前出的。直接出视频的话，首帧是旧画面、提示词是新描述，模型多半跟着图走 —— 先重出这一镜的图'
                    }, '图比描述旧')
                  : null,
                shot.videoPath ? h('span', { class: 'badge ok' }, '视频已出') : shot.imagePath ? h('span', { class: 'badge' }, '待出视频') : null
              ),
              shot.dialogue
                ? h('div', { class: 'shot-desc', style: 'color:var(--ink-faint)' },
                    `${shot.speaker || '旁白'}：「${shot.dialogue}」${shot.speakerBy && shot.speakerBy !== 'manual' ? `（${SPEAKER_BY[shot.speakerBy] || shot.speakerBy}）` : ''}`)
                : null,
              // 单镜重出：批量出图总有零星失败或不满意的，为几张图重跑整个阶段既慢又要重烧。
              // 只摆当前这一步用得上的参数 —— 在出图那步看到"秒"和视频模型，
              // 只会让人以为得先把它们配好。
              h('details', { class: 'shot-redo' },
                h('summary', {}, sc.video ? '单独重出这一镜的视频' : sc.image ? '单独重出这一镜的图' : '单独重出'),
                h('div', { class: 'shot-redo-body' },
                  sc.duration
                    ? [
                        h('label', {}, '本镜时长（秒）'),
                        (() => {
                          const durInput = h('input', {
                            type: 'number', min: 1, max: 30, step: 0.5, value: shot.duration,
                            style: 'font-size:11px;padding:4px 6px',
                            onchange: async () => {
                              const next = project.shots.map((x) =>
                                x.id === shot.id ? { ...x, duration: Number(durInput.value) || x.duration } : x);
                              await api(`/projects/${project.id}`, { method: 'PATCH', body: { shots: next } });
                              project = await api(`/projects/${project.id}`);
                              await paintDuration();
                              toast(`第 ${shot.index} 镜改为 ${durInput.value} 秒`, 'ok');
                            }
                          });
                          return durInput;
                        })(),
                        // 档位对不上时当场说明，别让用户跑完才发现"我设的不是这个数"
                        steps.length && aligned && aligned !== shot.duration
                          ? h('div', { class: 'shot-used' },
                              `模型只出 ${steps.join('/')} 秒，这一镜会按 ${aligned} 秒生成，合成时再裁回 ${shot.duration} 秒`)
                          : null
                      ]
                    : null,
                  sc.image ? h('label', { style: 'margin-top:10px' }, '出图用') : null,
                  sc.image ? imgPicker.el : null,
                  sc.image ? imgBtn : null,
                  sc.video ? h('label', { style: 'margin-top:10px' }, '出视频用') : null,
                  sc.video ? vidPicker.el : null,
                  sc.video ? vidBtn : null,
                  // 单独重出同样吃设定集：把"带了哪几张参考图"摊开，
                  // 不然重出来还是不像的时候，根本不知道是提示词的问题还是压根没带参考图
                  h('div', { class: 'shot-used' },
                    '单独重出会自动带上本镜的设定集：场景基准图 + 出场角色设定图 + 点到的道具图'),

                  /**
                   * ⚠ **一张都没带的时候更要说**。
                   *
                   * 这一行原来只在带了参考图时显示，没带时一声不响 ——
                   * 而那恰恰是最需要知道的情况：用户传了自己的照片、
                   * 出来的脸不是他的，而界面上没有任何东西告诉他
                   * 那张照片根本没被用上。沉默在这里等于误导。
                   */
                  /**
                   * ══════════ 出处与排查：默认折起来 ══════════
                   *
                   * 下面这一整段（带了哪几张参考图、哪个模型出的、首帧核对、
                   * task_id、手动补入、提示词原文）是**排查时才翻**的东西。
                   *
                   * 它们每一条都是有理由才加上的，但加了十几条之后，
                   * 浏览五十镜时它们就是五十份噪音 —— 用户的原话是"太杂太乱"。
                   *
                   * ⚠ **折起来 ≠ 删掉。**一样都没少，点一下就有。
                   * 徽章（景别/场景/角色/一致性）留在外面 —— 那是"这一镜是什么"，
                   * 扫一眼就要看到的东西，不是排查用的。
                   */
                  /**
                   * ⚠ **一条内容都没有就整个不渲染。**
                   *
                   * 一个点开什么都没有的「出处与排查」，比多几行字更让人觉得
                   * 这界面不靠谱。
                   *
                   * ⚠ 老实说：这一行**目前够不到** —— promptPanel 总会回点东西，
                   * 所以 kids 从来不是空的。金丝雀把它删掉，走查照样全绿。
                   * 留着是因为它一行、且是对的；但别把它当成"验过了"。
                   * 真正在守这件事的是走查里那条**不变量**断言
                   *（"没有一个折叠区是点开就空的"）—— 它不管实现怎么变，
                   * 只要哪天真出现一个空折叠区就会红。
                   */
                  (() => {
                    const kids = [
                  // cap:shot-refs
                  sc.image
                    ? h('div', { class: 'shot-used' },
                        shot.bibleRefs?.length
                          ? `上次出图参考：${shot.bibleRefs.join('、')}`
                          : shot.refsAvailable > 0
                            ? `设定集里有 ${shot.refsAvailable} 张图可以带`
                              + (shot.refsAvailableLabels?.length ? `（${shot.refsAvailableLabels.join('、')}）` : '')
                              + '，但上次一张都没发。'
                              // 说清那几张是谁 —— 用户真正要判断的是"我传的那张在不在里面"
                              // 拦住它的开关有两个，隔着两个面板 —— 用出图时记下的那句，别猜
                              + (shot.refBlockedHint
                                ? `原因：${shot.refBlockedHint}。打开它再重出这一镜。`
                                : (shot.refsAvailableLabels || []).some((x) => x.includes('你传的'))
                                  // 卡片是**历史记录**：没盖新版的戳，就说明这条是更新之前
                                  // 写下的，它说什么都不作数。手机端同一处有更长的说明
                                  ? shot.refPolicy !== 'uploads-always'
                                    ? '⚠ 不过这条记录是程序更新之前留下的，已经不作数了 ——'
                                      + '新版里你传的照片不受任何开关管，一定会发。重出这一镜才反映现在的情况。'
                                    : '⚠ 这一镜是新版出的，你传的照片本该无条件发出去却没发 ——'
                                      + '这是程序的问题，不是设置的问题，改设置没有用。把完整请求记录发出来。'
                                  : '⚠ 这几张全是模型出的，没有你传的那张 —— 问题不在设置。'
                                    + '要么照片传到了别的条目上，要么这一镜引用的角色名和设定集里的对不上。')
                            : shot.refsAvailable === 0
                              ? '这一镜引用的角色/场景在设定集里还没有图 —— 没有图可带。先去给他出一张或传一张。'
                              : '这张图是早前出的，当时没记下带过哪些参考图。重出一次就知道了。')

                    : null,
                  sc.video && shot.videoRefs?.length
                    ? h('div', { class: 'shot-used' }, `上次出视频参考：${shot.videoRefs.join('、')}`)
                    : null,
                  sc.image && shot.modelUsed ? h('div', { class: 'shot-used' }, `出图用了 ${shot.modelUsed}`) : null,
                  sc.video && shot.videoModelUsed
                    ? h('div', { class: 'shot-used' },
                        `出视频用了 ${shot.videoModelUsed}${shot.videoResolution ? ` · ${shot.videoResolution}` : ''}`)
                    : null,
                  // 对上了也把数字摆出来：这是个免费指标，看得见才建立得起信任
                  sc.video && shot.headMatch
                    ? h('div', { class: 'shot-used' },
                        shot.headMatch.verdict === 'inconclusive'
                          ? '首帧核对：画面太平（大片纯色），比不出结论'
                          : `首帧核对：和这一镜的图 ${shot.headMatch.similarity}% 像` +
                            `（${shot.headMatch.ok ? '厂商吃了这张首帧' : '⚠ 多半没吃'}）`)
                    : null,
                  // 任务提交成功但查不到状态时，把 task_id 亮出来
                  sc.video && shot.pendingTask
                    ? h('div', { class: 'fail-box', style: 'margin-top:10px' },
                        h('div', { class: 'fail-head' }, '有一个任务查不到状态'),
                        h('div', { class: 'fail-row' },
                          h('span', { class: 'fail-who' }, 'task_id'),
                          h('span', { class: 'fail-msg mono' }, shot.pendingTask.taskId)),
                        h('div', { class: 'fail-tip' },
                          `提交是成功的（${shot.pendingTask.provider}），片子多半已经在平台上出好了。` +
                          '用上面的「重查待认领任务」再问一次，或者直接在下面贴地址补回来。'))
                    : null,
                  // 手动补入**常驻**，不以"有没有记下 task_id"为前提。
                  // 逃生口设成有条件的，等于在最需要它的时候没有它 ——
                  // 早期版本失败的镜头根本没记 task_id，于是界面上什么都不显示。
                  sc.image || sc.video
                    ? (() => {
                        const kind = sc.video ? 'video' : 'image';
                        const input = h('input', {
                          type: 'text', class: 'mono',
                          placeholder: kind === 'video' ? 'https://…/xxx.mp4' : 'https://…/xxx.png',
                          style: 'font-size:11px'
                        });
                        const btn = h('button', {
                          class: 'btn sm', style: 'margin-top:6px',
                          onclick: async () => {
                            const url = input.value.trim();
                            if (!url) return toast('先把地址粘进来', 'err');
                            btn.disabled = true;
                            try {
                              let err = null;
                              await stream(`/projects/${project.id}/shots/${shot.id}/attach`,
                                { url, kind }, (ev) => { if (ev.type === 'error') err = ev.message; });
                              if (err) throw new Error(err);
                              toast(`第 ${shot.index} 镜已补入`, 'ok');
                              jobNotify('done');
                            } catch (e) {
                              toast(e.message, 'err');
                            } finally {
                              btn.disabled = false;
                            }
                          }
                        }, kind === 'video' ? '补入这段视频' : '补入这张图');
                        return h('details', { class: 'shot-prompt', style: 'margin-top:10px' },
                          h('summary', {}, kind === 'video' ? '手动补入视频（贴地址）' : '手动补入图片（贴地址）'),
                          h('div', { class: 'shot-prompt-body' },
                            h('div', { style: 'margin-bottom:6px' },
                              '厂商那边已经出好、这边取不回来时用这个：去平台复制地址粘进来，' +
                              '这一镜就补齐了，不用重跑（省一次钱）。'),
                            input, btn));
                      })()
                    : null,
                  /**
                   * 发给模型的提示词。
                   *
                   * 这里原来显示的是 shot.videoPrompt —— **上一次实际发出去的那条**。
                   * 改完描述再来看，看到的还是旧文本，于是很自然会以为
                   * "我改了描述，提示词并没有跟着变"。其实每次出视频都是现算的，
                   * 只是没人把现算的结果给你看。所以这里改成点开时去问一次，
                   * 两条都摆出来：现在会发的、上次发过的。
                   */
                  promptPanel(project, shot, sc)
                    ].filter(Boolean);
                    return kids.length
                      ? h('details', { class: 'shot-more' }, h('summary', {}, '出处与排查'), ...kids)
                      : null;
                  })()
                )
              )
            )
          );
        shotCards.set(shot.id, { card, editing: false, pending: false });
        return card;
      }
    }

    /**
     * 选中的那几镜。**挂在闭包上，不挂在表格组件里** ——
     * 这个界面每跑完一镜就重画一次，选择放在组件里会跟着组件一起没。
     * 选了二十镜、跑完一镜、选择全丢，那是个能让人立刻放弃这个功能的 bug。
     */
    const picked = new Set();
    const skillNameOf = {};
    for (const g of skillGroups) for (const c of g.skills || []) skillNameOf[c.id] = c.name;

    /**
     * ══════════ 选中之后能干什么 ══════════
     *
     * ⚠ 只在**选了东西之后**出现。一条常驻的空工具条会占掉一行、
     * 而且它每一颗按钮都是灰的 —— 那种界面会让人以为功能坏了。
     *
     * ⚠ 技法卡是**加/减**，不是覆盖（服务端也是这么做的）。
     * 批量场景里几乎不存在"把这十镜的技法卡全换成这一张"，
     * 常见的是"这十镜都加一张手持"。覆盖的话，每一镜原来各自挑的运镜
     * 全没了 —— 而那是他一镜一镜挑出来的东西。
     */
    function paintBatchBar(bar, sel, tbl) {
      clear(bar);
      if (!sel.size) return;
      const ids = [...sel];

      const doBatch = async (body, okMsg) => {
        try {
          // cap:batch-edit
          const r = await api(`/projects/${project.id}/shots/batch`, { method: 'POST', body: { ids, ...body } });
          project = r.project || project;
          if (r.dropped?.length) toast(`有 ${r.dropped.length} 张互斥的技法卡被规整掉了`, 'warn');
          toast(`${okMsg}（${r.changed}/${r.total} 镜有变化）`, 'ok');
          paintShots();
        } catch (err) { toast(err.message, 'err'); }
      };

      const durInput = h('input', { type: 'number', step: '0.5', min: '0.5', class: 'cell-num', placeholder: '秒' });
      const skillSel = h('select', {},
        h('option', { value: '' }, '挑一张技法卡…'),
        ...skillGroups.flatMap((g) => (g.skills || []).map((c) =>
          h('option', { value: c.id }, `${g.label || g.id}·${c.name}`))));

      add(bar,
        h('span', { class: 'batch-count' }, `选中 ${sel.size} 镜`),
        h('button', {
          class: 'btn ghost sm',
          onclick: () => { sel.clear(); tbl.refresh(); paintBatchBar(bar, sel, tbl); }
        }, '清空选择'),
        h('span', { class: 'batch-sep' }),

        durInput,
        h('button', {
          class: 'btn sm',
          onclick: () => {
            const v = Number(durInput.value);
            if (!(v > 0)) return toast('先填一个秒数', 'warn');
            return doBatch({ patch: { duration: v } }, `这 ${ids.length} 镜的时长都改成 ${v} 秒`);
          }
        }, '改时长'),
        h('span', { class: 'batch-sep' }),

        skillSel,
        h('button', {
          class: 'btn sm',
          onclick: () => skillSel.value
            ? doBatch({ addSkills: [skillSel.value] }, '技法卡加上了')
            : toast('先挑一张卡', 'warn')
        }, '加上'),
        h('button', {
          class: 'btn ghost sm',
          onclick: () => skillSel.value
            ? doBatch({ removeSkills: [skillSel.value] }, '技法卡去掉了')
            : toast('先挑一张卡', 'warn')
        }, '去掉'),
        h('span', { class: 'batch-sep' }),

        /**
         * 只跑选中的这几镜。
         *
         * ⚠ 这里必须**先问一下价钱**：它长得像个不起眼的小按钮，
         * 而按下去是真花钱的。选了三十镜顺手一点，账单上是三十镜。
         */
        h('button', {
          class: 'btn sm',
          disabled: state.stage !== 'assets' && state.stage !== 'video',
          title: state.stage === 'assets' || state.stage === 'video'
            ? '只跑选中的这几镜（已经出过的会重出）'
            : '在「镜头出图」或「视频生成」那一步才能用',
          onclick: () => {
            if (!costConfirm(`只跑选中的这 ${ids.length} 镜（已经出过的会重出）。`, state.stage)) return;
            // cap:run-selected
            runStage(state.stage, { only: ids });
          }
        }, state.stage === 'video' ? '只出这几镜的视频' : '只出这几镜的图')
      );
    }

    function paintShots() {
      clear(shotHost);
      shotCards.clear();
      if (!project.shots?.length) {
        shotHost.append(h('div', { class: 'empty' }, h('b', {}, '还没有分镜'),
          '左边菜单里按顺序走：先「剧本」，再「设定集」，然后到「分镜」这一步点开始。'));
        return;
      }

      /**
       * ══════════ 表格视图 ══════════
       *
       * 卡片一屏三四镜，五十镜要滚十几屏。表格解决的是**通读和批量改**——
       * 那是卡片做不好的两件事。反过来看画面还是卡片好，所以两个都留着。
       */
      // cap:shot-table
      shotHost.append(
        h('div', { class: 'shot-view-bar' },
          h('button', {
            class: `btn ghost sm${state.shotView === 'table' ? '' : ' on'}`,
            onclick: () => { state.shotView = 'cards'; paintShots(); }
          }, '卡片'),
          h('button', {
            class: `btn ghost sm${state.shotView === 'table' ? ' on' : ''}`,
            title: '一行一镜，能多选、能用上下键',
            onclick: () => { state.shotView = 'table'; paintShots(); }
          }, '表格'),
          /**
           * ══════════ 连播 ══════════
           *
           * 出视频**之前**最后一道、也是最省钱的一道关：把分镜图按各自的
           * 时长连起来播一遍，立刻能听出"第 7 镜太长"、"这三镜全是中景，闷"、
           * "这句话根本来不及说完"。这些问题出完视频再发现，代价是整批重出。
           */
          h('button', {
            class: `btn ghost sm${state.shotView === 'play' ? ' on' : ''}`,
            title: '按各镜时长连起来播一遍 —— 不花钱，出视频之前先看节奏',
            onclick: () => { state.shotView = 'play'; paintShots(); }
          }, '连播'),
          state.shotView === 'table'
            ? h('span', { class: 'field-hint', style: 'margin:0' },
                '↑↓ 移动 · 空格选中 · Shift+↑↓ 连选 · 回车打开 · Esc 清空')
            : null)
      );

      /**
       * 指令框紧跟视图切换条 —— 和表格视图**互相印证**：
       * 指令说"第 6-12 镜"，表格里就该看见那 7 行。
       * 分开放的话，用户没法确认它选的和他想的是不是同一批，
       * 而"选错一批然后批量改"是这个框最坏的失败方式。
       */
      // cap:command-box
      shotHost.append(commandBox(project, {
        onDone: () => rerender(),
        onGo: (stage) => {
          if (!stage) return;
          state.stage = stage;
          rerender();
        }
      }));

      if (state.shotView === 'play') {
        const sortedAll = project.shots.slice().sort((a, b) => a.index - b.index);
        // cap:animatic
        const player = animatic(sortedAll, {
          mediaUrl,
          // 念出来的那段：署名和括注不算 —— 字幕上出现"（冷笑）"是错的
          spokenOf: (s) => String(s.dialogue || '').replace(/[（(][^）)]*[）)]/g, '').replace(/^[^：:]{1,8}[：:]/, '').trim()
        });
        /**
         * ⚠ 切走时必须停。不停的话 rAF 一直在跑、视频还在解码，
         * 而且下次进来会有两个播放器同时在动 —— 表现是"越用越卡"。
         */
        state.stopAnimatic?.();
        state.stopAnimatic = player.stop;
        shotHost.append(
          h('div', { class: 'field-hint', style: 'margin:0 0 8px' },
            `全片 ${DUR.fmtSeconds(player.total)}`
            + `${project.targetSeconds ? ` · 目标 ${DUR.fmtSeconds(project.targetSeconds)}` : ''}`
            + ' —— 这一遍不花钱，是出视频之前最后一道关'),
          player.node
        );
        player.focus();
        return;
      }
      state.stopAnimatic?.();
      state.stopAnimatic = null;

      if (state.shotView === 'table') {
        const sortedAll = project.shots.slice().sort((a, b) => a.index - b.index);
        const bar = h('div', { class: 'batch-bar' });
        /**
         * ══════════ 一键选上"该重出的那几镜" ══════════
         *
         * ⚠ 判据是**有可以动手的具体原因**，不是"分数低"。
         *
         * 按分数选的话会把一堆"数据上看不出毛病、只是模型这次画成这样"的
         * 镜头一起选上 —— 重出它们纯粹是碰运气，而每一次都真花钱。
         * 只选那些有明确原因的：图是旧描述出的、参考图没发、模型换过。
         */
        const redoBar = h('div', { class: 'redo-hint' });
        // cap:redo-candidates
        api(`/projects/${project.id}/redo-candidates`).then((r) => {
          const list = r?.shots || [];
          clear(redoBar);
          if (!list.length) return;
          const ids = list.map((x) => x.id);
          add(redoBar,
            h('span', {}, `有 ${list.length} 镜查得出具体原因该重出`),
            h('button', {
              class: 'btn ghost sm',
              title: list.slice(0, 6).map((x) => `第 ${x.index} 镜：${x.why}`).join('\n'),
              onclick: () => {
                ids.forEach((id) => picked.add(id));
                tbl.refresh();
                paintBatchBar(bar, picked, tbl);
              }
            }, '把它们选上'));
        }).catch(() => {});
        const tbl = shotTable(sortedAll, {
          selected: picked,
          skillNames: skillNameOf,
          onSelect: () => paintBatchBar(bar, picked, tbl),
          onOpen: (shot) => { state.openShotId = shot.id; state.shotView = 'cards'; paintShots(); },
          onPatch: async (id, patch) => {
            try {
              await api(`/projects/${project.id}/shots/${id}`, { method: 'PATCH', body: patch });
              const t = project.shots.find((x) => x.id === id);
              if (t) Object.assign(t, patch);
            } catch (err) { toast(err.message, 'err'); }
          }
        });
        shotHost.append(redoBar, bar, tbl.node);
        paintBatchBar(bar, picked, tbl);
        tbl.focus();
        return;
      }
      /**
       * 按**场次**分组显示，而不是摊成一长条。
       *
       * 场次边界是这条流水线上最要紧的一条线：跨过它就不能锁末帧、
       * 不能拿邻镜当参考、转场只能出现在这儿。它既然决定了这么多事，
       * 就该在界面上看得见 —— 看不见的话，人只会觉得
       * "为什么这两镜接不上"，而边界正在眼皮底下。
       */
      const sorted = project.shots.slice().sort((a, b) => a.index - b.index);
      const segs = project.segments || [];
      let openGrid = null;
      let lastSeg = null;

      for (const shot of sorted) {
        const seg = Number(shot.segment || 1);
        if (seg !== lastSeg) {
          const meta = segs.find((x) => Number(x.index) === seg
            && (x.chapterId || null) === (shot.chapterId || null));
          const enter = lastSeg === null ? '' : shot.transition || 'cut';
          shotHost.append(
            h('div', { class: 'seg-head' },
              h('span', { class: 'seg-no' }, `第 ${seg} 场`),
              h('span', { class: 'seg-where' },
                meta?.where || shot.scene || '（未标场景）',
                meta?.when ? h('span', { class: 'seg-when' }, `· ${meta.when}`) : null),
              meta?.summary ? h('span', { class: 'seg-sum' }, meta.summary) : null,
              // 进入这一场的方式。硬切是默认，不必声张；黑场和叠化要标出来
              enter && enter !== 'cut'
                ? h('span', { class: 'seg-enter' }, enter === 'fade' ? '⟨黑场进入⟩' : '⟨叠化进入 −0.5s⟩')
                : null)
          );
          openGrid = h('div', { class: 'shot-grid' });
          shotHost.append(openGrid);
          lastSeg = seg;
        }
        openGrid.append(renderShotCard(shot));
      }
    }

    // 分镜面板的标题和说明也跟着阶段走：同一张网格，在出图那步和出视频那步
    // 要看的东西不是一回事
    /**
     * 让模型给全片挑技法。
     *
     * 手选的问题不在于麻烦，在于**你未必记得住**：伦勃朗光、荷兰角、
     * 希区柯克变焦这些术语不是天天用就想不起来 —— 四十七张卡里永远只用那三张。
     * 挑完不自动重出图：先翻一遍，不满意的手改掉，再统一重出。
     */
    const suggestStatus = h('span', { class: 'field-hint', style: 'margin:0' });
    const suggestBtn = h('button', {
      class: 'btn ghost sm',
      title: '剧本模型读一遍每镜的画面描述，从技法库里挑。一次调用管全片，挑完再按前后镜顺一遍场（同场戏光线统一、连续动作运镜不掉头、机位不连着重复），只改文案不出图',
      onclick: async () => {
        if (!project.shots?.length) return toast('还没有分镜', 'err');
        if (!confirm(`让模型给这 ${project.shots.length} 镜挑技法？会覆盖已选的技法，一次对话调用，不出图。`)) return;
        suggestBtn.disabled = true;
        let err = null;
        try {
          await stream(`/projects/${project.id}/skills/suggest`, {}, (ev) => {
            if (ev.type === 'note' || ev.type === 'stage') suggestStatus.textContent = ev.message || '';
            if (ev.type === 'error') err = ev.message;
            if (ev.type === 'finished' && ev.project) project = ev.project;
          });
          if (err) throw new Error(err);
          toast('技法已挑好，翻一遍不满意的手改掉再重出图', 'ok');
          paintShots();
        } catch (e) {
          suggestStatus.textContent = e.message;
          toast(e.message, 'err');
        } finally {
          suggestBtn.disabled = false;
        }
      }
    }, '让模型挑技法');

    /**
     * 把台词绑到说话人身上。
     *
     * 不绑的后果很具体：配音全片一个声音，两个人对话时观众分不出谁在说话。
     * 而让人一条条点下拉框也不现实 —— 二十镜十二条台词，谁点得下去。
     * 先按台词署名和描述提示确定性地定（不花钱），剩下定不下来的才交给调度模型。
     */
    const bindStatus = h('span', { class: 'field-hint', style: 'margin:0' });
    const bindBtn = h('button', {
      class: 'btn ghost sm',
      title: '按台词里的署名、画面描述里的提示自动认人；只有在场不止一个人又没线索的才交给调度模型按上下文判。手选过的不会被覆盖',
      onclick: async () => {
        const lines = (project.shots || []).filter((s) => s.dialogue?.trim());
        if (!lines.length) return toast('全片没有台词', 'err');
        bindBtn.disabled = true;
        let err = null;
        try {
          await stream(`/projects/${project.id}/speakers/bind`, {}, (ev) => {
            if (ev.type === 'note' || ev.type === 'stage') bindStatus.textContent = ev.message || '';
            if (ev.type === 'error') err = ev.message;
            if (ev.type === 'finished' && ev.project) project = ev.project;
          });
          if (err) throw new Error(err);
          toast('说话人已绑好，不对的展开分镜手改', 'ok');
          paintShots();
        } catch (e) {
          bindStatus.textContent = e.message;
          toast(e.message, 'err');
        } finally {
          bindBtn.disabled = false;
        }
      }
    }, '自动绑说话人');

    const shotBadge = h('span', {});
    const shotHint = h('p', { class: 'panel-hint' });
    const stageName = h('span', { class: 'badge beam' });

    const HINTS = {
      'script-src': '剧本是整条流水线的输入。保存之后就可以往下走 —— 长篇建议先分章，后面每一步都能按章单独跑。',
      bible: '这一步只出文字，几秒钟就回来。去「设定集」页把描述过一遍，确认没问题再跑下一步出图。',
      sheets: '按已确认的描述出设定图，出完自动冻结。之后想改：去「设定集」页解冻 → 改描述 → 重出那一张。',
      script: '分镜是后面所有步骤的清单。每镜的时长在这里分配，加起来就是计划时长。',
      assets:
        '「一致性」是把成图和角色设定图交给多模态模型比对后的分数。低于阈值会自动换种子重试；不满意的展开「单独重出」，还能临时换一家模型 —— 有些镜头就是某家画不好，换一家比反复重试有效。',
      video:
        '以镜头图为首帧、配上从设定集装配的提示词生成片段。哪一镜在跑、轮询到第几次都会实时显示在缩略图上；失败的那几镜可以单独重出，还能临时换清晰度或换一家。',
      voice: '按台词逐条合成配音，用的是各角色分到的音色。台词字段里写的音效提示（"（远处传来汽笛声）"）会被识别出来跳过 —— 那不是台词，念出来就成了"没人张嘴却在说话"。',
      compose: 'FFmpeg 按分镜顺序拼接，按时长策略裁剪。这一步不花钱，跑错了重跑就行。'
    };

    /** 阶段换了：把只属于某一步的参数收起来，分镜卡片也重画一遍 */
    function applyScope() {
      const sc = scope();
      applyStepPanels();
      const meta = steps.find((x) => x.id === state.stage);
      // 这一步在分镜网格里看的是什么、看了多少。
      // 不再写"当前：分镜"——步骤名左边菜单里已经高亮着了，重复一遍是噪音
      const prog = stepProgress(project, state.stage);
      clear(stageName).append(
        prog.total ? `${meta?.label || ''} ${prog.done}/${prog.total} ${prog.unit}` : meta?.label || ''
      );
      shotHint.textContent = HINTS[state.stage] || '这一步的产出不在分镜网格里，切到对应的页面看。';
      const miss = (project.shots || []).filter((s) => (state.stage === 'video' ? !s.videoPath : !s.imagePath)).length;
      const pend = (project.shots || []).filter((s) => s.pendingTask && !s.videoPath).length;
      clear(shotBadge);
      if (miss) {
        shotBadge.append(
          h('span', { class: 'badge warn' }, state.stage === 'video' ? `${miss} 镜缺视频` : `${miss} 镜缺图`)
        );
      }
      // "待认领"和"缺"要分开说：前者是钱花了没取回来，后者是压根没跑
      if (pend && state.stage === 'video') {
        shotBadge.append(h('span', { class: 'badge warn' }, `${pend} 个任务待认领`));
      }
      paintShots();
    }

    /**
     * 一段镜头一起标衔接关系。
     *
     * 「这一段是一个连贯动作」是**按段**发生的想法，不是按镜：
     * 推门→进门→环视→停下，四镜是一件事。一镜一镜点四次，
     * 中间容易漏掉一镜 —— 而漏掉的那一镜恰恰是断点，出完片才看得出来。
     */
    const linkFrom = h('input', { type: 'number', min: 1, value: '1', style: 'width:72px' });
    const linkTo = h('input', { type: 'number', min: 1, value: String(project.shots?.length || 1), style: 'width:72px' });
    const linkKind = h('select', {},
      ...(state.catalog.links || []).map((l) =>
        h('option', { value: l.id, selected: l.id === 'continuous', title: l.hint || '' }, l.label)));
    const linkStatus = h('span', { class: 'field-hint' });
    const linkBtn = h('button', {
      class: 'btn sm',
      onclick: async (e) => {
        const kind = linkKind.value;
        if (kind === 'continuous') {
          // 标成连续动作是有代价的，说清楚再问 —— 事后才发现"怎么这么慢"最气人
          const n = Math.abs(Number(linkTo.value) - Number(linkFrom.value)) + 1;
          if (!confirm(
            `把第 ${linkFrom.value}~${linkTo.value} 镜（共 ${n} 镜）标成「连续动作」？\n\n` +
            '这几镜会串行生成（每一镜要等前一镜的末帧），比并行慢好几倍；\n' +
            '而且机位被锁住 —— 连续动作意味着不切镜位，标多了整段会变成一个长镜头。'
          )) return;
        }
        e.target.disabled = true;
        try {
          // cap:link-batch
          const r = await api(`/projects/${project.id}/shots/link`, {
            method: 'POST',
            body: { from: Number(linkFrom.value), to: Number(linkTo.value), link: kind }
          });
          linkStatus.textContent = r.changed.length
            ? `改了 ${r.changed.length} 镜：第 ${r.changed.join('、')} 镜`
            : '这几镜本来就是这个关系，没动';
          project = r.project;
          paintShots();
        } catch (err) {
          linkStatus.textContent = err.message;
        } finally {
          e.target.disabled = false;
        }
      }
    }, '整段标记');

    /**
     * 让调度模型通读全片自动标。
     *
     * ── 为什么这活儿只能交给模型 ──
     *
     * 规则能判的只有"换没换场景"（比场景名），而那本来就在自动做。
     * "这一镜是不是上一镜那个动作的下一瞬间"要读懂两句中文之间的**动作关系**：
     * 「伸手去够门把手」和「把门把手拧下去」是同一只手的同一个动作，
     * 而「他在批改作业」和「特写他的钢笔」不是 —— 字面上同一场戏、同一批词，
     * 规则区分不了，硬写关键词只会得到一个不断误判的东西。
     *
     * 模型答完还有一层确定性收口（跨场次不许、连着三镜就停、手选过的不覆盖），
     * 被拦下来的也会逐条说出来 —— 不然人看到模型说了却没生效，只会以为坏了。
     */
    const autoLinkStatus = h('span', { class: 'field-hint', style: 'margin:0' });
    const autoLinkBtn = h('button', {
      class: 'btn sm',
      title: '让调度模型读一遍全片，找出哪几镜是同一个动作的下一瞬间',
      onclick: async () => {
        autoLinkBtn.disabled = true;
        const label = autoLinkBtn.textContent;
        autoLinkBtn.textContent = '通读中…';
        try {
          let err = null;
          await stream(
            // cap:link-auto
            `/projects/${project.id}/shots/link/auto`,
            {},
            (ev) => {
              if (ev.type === 'error') err = ev.message;
              if (ev.type === 'finished' && ev.project) project = ev.project;
              if (ev.message) autoLinkStatus.textContent = ev.message;
            }
          );
          if (err) throw new Error(err);
          paintShots();
        } catch (e2) {
          autoLinkStatus.textContent = e2.message;
        } finally {
          autoLinkBtn.disabled = false;
          autoLinkBtn.textContent = label;
        }
      }
    }, '自动标连续动作');

    const shotsPanel = h('div', { class: 'panel' },
      h('h2', { class: 'panel-title' },
        '分镜',
        stageName,
        shotBadge
      ),
      shotHint,
      h('div', { class: 'inline', style: 'margin-bottom:10px;flex-wrap:wrap;gap:6px' },
        h('span', { class: 'field-hint' }, '第'), linkFrom,
        h('span', { class: 'field-hint' }, '到'), linkTo,
        h('span', { class: 'field-hint' }, '镜，标成'), linkKind, linkBtn, linkStatus),
      // 手工整段标之外，再给一条"让模型通读全片"的路 ——
      // 二十镜里哪两镜是同一个动作，人自己一对一对看是很累的
      h('div', { class: 'inline', style: 'margin-bottom:10px;flex-wrap:wrap;gap:6px' },
        autoLinkBtn, autoLinkStatus),
      // 这两个按钮只在用得上的那一步露面：在出图那步摆一个"自动绑说话人"，
      // 只会让人以为得先把它按了才能出图
      h('div', { class: 'inline', style: 'margin-bottom:10px;flex-wrap:wrap' },
        suggestBtn, suggestStatus, bindBtn, bindStatus),
      shotHost
    );

    /**
     * ───────────── 剪辑台 ─────────────
     *
     * ⚠ 它是**独立一块**，摆在「成片」上面，不再塞在成片面板里。
     *
     * 两个理由：
     * ① 顺序不对。人的动作是"先剪，再出片，再看" —— 而它原来在成片下面，
     *    等于让人先看完片子再往回翻去改。
     * ② 原来它只在**已经有成片**的时候才出现（整块藏在 outputs.video 的分支里），
     *    可第一次合成之前恰恰最该先排一遍顺序。
     */
    const cutPanel = h('div', { style: 'display:none' });
    (() => {
      const room = cutRoom();
      if (room) cutPanel.append(room);
      else {
        cutPanel.append(h('div', { class: 'panel' },
          h('h2', { class: 'panel-title' }, '剪辑台'),
          h('p', { class: 'panel-hint' },
            '还没有可剪的片段 —— 先把「视频生成」那一步跑出至少一镜，这里才会出现时间线。')));
      }
    })();

    // ───────────── 成片 ─────────────
    // 合成那一步的产出不在分镜网格里，得有个地方能直接看
    const composePanel = h('div', { class: 'panel', style: 'display:none' },
      h('h2', { class: 'panel-title' }, '成片'),
      (() => {
        const v = Date.parse(project.updatedAt || '') || 0;
        if (!project.outputs?.video) {
          return h('p', { class: 'panel-hint' }, '还没有成片。上面点「开始」，FFmpeg 会按分镜顺序拼接、按时长策略裁剪。这一步不花钱，跑错了重跑就行。');
        }
        /**
         * 成片体检。摆在成片这一步，是因为**决定发不发就是在这儿做的**。
         *
         * 检查一直都有，但散在四个地方各说各的：分镜卡片上的一致性分数、
         * 分镜体检、出视频日志里的首帧核对和接缝比对、合成日志里的台词超长。
         * 每一条单看都有用，合起来却回答不了那个真正要问的问题 ——
         * 我现在导出去，会不会有明显的错？
         *
         * 而实际发生的是：人跑完全流程，看一眼觉得还行就发了，
         * 那几条警告出现在几十分钟前、混在几百行日志里，谁也没回头翻。
         */
        const qualityHost = h('div', { style: 'margin-top:12px' });
        api(`/projects/${project.id}/quality`).then((r) => {
          const tone = r.verdict === 'ready' ? 'ok' : r.verdict === 'fixable' ? 'warn' : 'bad';
          clear(qualityHost);
          qualityHost.append(
            h('div', { class: `notice ${tone === 'bad' ? 'warn' : ''}` },
              h('b', {}, `成片体检：${r.score} 分 · ${
                { ready: '可以发', fixable: '能发，但有几处值得改', 'not-ready': '先别发' }[r.verdict]}`),
              /**
               * ⚠ 分数**永远不单独出现**。它只是把"有多少问题、多严重"压成一个数，
               * 本身没有物理意义 —— 92 和 88 之间没有任何可解释的差别。
               * 只印一个分数的界面是在假装精确，人下一秒就要问"哪儿扣的分"。
               */
              r.items.length
                ? h('div', {}, ...r.items.map((i) => h('p', { style: 'margin:8px 0' },
                  h('span', { class: `badge ${i.level === 'blocker' ? 'warn' : ''}` },
                    { blocker: '会被看出来', warn: '质量风险', note: '可改进' }[i.level]),
                  ' ', h('b', {}, i.what),
                  h('span', { class: 'field-hint', style: 'display:block;margin-top:2px' }, i.why),
                  h('span', { class: 'field-hint', style: 'display:block' }, `→ ${i.fix}`))))
                : h('p', {}, '四类检查都过了：产物齐、一致性达标、接缝对得上、分镜没有高危项。')));
        }).catch(() => { /* 体检拉不到不该把成片页弄坏 */ });
        return h('div', {},
          // cap:quality-report
          qualityHost,
          h('video', {
            // cap:film-view
            src: `${mediaUrl(project.outputs.video)}&v=${v}`,
            controls: true,
            style: 'width:100%;max-height:62vh;border-radius:var(--r);background:#000'
          }),
          h('div', { class: 'inline', style: 'margin-top:10px;flex-wrap:wrap' },
            h('a', { class: 'btn sm', href: mediaUrl(project.outputs.video), target: '_blank' }, '在新窗口打开'),
            // 精剪在剪映/达芬奇里做，这里负责把素材一次性备齐：
            // 成片、每镜片段、字幕、每条配音，外加一张分镜表
            h('a', {
              class: 'btn sm primary',
              // cap:asset-pack
              href: `/api/projects/${project.id}/export.zip`,
              download: '',
              title: '成片 + 每镜片段 + 字幕 + 配音 + 分镜表，打成一个包'
            }, '打包全部素材'),
            project.outputs.subtitle
              ? h('a', { class: 'btn ghost sm', href: mediaUrl(project.outputs.subtitle), target: '_blank' }, '下载字幕 .srt')
              : null,
            h('span', { class: 'field-hint', style: 'margin:0' },
              `${project.outputs.seconds ? `${project.outputs.seconds}s · ` : ''}` +
              `${project.outputs.durationPolicy === 'trim' ? '按分镜时长裁剪' : '保留完整片段'}`)),
          /**
           * **哪几镜还没出视频，必须说出来。**
           *
           * 少一镜的素材包看起来和齐了的一模一样：文件按序号排好、分镜表也在。
           * 人拖进剪映排完一条时间线，才发现中间缺了一镜 —— 那时候要么回来补出、
           * 要么将就着接上，两条都是白干一遍。这一条不报，代价全落在最后一步。
           */
          (() => {
            const missing = (project.shots || []).filter((x) => !x.videoPath);
            return missing.length
              ? h('div', { class: 'notice warn', style: 'margin-top:10px' },
                h('b', {}, `第 ${missing.map((x) => x.index).join('、')} 镜还没出视频`),
                h('p', {},
                  '打包出来的素材里没有它们的片段，而包看起来是齐的 —— '
                  + '拖进剪映排完才会发现时间线中间缺一段。先把这几镜出了再打包。'))
              : null;
          })());
      })()
    );

    /**
     * ══════════════ 剪辑台 ══════════════
     *
     * 在这之前，整条链路是**一次性**的：分镜定好 → 出图 → 出视频 → 合成 → 完。
     * 想调节奏、换顺序、砍掉一镜，只能回分镜页改字段**再重跑**——
     * 而重跑是按镜数计费的。
     *
     * 可是"这段太拖，砍掉一秒""第 7 和第 8 对调""这一镜不要了""配段音乐"
     * 这些事，**一帧都不用重新生成**。素材已经在盘上，要动的只是"怎么拼" ——
     * 那是 FFmpeg 层的事，十几秒的活，一分钱不花。
     *
     * ════════ 为什么是时间线，不是一行一行的清单 ════════
     *
     * 第一版做成了清单：每一镜一行，填入点出点。功能上全有，但它回答不了
     * 剪辑时**唯一真正要问的那个问题** —— "现在这条片子长什么样"。
     *
     * 节奏是**看**出来的：哪一段特别长、哪几段挤在一起、音乐从第几秒进、
     * 台词压不压得住。这些在清单里全部是数字，而在时间线上是一眼的事。
     * 所以这一版把片段按**时长成比例**摆在一条横轨上，配一个能就地播放的预览：
     * 拖着看、拖着改。
     *
     * ⚠ 时间线量的必须和成片**一模一样**。所以它不自己算 ——
     * 走的是引擎那一份 `edit.timeline()`（服务端把 core/pipeline/edit.js
     * 原样发到 /edit.js）。界面里另写一份的话两份一定会漂，而漂开的表现是
     * "时间线上写第 22 秒、成片里在第 20.5 秒"，没有报错，只能拿秒表比。
     *
     * ⚠ 顺序、入出点、转场改的是 project.edit，而配音和字幕也从
     * edit.timeline() 拿起点 —— 所以它们会跟着一起挪。这是这块能不能用的前提：
     * 只改画面不改声音，等于把一部对上的片子改成对不上的。
     */
    function cutRoom() {
      const clips = (project.shots || []).filter((s) => s.videoPath);
      if (!clips.length) return null;

      const natural = clips.slice().sort((x, y) => x.index - y.index).map((s) => s.id);
      const byId = new Map(clips.map((s) => [s.id, s]));
      const settings = state.catalog?.settings || {};
      const policy = settings.durationPolicy || 'keep';

      const draft = {
        /**
         * ⚠ 存下来的顺序要**和现在真实有视频的那几镜对齐**，不能原样端出来。
         *
         * 两个方向都会出事：里面躺着一个后来被删掉的镜头 id，时间线上会少一块
         * 而且没人知道为什么；后来才补出视频的那几镜不在里面，它们会**整个消失**
         * —— 素材在盘上、成片里没有，而这在界面上完全看不出来。
         */
        order: (Array.isArray(project.edit?.order) ? project.edit.order : []).filter((id) => byId.has(id)),
        clips: JSON.parse(JSON.stringify(project.edit?.clips || {})),
        tracks: { ...(project.edit?.tracks || {}) },
        music: project.edit?.music ? { ...project.edit.music } : null
      };
      for (const id of natural) if (!draft.order.includes(id)) draft.order.push(id);

      // ───────────── 存盘 ─────────────
      /**
       * 保存要**串行、但不能丢**。
       *
       * 第一版写的是 `if (saving) return;` —— 一次保存在飞的时候，
       * 后来的那次直接扔掉。走查里立刻现形：改完入点马上点「恢复默认」，
       * 恢复那一下被吞了，界面显示已恢复而盘上还是旧的。
       *
       * 而这正是最难查的一类：它只在**手快**的时候发生，复现要靠运气，
       * 用户报上来的会是"有时候改了不生效"。排队重发一次（最后一次赢）。
       */
      let saving = false;
      let queued = false;
      const save = async () => {
        if (saving) { queued = true; return; }
        saving = true;
        try {
          // cap:film-cut
          await api(`/projects/${project.id}`, { method: 'PATCH', body: { edit: draft } });
          project.edit = JSON.parse(JSON.stringify(draft));
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          saving = false;
          if (queued) { queued = false; await save(); }
        }
      };

      /**
       * 撤销 / 重做。
       *
       * 剪辑台上每一步都是破坏性的（拖一下顺序就变了），而人一定会拖错。
       * 没有撤销的话，唯一的退路是「恢复默认」—— 那会把之前调好的全清掉，
       * 代价大到人干脆不敢拖。
       *
       * 存的是整份剪辑决定的快照。它是个几百字节的小对象，
       * 存六十份也不到几十 KB —— 比"算出反操作"简单得多，也不会算错。
       */
      const past = [];
      const future = [];
      let baseline = JSON.stringify(draft);
      const load = (text) => {
        const p = JSON.parse(text);
        draft.order = p.order;
        draft.clips = p.clips;
        draft.tracks = p.tracks;
        draft.music = p.music;
      };
      /** 改之前叫一声，把改动**之前**那份压进撤销栈 */
      const mark = () => {
        past.push(baseline);
        if (past.length > 60) past.shift();
        future.length = 0;
      };
      /** 改完之后叫一声：更新基线、存盘、重画 */
      const done = () => {
        const now = JSON.stringify(draft);
        /**
         * ⚠ **什么都没改的那一步不能占一格撤销。**
         *
         * 走查里现形的：在属性面板里填一个数，浏览器会连着发两次 change
         *（一次来自输入、一次来自失焦），于是压进去两格，其中第二格
         * 和第一格一模一样。人点一下「撤销」，界面纹丝不动 ——
         * 要点两下才退得回去。
         *
         * 而这种"点了没反应"最伤：人会以为撤销坏了，然后再也不敢拖。
         */
        if (past.length && past[past.length - 1] === now) past.pop();
        baseline = now;
        save();
        repaint();
      };

      /**
       * 重画要**推迟到下一帧**，不能在事件处理里当场做。
       *
       * change 事件是在失焦的过程中触发的。此时把这个输入框所在的整棵子树
       * 拆掉，浏览器紧接着要把焦点还给一个已经不在文档里的节点，于是抛
       * `The node to be removed is no longer a child of this node`。
       * 页面看着没事，控制台里一条红的 —— 而走查是盯着页面报错的。
       *
       * 顺带还去掉了一次重复渲染：连着改两个字段只会重画一次。
       */
      let pending = 0;
      const repaint = () => {
        if (pending) return;
        pending = requestAnimationFrame(() => { pending = 0; paintAll(); });
      };
      const undoStep = () => {
        if (!past.length) return;
        future.push(JSON.stringify(draft));
        load(past.pop());
        baseline = JSON.stringify(draft);
        save();
        repaint();
      };
      const redoStep = () => {
        if (!future.length) return;
        past.push(JSON.stringify(draft));
        load(future.pop());
        baseline = JSON.stringify(draft);
        save();
        repaint();
      };

      /**
       * ══════ 小剪刀 ══════
       *
       * 在播放头那一刀把选中的片段切成两段。两段共用同一个素材文件，
       * 各有各的入出点 —— 所以"切一刀"不重新生成任何东西，还是十几秒的活。
       *
       * ⚠ 台词和音效**只跟第一段走**（引擎那边靠 timeline 的 `first` 判）。
       * 不这么定的话，切一刀就会把同一句话念两遍。
       *
       * 两边各留至少 0.3 秒：再短就是一帧闪过，观众只会觉得画面抖了一下。
       */
      const splitPoint = () => {
        if (!sel) return null;
        const r = rowsOf().find((x) => x.key === sel);
        if (!r) return null;
        const into = playAt - r.start;
        if (into < MINSPAN || r.span - into < MINSPAN) return null;
        const a = r.win ? r.win.in : 0;
        return { row: r, at: Number((a + into).toFixed(2)), a, b: r.win ? r.win.out : r.total };
      };
      const canSplit = () => Boolean(splitPoint());
      const splitHere = () => {
        const p = splitPoint();
        if (!p) {
          toast('把播放头拖到这一段中间再切 —— 两边各要留够 0.3 秒', 'warn');
          return;
        }
        mark();
        const key = p.row.key;
        const next = EDIT.nextKey(draft, EDIT.shotIdOf(key));
        // 前半段：原 key 保留（转场、效果、静音都跟着它，因为它还接在原来的位置上）
        setClip(key, { in: Number(p.a.toFixed(2)), out: p.at });
        // 后半段：新 key，只带入出点。转场留空 = 硬切，这是切开之后最合理的默认
        draft.clips[next] = { in: p.at, out: Number(p.b.toFixed(2)) };
        const at = draft.order.indexOf(key);
        draft.order.splice(at + 1, 0, next);
        sel = next;
        done();
        toast(`切成两段：${p.at - p.a > 0 ? `${(p.at - p.a).toFixed(1)}s + ${(p.b - p.at).toFixed(1)}s` : ''}`, 'ok');
      };

      /**
       * 删除选中的片段。
       *
       * 分两种，因为**可逆性不一样**：
       *   切出来的段  直接从 order 里拿掉 —— 它本来就是切出来的，没了就是没了，
       *               但另一半还在，再切一次就能回来
       *   整镜那一段  标成"不用"而不是删掉 —— 那是这一镜在时间线上唯一的位置，
       *               真删了就再也放不回来。标"不用"能从左边素材架里点回来
       */
      const deleteSel = () => {
        if (!sel) return;
        const sid = EDIT.shotIdOf(sel);
        const parts = draft.order.filter((k) => EDIT.shotIdOf(k) === sid);
        mark();
        if (parts.length > 1) {
          draft.order = draft.order.filter((k) => k !== sel);
          delete draft.clips[sel];
          toast('这一段拿掉了（同一镜的另一段还在）', 'ok');
        } else {
          setClip(sel, { off: true });
          toast('标成"不用"了 —— 左边素材架里点「放回来」就回来', 'ok');
        }
        sel = null;
        done();
      };

      const setClip = (id, patch) => {
        draft.clips[id] = { ...(draft.clips[id] || {}), ...patch };
        for (const [k, val] of Object.entries(draft.clips[id])) {
          if (val == null || val === false || val === 'none' || val === 'cut') delete draft.clips[id][k];
        }
        if (!Object.keys(draft.clips[id]).length) delete draft.clips[id];
      };

      // ───────────── 时间轴（引擎那一份，不自己算）─────────────
      const rowsOf = () => EDIT.timeline({ shots: clips, edit: draft }, { policy });
      const totalOf = (rs) => (rs.length ? Number((rs[rs.length - 1].start + rs[rs.length - 1].span).toFixed(2)) : 0);

      // ───────────── 视图状态 ─────────────
      /** 每秒画多少像素。缩放改的是它 */
      let pps = 46;
      /**
       * 选中的是**片段 key**，不是镜头 id。
       * 一镜被小剪刀切开之后是两段（`s1` 和 `s1#2`），各选各的。
       */
      let sel = null;
      let playAt = 0;
      let playing = false;
      let fitted = false;

      /** 一段最短留多少秒。和引擎那边的 edit.MIN_SPAN 是同一个数 */
      const MINSPAN = EDIT.MIN_SPAN;
      const LAB = 96;   // 左边轨道名那一列
      const H = { ruler: 20, video: 62, audio: 24 };

      const fmt = (sec) => {
        const s = Math.max(0, Number(sec) || 0);
        const m = Math.floor(s / 60);
        const r = s - m * 60;
        return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
      };

      // ───────────── 预览 ─────────────
      /**
       * 预览要**能听见声音**，否则"音乐压不压得住台词"这件事只能靠合成完再听，
       * 而那正是剪辑台想省掉的那一趟。
       *
       * 做法是三个独立的播放器跟着播放头走：当前这一镜的画面、这一镜的配音、
       * 这一镜的音效，外加一条整片的背景音乐。
       *
       * ⚠ 它**不等于成片**，有两处如实说明白：自动避让（音乐给台词让路）
       * 是 FFmpeg 那一层做的，预览里没有；镜与镜之间会有一次很短的加载停顿，
       * 因为每一镜是一个独立文件。要听最终效果还是得点「重新合成」——
       * 那一步十几秒，不花钱。
       */
      const video = h('video', {
        class: 'tl-video',
        playsinline: true,
        preload: 'auto',
        onclick: () => togglePlay()
      });
      const voiceEl = h('audio', { preload: 'auto' });
      const sfxEl = h('audio', { preload: 'auto' });
      const musicEl = h('audio', { preload: 'auto', loop: true });
      let curShot = null;

      const setSrc = (el, url) => {
        if (!url) { if (el.getAttribute('src')) { el.pause(); el.removeAttribute('src'); el.load(); } return; }
        if (el.getAttribute('src') !== url) { el.src = url; }
      };
      const at = (el, t) => {
        const put = () => { try { el.currentTime = Math.max(0, t); } catch { /* 还没准备好，等元数据 */ } };
        if (el.readyState >= 1) put();
        else el.addEventListener('loadedmetadata', put, { once: true });
      };

      /**
       * 播放头落在哪一段上。
       *
       * ⚠ **重叠类转场会让相邻两段的时间范围叠在一起**（叠化各吃掉 0.5 秒，
       * 所以下一段的起点比上一段的终点还早）。用"第一个还没结束的"去找，
       * 在重叠区里会找回**上一段** —— 于是"跳到下一段的起点"跳完还在原地，
       * 下一帧又触发跳转，播放就死在那个接缝上再也过不去。
       *
       * 用户报上来的原话："点击按钮演示一直卡在那边播放不下去"。
       * 从后往前找第一个"起点已经到了"的，重叠区就归**后一段**，和成片一致。
       */
      const rowAt = (rs, t) => {
        for (let i = rs.length - 1; i >= 0; i -= 1) if (t >= rs[i].start - 0.001) return rs[i];
        return rs[0];
      };

      const seek = (t, { play = null, row = null } = {}) => {
        const rs = rowsOf();
        if (!rs.length) return;
        const tot = totalOf(rs);
        playAt = Math.max(0, Math.min(Number(t) || 0, tot));
        // 跳到下一段时**按下标点名**，不靠时间去猜 —— 重叠区里猜是猜不准的
        const r = (row != null && rs[row]) || rowAt(rs, playAt);
        if (row != null && rs[row]) playAt = Math.max(playAt, rs[row].start);
        const inAt = r.win ? r.win.in : 0;
        const into = Math.max(0, playAt - r.start);

        if (curShot !== r.shot.id) {
          curShot = r.shot.id;
          setSrc(video, mediaUrl(r.shot.videoPath));
          setSrc(voiceEl, r.shot.audioPath && !r.muted && EDIT.trackOn(draft, 'voice') ? mediaUrl(r.shot.audioPath) : null);
          setSrc(sfxEl, r.shot.sfxPath && !r.muted && EDIT.trackOn(draft, 'sfx') ? mediaUrl(r.shot.sfxPath) : null);
        }
        at(video, inAt + into);
        at(voiceEl, into);
        at(sfxEl, into);

        const music = EDIT.musicOf(draft);
        setSrc(musicEl, music ? mediaUrl(music.path) : null);
        musicEl.volume = Math.min(1, music ? music.gain : 0);
        sfxEl.volume = Math.min(1, Number(settings.sfxGain ?? 0.35));
        if (music) at(musicEl, playAt);

        movePlayhead();
        if (play === true) startPlay();
        else if (play === false) stopPlay();
        else if (playing) startPlay();
      };

      const startPlay = () => {
        playing = true;
        for (const el of [video, voiceEl, sfxEl, musicEl]) {
          if (el.getAttribute('src')) el.play().catch(() => { /* 自动播放被拦，点一下就好 */ });
        }
        const btn = host.querySelector('.tl-play');
        if (btn) btn.textContent = '⏸';
      };
      const stopPlay = () => {
        playing = false;
        for (const el of [video, voiceEl, sfxEl, musicEl]) el.pause();
        const btn = host.querySelector('.tl-play');
        if (btn) btn.textContent = '▶';
      };
      const togglePlay = () => (playing ? stopPlay() : seek(playAt, { play: true }));

      video.addEventListener('timeupdate', () => {
        if (!playing) return;
        const rs = rowsOf();
        const r = rs.find((x) => x.shot.id === curShot);
        if (!r) return;
        const inAt = r.win ? r.win.in : 0;
        // 到这一镜的出点了 —— 跳下一镜。这一步就是"按剪辑顺序播"
        if (video.currentTime >= inAt + r.span - 0.04) {
          const i = rs.indexOf(r);
          if (i + 1 < rs.length) return seek(rs[i + 1].start, { play: true, row: i + 1 });
          stopPlay();
          return seek(0);
        }
        playAt = r.start + (video.currentTime - inAt);
        movePlayhead(false);
      });
      video.addEventListener('ended', () => {
        if (!playing) return;
        const rs = rowsOf();
        const i = rs.findIndex((x) => x.shot.id === curShot);
        if (i >= 0 && i + 1 < rs.length) seek(rs[i + 1].start, { play: true, row: i + 1 });
        else { stopPlay(); seek(0); }
      });

      // ───────────── 结构（只搭一次，之后只重画里面）─────────────
      const host = h('div', { class: 'panel tl-panel' });
      const shelfBox = h('div', { class: 'tl-shelf' });
      const propsBox = h('div', { class: 'tl-props' });
      const barBox = h('div', { class: 'tl-bar' });
      const labelsBox = h('div', { class: 'tl-labels' });
      const laneBox = h('div', { class: 'tl-inner' });
      const scrollBox = h('div', { class: 'tl-scroll' }, laneBox);
      const audioBox = h('div', { class: 'cut-audio' });
      const footBox = h('div', { class: 'inline', style: 'margin-top:12px;flex-wrap:wrap' });
      const clock = h('span', { class: 'tl-clock' }, '00:00.00 / 00:00.00');
      const head = h('div', { class: 'tl-head' });

      // ───────────── 左边：素材架 ─────────────
      /**
       * 时间线上只有**用到的**那几镜。标成"不用"的会从轨道上消失 ——
       * 没有这一栏的话它们就再也回不来了，而"不用"本来就该是可逆的。
       */
      function paintShelf() {
        clear(shelfBox);
        const rs = rowsOf();
        const used = new Set(rs.map((r) => r.key));
        shelfBox.append(
          h('div', { class: 'tl-shelf-hd' }, '素材',
            h('span', { class: 'field-hint', style: 'margin:0 0 0 6px' }, `${used.size}/${draft.order.length} 段在用`)),
          ...draft.order.map((key) => {
            const s = byId.get(EDIT.shotIdOf(key));
            if (!s) return null;
            const on = used.has(key);
            const part = key.includes('#') ? `·${key.split('#')[1]}` : '';
            return h('div', {
              class: `tl-card${on ? '' : ' off'}${sel === key ? ' on' : ''}`,
              title: on ? '点一下选中它' : '这一段现在不进成片，点「放回来」',
              onclick: () => { sel = key; paintShelf(); paintProps(); paintLanes(); syncTools(); }
            },
            s.imagePath
              ? h('img', { src: mediaUrl(s.imagePath), class: 'tl-card-img' })
              : h('div', { class: 'tl-card-img' }),
            h('div', { style: 'min-width:0;flex:1' },
              h('div', { class: 'tl-card-t' }, `#${s.index}${part}`),
              h('div', { class: 'field-hint', style: 'margin:0' },
                on ? `${(rs.find((r) => r.key === key)?.span || 0).toFixed(1)}s` : '不用')),
            !on
              ? h('button', {
                  class: 'btn ghost sm',
                  onclick: (e) => { e.stopPropagation(); mark(); setClip(key, { off: false }); done(); }
                }, '放回来')
              : null);
          }).filter(Boolean)
        );
      }

      // ───────────── 右边：属性 ─────────────
      function paintProps() {
        clear(propsBox);
        const rs = rowsOf();
        const r = rs.find((x) => x.key === sel);
        const s = sel ? byId.get(EDIT.shotIdOf(sel)) : null;
        if (!s) {
          propsBox.append(
            h('div', { class: 'tl-props-hd' }, '属性'),
            h('p', { class: 'field-hint' }, '在时间线上点一段，这里显示它的入出点、转场和画面效果。拖两端可以裁剪，拖中间可以换位置。'));
          return;
        }
        const total = Number(s.actualDuration) || Number(s.duration) || 0;
        const win = r?.win || null;
        const a = win ? win.in : 0;
        const b = win ? win.out : total;

        const num = (val, onSet, title) => h('input', {
          type: 'number', step: '0.1', min: '0', max: String(total || 60),
          value: String(Number(val).toFixed(2)), title,
          onchange: (e) => { mark(); onSet(Number(e.target.value)); done(); }
        });

        const part = String(sel).includes('#') ? `（第 ${String(sel).split('#')[1]} 段）` : '';
        propsBox.append(
          h('div', { class: 'tl-props-hd' }, '属性'),
          h('div', { class: 'tl-field' }, h('label', {}, '名称'),
            h('div', { class: 'tl-val' }, `第 ${s.index} 镜${part}`)),
          h('div', { class: 'tl-two' },
            h('div', { class: 'tl-field' }, h('label', {}, '开始'),
              num(a, (v) => setClip(sel, { in: Math.max(0, Math.min(v, b - 0.3)), out: Number(b.toFixed(2)) }), '从素材的第几秒进')),
            h('div', { class: 'tl-field' }, h('label', {}, '结束'),
              num(b, (v) => setClip(sel, { in: Number(a.toFixed(2)), out: Math.min(total || v, Math.max(v, a + 0.3)) }), '切到素材的第几秒'))),
          h('div', { class: 'tl-field' }, h('label', {}, '本段时长'),
            h('div', { class: 'tl-val big' }, `${(r?.span || 0).toFixed(2)} s`),
            h('div', { class: 'field-hint', style: 'margin:2px 0 0' }, `素材共 ${total.toFixed(2)}s`)),
          h('div', { class: 'tl-field' }, h('label', {}, '转场（怎么接上来）'),
            (() => {
              const first = rs[0]?.key === sel;
              const cur = draft.clips[sel]?.trans || s.transition || 'cut';
              return h('select', {
                disabled: first,
                title: first ? '第一段前面没有片子，没有"怎么接上来"这回事' : '',
                onchange: (e) => { mark(); setClip(sel, { trans: e.target.value }); done(); }
              },
              h('optgroup', { label: '常用' },
                ...TRANS.CATALOG.filter((t) => TRANS.KINDS.includes(t.id))
                  .map((t) => h('option', { value: t.id, selected: cur === t.id, title: t.why }, t.label))),
              h('optgroup', { label: '更多（满屏花哨转场是最典型的业余做法，慎用）' },
                ...TRANS.CATALOG.filter((t) => !TRANS.KINDS.includes(t.id))
                  .map((t) => h('option', { value: t.id, selected: cur === t.id, title: t.why }, t.label))));
            })()),
          h('div', { class: 'tl-field' }, h('label', {}, '画面效果'),
            h('select', {
              title: '只有这一段会重压一遍（慢一点，但不重新生成素材、不花钱）',
              onchange: (e) => { mark(); setClip(sel, { fx: e.target.value }); done(); }
            }, ...FX.CATALOG.map((f) =>
              h('option', { value: f.id, selected: (draft.clips[sel]?.fx || 'none') === f.id, title: f.why }, f.label))),
            h('div', { class: 'field-hint', style: 'margin:2px 0 0' },
              FX.defOf(draft.clips[sel]?.fx || 'none').why)),
          h('div', { class: 'inline', style: 'flex-wrap:wrap;margin-top:10px' },
            h('button', {
              class: `btn sm ${draft.clips[sel]?.mute ? '' : 'ghost'}`,
              title: '这一段不要声音（台词和音效都不混），画面照留',
              onclick: () => { mark(); setClip(sel, { mute: !draft.clips[sel]?.mute }); done(); }
            }, draft.clips[sel]?.mute ? '🔇 已静音' : '🔊 有声'),
            h('button', {
              class: 'btn ghost sm',
              title: '这一段不进成片。素材不删，随时能从左边放回来',
              onclick: () => { mark(); setClip(sel, { off: !draft.clips[sel]?.off }); done(); }
            }, draft.clips[sel]?.off ? '放回来' : '不用这一段'),
            h('button', {
              class: 'btn ghost sm',
              title: '把这一段的入出点清掉，交回给自动剪辑',
              onclick: () => { mark(); setClip(sel, { in: null, out: null }); done(); }
            }, '还原裁剪'),
            h('button', {
              class: 'btn ghost sm',
              title: '把这一段拉到素材的完整长度（能拉多长由素材决定）',
              onclick: () => { mark(); setClip(sel, { in: 0, out: Number(total.toFixed(2)) }); done(); }
            }, '拉满整段'))
        );
      }

      // ───────────── 工具条 ─────────────
      function paintBar() {
        clear(barBox);
        const rs = rowsOf();
        const tot = totalOf(rs);
        clock.textContent = `${fmt(playAt)} / ${fmt(tot)}`;
        barBox.append(
          h('button', { class: 'btn ghost sm', title: '撤销（上一步剪辑）', disabled: !past.length, onclick: undoStep }, '↩ 撤销'),
          h('button', { class: 'btn ghost sm', title: '重做', disabled: !future.length, onclick: redoStep }, '↪ 重做'),
          h('span', { class: 'tl-sep' }),
          h('button', {
            class: 'btn ghost sm tl-cut',
            title: '在播放头这一刀把选中的片段切成两段（两段各有各的入出点、转场和效果）',
            disabled: !canSplit(),
            onclick: splitHere
          }, '✂ 分割'),
          h('button', {
            class: 'btn ghost sm tl-del',
            title: '把选中的片段从时间线上拿掉（素材不删，左边素材架里还能放回来）',
            disabled: !sel,
            onclick: deleteSel
          }, '🗑 删除'),
          h('span', { class: 'tl-sep' }),
          h('button', { class: 'btn primary sm tl-play', title: '播放 / 暂停（按剪辑后的顺序播）', onclick: () => togglePlay() }, playing ? '⏸' : '▶'),
          h('button', { class: 'btn ghost sm', title: '回到开头', onclick: () => seek(0, { play: false }) }, '⏮'),
          clock,
          h('span', { class: 'tl-sep' }),
          h('button', { class: 'btn ghost sm', title: '时间线缩小', onclick: () => { pps = Math.max(6, pps / 1.5); paintLanes(); } }, '－'),
          h('span', { class: 'field-hint', style: 'margin:0;min-width:52px;text-align:center' }, `${pps.toFixed(0)} px/s`),
          h('button', { class: 'btn ghost sm', title: '时间线放大', onclick: () => { pps = Math.min(400, pps * 1.5); paintLanes(); } }, '＋'),
          h('button', { class: 'btn ghost sm', title: '整条片子铺满这一屏', onclick: () => { fitted = false; paintLanes(); } }, '适应窗口')
        );
      }

      // ───────────── 轨道 ─────────────
      function paintLanes() {
        const rs = rowsOf();
        const tot = totalOf(rs);
        if (!fitted && tot > 0) {
          const room = Math.max(320, (scrollBox.clientWidth || 900) - 24);
          pps = Math.max(6, Math.min(200, room / tot));
          fitted = true;
        }
        const W = Math.max(240, tot * pps + 24);

        clear(labelsBox);
        clear(laneBox);
        laneBox.style.width = `${W}px`;

        // ── 刻度 ──
        const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((x) => x * pps >= 56) || 60;
        const ruler = h('div', { class: 'tl-ruler', style: `height:${H.ruler}px` });
        for (let t = 0; t <= tot + 0.001; t += step) {
          ruler.append(h('div', { class: 'tl-tick', style: `left:${t * pps}px` },
            h('span', {}, t >= 60 ? fmt(t) : `${Number(t.toFixed(2))}s`)));
        }
        ruler.addEventListener('pointerdown', (e) => {
          const r = ruler.getBoundingClientRect();
          seek((e.clientX - r.left) / pps, { play: false });
        });
        labelsBox.append(h('div', { class: 'tl-lab', style: `height:${H.ruler}px` }));
        laneBox.append(ruler);

        // ── 画面轨 ──
        const lane = h('div', { class: 'tl-lane', style: `height:${H.video}px` });
        labelsBox.append(h('div', { class: 'tl-lab', style: `height:${H.video}px` },
          h('b', {}, '画面'),
          h('span', { class: 'field-hint', style: 'margin:0' }, `${rs.length} 段`)));

        rs.forEach((r, i) => {
          const s = r.shot;
          const block = h('div', {
            class: `tl-clip${sel === r.key ? ' on' : ''}${r.muted ? ' muted' : ''}`,
            'data-shot': r.key,
            style: `left:${r.start * pps}px;width:${Math.max(8, r.span * pps)}px`
              + (s.imagePath ? `;background-image:url(${mediaUrl(s.imagePath)})` : ''),
            title: `第 ${s.index} 镜 · ${r.span.toFixed(2)}s（素材 ${r.total.toFixed(2)}s）\n拖中间换位置，拖两端裁剪`
          },
          h('span', { class: 'tl-tag' }, `#${s.index}${String(r.key).includes('#') ? `·${String(r.key).split('#')[1]}` : ''}`,
            r.fx !== 'none' ? h('i', { class: 'tl-chip', title: FX.labelOf(r.fx) }, '效') : null,
            r.muted ? h('i', { class: 'tl-chip' }, '静') : null),
          h('span', { class: 'tl-len' }, `${r.span.toFixed(1)}s`),
          h('div', { class: 'tl-trim l', title: '拖：改入点' }),
          h('div', { class: 'tl-trim r', title: '拖：改出点' }));

          // 转场标记摆在接缝上 —— 它属于"两段之间"，不属于任何一段
          if (i > 0 && r.trans !== 'cut') {
            lane.append(h('div', {
              class: 'tl-trans',
              style: `left:${r.start * pps}px`,
              title: `${TRANS.defOf(r.trans).label}：${TRANS.defOf(r.trans).why}`
            }, TRANS.defOf(r.trans).label.slice(0, 2)));
          }
          wireClip(block, r, rs);
          lane.append(block);
        });
        lane.append(h('div', { class: 'tl-drop', style: 'display:none' }));
        laneBox.append(lane);

        // ── 声音三轨 ──
        const audioLane = (name, key, blocks, hint) => {
          const on = EDIT.trackOn(draft, key);
          labelsBox.append(h('div', { class: `tl-lab${on ? '' : ' off'}`, style: `height:${H.audio}px` },
            h('span', {}, name),
            h('button', {
              class: 'tl-eye',
              title: on ? `关掉${name}这条轨（这次不混进去，文件不删）` : `打开${name}`,
              onclick: () => {
                mark();
                if (on) draft.tracks[key] = false; else delete draft.tracks[key];
                done();
              }
            }, on ? '👁' : '🚫')));
          const el = h('div', { class: `tl-lane audio${on ? '' : ' off'}`, style: `height:${H.audio}px`, title: hint });
          for (const b of blocks) {
            el.append(h('div', {
              class: `tl-ab ${b.cls}`,
              style: `left:${b.at * pps}px;width:${Math.max(3, b.len * pps)}px`,
              title: b.title
            }, b.text || ''));
          }
          laneBox.append(el);
        };

        audioLane('台词', 'voice',
          rs.filter((r) => r.shot.audioPath).map((r) => {
            const spoken = Math.min(r.span, DUR.speechSeconds(r.shot.dialogue) || r.span);
            return {
              at: r.start, len: spoken, cls: `voice${r.muted ? ' off' : ''}`,
              title: `第 ${r.shot.index} 镜的配音${r.muted ? '（这一镜标了静音，不混）' : ''}`,
              text: (r.shot.dialogue || '').slice(0, 12)
            };
          }),
          '每一镜的配音摆在它那一镜的起点上 —— 长度是按台词字数估的，实际以合成为准');

        audioLane('音效', 'sfx',
          rs.filter((r) => r.shot.sfxPath).map((r) => ({
            at: r.start, len: r.span, cls: `sfx${r.muted ? ' off' : ''}`,
            title: `第 ${r.shot.index} 镜的画外音效${r.muted ? '（静音）' : ''}`
          })),
          '画外音效。音量压在台词底下 —— 等响的话一声关门就能盖掉一句台词');

        const music = draft.music;
        audioLane('背景音乐', 'music',
          music ? [{
            at: 0, len: tot, cls: 'music',
            title: `${music.name || '背景音乐'}${music.duck !== false ? '（有台词时自动压低）' : ''}`,
            text: music.name || '背景音乐'
          }] : [],
          music ? '整片一条，不够长会循环' : '还没配乐，下面可以选一首');

        // ── 播放头 ──
        head.style.height = `${H.ruler + H.video + H.audio * 3}px`;
        laneBox.append(head);
        movePlayhead(false);

        paintBar();
      }

      /**
       * 剪刀和删除**能不能按，是跟着播放头和选中项走的**。
       *
       * 只在重画工具条时算一次的话，人拖完播放头看到的还是"灰的" ——
       * 而这时候明明已经可以切了。走查里就是这么红的：点了片段、把播放头
       * 拖到中间，剪刀还是按不下去。
       */
      function syncTools() {
        const cut = host.querySelector('.tl-cut');
        if (cut) cut.disabled = !canSplit();
        const del = host.querySelector('.tl-del');
        if (del) del.disabled = !sel;
      }

      function movePlayhead(scrollTo = true) {
        head.style.left = `${playAt * pps}px`;
        clock.textContent = `${fmt(playAt)} / ${fmt(totalOf(rowsOf()))}`;
        syncTools();
        if (!scrollTo) return;
        const x = playAt * pps;
        const view = scrollBox.scrollLeft;
        const w = scrollBox.clientWidth;
        if (x < view + 40 || x > view + w - 40) scrollBox.scrollLeft = Math.max(0, x - w / 2);
      }

      /**
       * 一段片子上的三种拖动：左边缘改入点、右边缘改出点、中间换位置。
       *
       * 全部走指针事件，**不用 HTML5 的 draggable** —— 那一套拖起来会带一张
       * 半透明的元素截图，而且在有输入框的容器里很容易和选中文字打架。
       * 自己做还能在拖的过程中实时重画时间线：拖到哪儿、后面几段跟着挪多少，
       * 一眼就看得见，而这正是"时间线"比"清单"强的地方。
       */
      function wireClip(block, row, rs) {
        const s = row.shot;
        const key = row.key;
        block.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          sel = key;
          paintShelf();
          paintProps();
          syncTools();

          const box = block.getBoundingClientRect();
          const edge = e.clientX - box.left < 10 ? 'l' : box.right - e.clientX < 10 ? 'r' : null;
          /**
           * ⚠ 拖之前就要把"拖之前那份"压进撤销栈。
           *
           * 拖动过程中会改很多次（每移动一像素改一次），只能记**一格**：
           * 记成几十格的话，人得点几十下「撤销」才退得回去一次拖动。
           * 而如果等松手了再 mark()，压进去的已经是改完的那份 —— 撤销等于没用。
           */
          let marked = false;
          const total = row.total;
          const startIn = row.win ? row.win.in : 0;
          const startOut = row.win ? row.win.out : total;
          const x0 = e.clientX;
          let moved = false;
          let dropAt = rs.indexOf(row);

          const marker = laneBox.querySelector('.tl-drop');

          const onMove = (ev) => {
            const dx = ev.clientX - x0;
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) { mark(); marked = true; }
            moved = true;
            if (edge) {
              // ── 裁剪 ──
              const d = dx / pps;
              if (edge === 'l') {
                const v = Math.max(0, Math.min(startIn + d, startOut - 0.3));
                setClip(key, { in: Number(v.toFixed(2)), out: Number(startOut.toFixed(2)) });
              } else {
                // 往右拉最多到素材本身的长度 —— 再长就得靠定格补帧，那是另一回事
                const v = Math.min(total || (startOut + d), Math.max(startOut + d, startIn + 0.3));
                setClip(key, { in: Number(startIn.toFixed(2)), out: Number(v.toFixed(2)) });
              }
              paintLanes();
              paintProps();
              return;
            }
            // ── 换位置 ──
            const laneRect = laneBox.getBoundingClientRect();
            const x = ev.clientX - laneRect.left;
            const cur = rowsOf();
            let idx = cur.length;
            for (let k = 0; k < cur.length; k += 1) {
              if (x < (cur[k].start + cur[k].span / 2) * pps) { idx = k; break; }
            }
            dropAt = idx;
            if (marker) {
              marker.style.display = '';
              marker.style.left = `${(idx >= cur.length ? tailX(cur) : cur[idx].start) * pps}px`;
            }
            block.classList.add('dragging');
          };

          const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            block.classList.remove('dragging');
            if (marker) marker.style.display = 'none';
            if (!moved) {
              // 没拖动 = 只是点了一下：选中它，顺便把播放头挪过来看一眼
              seek(row.start, { play: false });
              paintLanes();
              return;
            }
            if (edge) { done(); return; }
            const from = draft.order.indexOf(key);
            const visible = rowsOf().map((r) => r.key);
            const target = dropAt >= visible.length
              ? draft.order.length
              : draft.order.indexOf(visible[dropAt]);
            let to = target > from ? target - 1 : target;
            if (to === from) { paintLanes(); return; }
            if (!marked) mark();
            const next = draft.order.slice();
            next.splice(from, 1);
            next.splice(Math.max(0, Math.min(to, next.length)), 0, key);
            draft.order = next;
            done();
          };

          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
        });
      }

      const tailX = (rs) => (rs.length ? rs[rs.length - 1].start + rs[rs.length - 1].span : 0);

      // 拖播放头
      head.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const move = (ev) => {
          const r = laneBox.getBoundingClientRect();
          seek((ev.clientX - r.left) / pps, { play: false });
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });

      // ───────────── 声音那一排设置 ─────────────
      /**
       * 三条轨的开关做在轨道名上（那是它该在的地方）。这一排放的是
       * **调出来才知道对不对**的那几个数：音效音量、音乐音量、避让、响度。
       */
      function paintAudioBar() {
        clear(audioBox);
        const putSetting = async (patch) => {
          try {
            await api('/settings', { method: 'POST', body: patch });
            Object.assign(settings, patch);
            if (state.catalog?.settings) Object.assign(state.catalog.settings, patch);
          } catch (err) { toast(err.message, 'err'); }
        };

        const sfxPct = h('span', { class: 'field-hint', style: 'margin:0;width:38px' },
          `${Math.round((settings.sfxGain ?? 0.35) * 100)}%`);
        const sfxRange = h('input', {
          type: 'range', min: '0', max: '1', step: '0.05',
          value: String(settings.sfxGain ?? 0.35),
          oninput: (e) => { sfxPct.textContent = `${Math.round(Number(e.target.value) * 100)}%`; },
          onchange: (e) => putSetting({ sfxGain: Number(e.target.value) })
        });

        const musicInput = h('input', {
          type: 'file',
          accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/flac,audio/ogg,.mp3,.m4a,.wav,.flac,.ogg',
          style: 'display:none',
          onchange: async () => {
            const file = musicInput.files?.[0];
            if (!file) return;
            pickBtn.disabled = true;
            const label = pickBtn.textContent;
            pickBtn.textContent = '读取中…';
            try {
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => reject(new Error('这个文件读不出来'));
                fr.readAsDataURL(file);
              });
              pickBtn.textContent = '上传中…';
              let err = null;
              // cap:film-music
              await stream(`/projects/${project.id}/music`, { dataUrl, fileName: file.name }, (ev) => {
                if (ev.type === 'finished' && ev.project) {
                  project.edit = ev.project.edit;
                  draft.music = ev.project.edit?.music ? { ...ev.project.edit.music } : null;
                  delete draft.tracks.music;
                  baseline = JSON.stringify(draft);
                }
                if (ev.type === 'error') err = ev.message;
              });
              if (err) throw new Error(err);
              toast('背景音乐就位。调好音量点「重新合成」，十几秒出片，不花钱', 'ok');
              paintAll();
            } catch (e) {
              toast(e.message, 'err');
            } finally {
              musicInput.value = '';
              pickBtn.disabled = false;
              pickBtn.textContent = label;
            }
          }
        });
        const pickBtn = h('button', {
          class: 'btn sm',
          title: '自己的音乐文件（MP3 / M4A / WAV / FLAC / OGG，20MB 以内）',
          onclick: () => musicInput.click()
        }, draft.music ? '换一首' : '选一首本地音乐');

        const rows = [
          h('div', { class: 'cut-track' },
            h('span', { class: 'cut-name' }, '音效音量'), sfxRange, sfxPct,
            h('span', { class: 'field-hint', style: 'margin:0' },
              '压在台词底下（等响的话一声关门就能盖掉一句台词）。调 0 = 这次不混音效'),
            h('span', { class: 'tl-sep' }),
            h('label', { class: 'inline', style: 'gap:5px;margin:0' },
              h('input', {
                type: 'checkbox',
                checked: settings.loudness !== false,
                onchange: (e) => putSetting({ loudness: e.target.checked })
              }),
              h('span', { class: 'field-hint', style: 'margin:0' }, '统一响度（−16 LUFS）')))
        ];

        if (draft.music) {
          const setMusic = (patch) => { mark(); draft.music = { ...draft.music, ...patch }; done(); };
          const gainPct = h('span', { class: 'field-hint', style: 'margin:0;width:38px' },
            `${Math.round((draft.music.gain ?? 0.22) * 100)}%`);
          const chk = (key, label, hint) => h('label', { class: 'inline', style: 'gap:5px;margin:0', title: hint },
            h('input', {
              type: 'checkbox',
              checked: draft.music[key] !== false,
              onchange: (e) => setMusic({ [key]: e.target.checked })
            }), h('span', { class: 'field-hint', style: 'margin:0' }, label));
          rows.push(h('div', { class: 'cut-track' },
            h('span', { class: 'cut-name' }, '音乐'),
            h('span', { class: 'field-hint', style: 'margin:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
              `♪ ${draft.music.name || '未命名'}`),
            h('input', {
              type: 'range', min: '0', max: '0.8', step: '0.02',
              value: String(draft.music.gain ?? 0.22),
              oninput: (e) => { gainPct.textContent = `${Math.round(Number(e.target.value) * 100)}%`; },
              onchange: (e) => setMusic({ gain: Number(e.target.value) })
            }), gainPct,
            chk('duck', '说话时自动压低',
              '广播和影视里的标准做法：有人说话音乐自动让开，说完自己回来。这一条打开和不打开，是"专业"和"自己拿剪映拼的"之间差别最大的一处'),
            chk('loop', '不够长就循环', '曲子比片子短时接着从头放'),
            h('span', { class: 'field-hint', style: 'margin:0' }, '淡入'),
            h('input', {
              type: 'number', min: '0', max: '10', step: '0.5', style: 'width:60px',
              value: String(draft.music.fadeIn ?? 1.5),
              onchange: (e) => setMusic({ fadeIn: Number(e.target.value) })
            }),
            h('span', { class: 'field-hint', style: 'margin:0' }, '淡出'),
            h('input', {
              type: 'number', min: '0', max: '20', step: '0.5', style: 'width:60px',
              value: String(draft.music.fadeOut ?? 2.5),
              onchange: (e) => setMusic({ fadeOut: Number(e.target.value) })
            }),
            pickBtn, musicInput,
            h('button', {
              class: 'btn ghost sm',
              title: '撤下这首（文件不删，重新选还找得着）',
              onclick: async () => {
                try {
                  const p = await api(`/projects/${project.id}/music`, { method: 'DELETE' });
                  project.edit = p.edit;
                  mark();
                  draft.music = null;
                  done();
                  toast('已撤下背景音乐', 'ok');
                } catch (err) { toast(err.message, 'err'); }
              }
            }, '移除')));
          rows.push(h('p', { class: 'field-hint', style: 'margin:6px 0 0' },
            '⚠ 曲子的授权要你自己确认。这个应用不内置也不下载任何曲库 —— 那些文件的授权我们无从核实，而侵权的后果会落在你头上。'));
        } else {
          rows.push(h('div', { class: 'cut-track' },
            h('span', { class: 'cut-name' }, '背景音乐'),
            h('span', { class: 'field-hint', style: 'margin:0' }, '还没配乐'),
            pickBtn, musicInput));
        }
        audioBox.append(...rows);
      }

      // ───────────── 底部 ─────────────
      function paintFoot() {
        clear(footBox);
        const rs = rowsOf();
        footBox.append(
          h('button', {
            class: 'btn primary',
            /**
             * ⚠ 这里原来写的是 `run('compose', …)` —— 而这个文件里**根本没有 run**。
             *
             * 后果是点下去抛一个 ReferenceError，界面纹丝不动：
             * 用户报上来的原话就是"重新合成这个按钮按不动"。
             * 而走查一直是绿的，因为它从没点过这颗按钮（点了会真去合成）。
             * 现在点它，并且量"有没有真的发出那一次请求"。
             */
            onclick: async () => { stopPlay(); await save(); runStage('compose'); }
          }, '重新合成（不花钱）'),
          h('button', {
            class: 'btn ghost',
            title: '把顺序、入出点、跳过、转场、效果、静音全部清掉，回到自动剪辑的结果。背景音乐和音轨开关不动',
            onclick: async () => {
              mark();
              draft.order = natural.slice();
              draft.clips = {};
              done();
              toast('片段这一块已恢复成自动剪辑的结果（音乐和音轨开关没动）', 'ok');
            }
          }, '恢复默认'),
          h('span', { class: 'field-hint cut-total', style: 'margin:0' },
            `用 ${rs.length} / ${clips.length} 镜，约 ${totalOf(rs).toFixed(1)} 秒`
            + '（重叠类转场会各吃掉 0.5 秒，成片以合成结果为准）')
        );
      }

      function paintAll() {
        paintShelf();
        paintProps();
        paintLanes();
        paintAudioBar();
        paintFoot();
      }

      host.append(
        h('h2', { class: 'panel-title' }, '剪辑台'),
        h('p', { class: 'panel-hint' },
          '拖片段换位置、拖两端裁剪、点▶就地看 —— 改完点下面「重新合成」，',
          h('b', {}, '十几秒出片，一分钱不花'),
          '（不重新生成任何素材）。配音和字幕会跟着一起挪。'),
        h('div', { class: 'tl-top' },
          shelfBox,
          h('div', { class: 'tl-stage' }, video,
            h('p', { class: 'field-hint', style: 'margin:6px 0 0' },
              '预览是按剪辑后的顺序逐段播原始素材，配音、音效、音乐都跟着放。',
              h('b', {}, '它不等于成片'),
              '：音乐给台词让路（自动避让）和转场是合成那一步做的，这里听不到；镜与镜之间会有一次很短的加载停顿。')),
          propsBox),
        barBox,
        h('div', { class: 'tl-wrap' }, labelsBox, scrollBox),
        audioBox,
        footBox
      );

      paintAll();
      // 首屏要等布局出来才知道一屏有多宽，宽度为 0 时算出来的 pps 是废的
      requestAnimationFrame(() => { fitted = false; paintLanes(); });
      return host;
    }

    /**
     * 一步只显示这一步的东西。
     *
     * 这是这次改版的核心：早先所有面板一起铺在页面上，从剧本一路滚到分镜网格。
     * 现在流水线在左边菜单里，右边只留当前这一步 —— 少滚三屏。
     */
    /**
     * 设定集直接挂在这一步里，不再单开一个菜单项。
     *
     * 它本来就是流水线的第 02 步 —— 独立成页之后，"跑设定集"在创作台、
     * "看/改设定集"在另一页，同一件事被拆成两个地方，来回跳。
     *
     * 懒挂：只有真的切到这一步才渲染。设定集页要拉几十张图，
     * 每次打开创作台都渲染一遍纯属浪费。
     */
    const biblePanel = h('div', { style: 'display:none' });
    let bibleMounted = false;
    let bibleTimer = null;

    /**
     * 让设定集面板跟上最新的盘上数据。
     *
     * 防抖是必要的：出设定图时事件一条接一条来，每条都重挂一次的话，
     * 面板会一直闪，还会把你刚展开的那个条目收回去。
     */
    function remountBible({ delay = 0 } = {}) {
      if (!bibleMounted) return;
      clearTimeout(bibleTimer);
      bibleTimer = setTimeout(() => {
        mountBible();
        /**
         * 场地图跟着一起刷新。
         *
         * 新加一个场景之后，「摆上来」那一排里必须有它 —— 而它就在同一页
         * 上面几厘米的地方列着。不刷的话用户会以为"这个场景不能摆到图上"。
         *
         * ⚠ 只重画、不重建：重建会把画布的平移缩放位置一起清掉，
         * 而人可能正拖到一半。
         */
        sitePanelApi?.render();
      }, delay);
    }

    async function mountBible() {
      try {
        const node = await bibleView.render({ state, go, rerender: mountBible });
        clear(biblePanel).append(node);
      } catch (err) {
        clear(biblePanel).append(h('div', { class: 'empty' }, h('b', {}, '设定集没能打开'), err.message));
      }
    }

    /**
     * ── 场地图 ──
     *
     * 摆在设定集这一步，因为它整理的是**场景之间的关系** —— 而场景就在这一页定义。
     *
     * 排位画布解决"一个场景内部"，场景布局解决"同一个场景反复回来"，
     * 这一块解决"两个不同的场景"：大殿在山门外的北边三十米、
     * 这片山坡上只有一个太阳。前两层都看不见这件事，
     * 因为它们一次只看得见一个场景。
     */
    /**
     * ── 大纲：剧本和分镜之间那一层 ──
     *
     * 分镜表是个很坏的对话对象：二十镜、每镜六七个字段，想说"第三场太拖了"
     * 得手工改十几行；让模型重跑一次，它会把已经审过的镜全换掉。
     *
     * 大纲是十来行、一行一场戏。在这个粒度上改是一句话的事。
     *
     * ⚠ 模型回的是**改动指令**，不是新大纲。界面把每条摊开让人逐条勾 ——
     * 没勾的一条都不动。"模型建议"和"实际改动"是两件事。
     */
    const outlinePanel = h('div', { class: 'panel' });
    {
      const listHost = h('div', { class: 'ob-list' });
      const sumLine = h('div', { class: 'ob-sum' });
      const budgetHost = h('div', {});
      const chatHost = h('div', { class: 'ob-chat' });

      const paintOutline = () => {
        clear(listHost); clear(budgetHost);
        const o = OUTLINE.normalizeOutline(project.outline);
        sumLine.textContent = OUTLINE.summarize(project.outline, project.targetDuration);
        if (!o.beats.length) {
          listHost.append(h('div', { class: 'ob-empty' },
            '还没有大纲。先生成一份 —— 十来行、一行一场戏，改顺了再拆分镜。',
            h('br'),
            '在这一层改比在分镜表上改省事得多，而且拆出来的分镜是你已经同意过的。'));
          return;
        }
        for (const [i, b] of o.beats.entries()) {
          const est = OUTLINE.estimateSeconds(b);
          const secs = h('input', {
            type: 'number', class: 'ob-secs', value: String(est.suggested), min: '1',
            title: est.floor ? `台词念完至少要 ${est.floor} 秒` : '这一场没有台词'
          });
          secs.onchange = async () => {
            try {
              // cap:outline
              const r = await api(`/projects/${project.id}/outline/beat/${b.id}`, {
                method: 'PATCH', body: { seconds: Number(secs.value) }
              });
              project.outline = r.project.outline;
              paintOutline();
            } catch (err) { toast(err.message, 'err'); }
          };
          /**
           * ── 自己动手改这一场 ──
           *
           * ⚠ 这一条原来是**缺的**：面板上只有秒数是输入框，场景名、内容、
           * 台词都只能跟模型商量着改。而后端白名单里这几样全都支持 ——
           * 接口有、界面没接。
           *
           * 跟模型来回三轮，不如自己敲两个字。何况改台词直接影响
           * "念得完念不完"那条硬下限，那是要当场看见的。
           *
           * 锁着的场次不给这颗按钮：它们改不动（applyOps 会拒），
           * 摆一个点了就报错的按钮比不摆更糟。
           */
          const editBtn = b.locked ? null : h('button', { class: 'btn ghost sm', title: '自己改这一场' }, '改');
          if (editBtn) {
            editBtn.onclick = () => {
              const f = {
                scene: h('input', { type: 'text', value: b.scene, placeholder: '场景名' }),
                time: h('input', { type: 'text', value: b.time, placeholder: '白天 / 夜' }),
                characters: h('input', { type: 'text', value: b.characters.join('、'), placeholder: '人物，逗号分隔' }),
                summary: h('textarea', { rows: 2, placeholder: '这一场发生了什么' }, b.summary),
                dialogue: h('textarea', { rows: 2, placeholder: '这一场真正要念出来的台词，原样抄' }, b.dialogue)
              };
              const live = h('div', { class: 'field-hint' });
              const refreshLive = () => {
                const est2 = OUTLINE.estimateSeconds({ ...b, summary: f.summary.value, dialogue: f.dialogue.value });
                live.textContent = est2.floor
                  ? `台词念完要 ${est2.floor} 秒 —— 这一场至少得这么长`
                  : '这一场没有台词';
              };
              f.dialogue.oninput = refreshLive;
              refreshLive();
              const save = h('button', { class: 'btn sm' }, '存这一场');
              const cancel = h('button', { class: 'btn ghost sm' }, '取消');
              const box = h('div', { class: 'ob-edit' },
                h('div', { class: 'ob-edit-grid' },
                  h('div', {}, h('label', {}, '场景'), f.scene),
                  h('div', {}, h('label', {}, '时间'), f.time),
                  h('div', {}, h('label', {}, '人物'), f.characters)),
                h('label', {}, '内容'), f.summary,
                h('label', {}, '台词'), f.dialogue, live,
                h('div', { class: 'inline', style: 'margin-top:8px' }, save, cancel));
              cancel.onclick = () => box.remove();
              save.onclick = async () => {
                save.disabled = true;
                try {
                  // cap:outline
                  const r = await api(`/projects/${project.id}/outline/beat/${b.id}`, {
                    method: 'PATCH',
                    body: {
                      scene: f.scene.value, time: f.time.value,
                      characters: f.characters.value, summary: f.summary.value, dialogue: f.dialogue.value
                    }
                  });
                  project.outline = r.project.outline;
                  paintOutline();
                  toast(r.refused?.length ? `没改成：${r.refused[0].why}` : '存好了', r.refused?.length ? 'err' : 'ok');
                } catch (err) { toast(err.message, 'err'); } finally { save.disabled = false; }
              };
              row.after(box);
              f.scene.focus();
            };
          }

          const row = h('div', { class: `ob-row${b.locked ? ' locked' : ''}` },
            h('span', { class: 'ob-n' }, String(i + 1)),
            h('span', { class: 'ob-scene' }, b.scene || '（未定）'),
            h('span', { class: 'ob-when' }, [b.time, b.characters.join('、')].filter(Boolean).join(' · ')),
            h('span', { class: 'ob-sumtext' }, b.summary),
            secs,
            h('span', { class: 'ob-unit' }, '秒'),
            // 台词念完的硬下限单独标出来：它和"节奏偏长"是完全不同的两件事
            est.floor ? h('span', { class: 'ob-floor', title: '台词念完至少要这么长，压不下去' }, `台词 ${est.floor}s`) : '',
            b.locked ? (() => {
              /**
               * 锁着的那几场给一条出口：解锁重拆。
               *
               * ⚠ 确认框里必须说**会作废几镜**。只说"确定解锁吗"，
               * 人不知道自己在放弃什么 —— 而放弃的是已经花过钱的图。
               */
              const un = h('button', {
                class: 'btn ghost sm', title: '解锁之后重拆这一场，已经出好的图会作废'
              }, '锁·解锁重拆');
              un.onclick = async () => {
                un.disabled = true;
                try {
                  // cap:outline-revise
                  const r = await api(`/projects/${project.id}/outline/unlock`, {
                    method: 'POST', body: { ids: [b.id] }
                  });
                  project.outline = r.project.outline;
                  paintOutline();
                  toast(r.willDrop
                    ? `已解锁。重拆这一场会作废 ${r.willDrop} 镜已经出好的图`
                    : '已解锁，这一场还没有出过图', 'ok');
                } catch (err) { toast(err.message, 'err'); } finally { un.disabled = false; }
              };
              return un;
            })() : (editBtn || ''));
          listHost.append(row);
        }

        /**
         * ── 还没拆分镜的那几场 ──
         *
         * 在大纲里插一场之后，如果没有一句话告诉你"有 1 场还没拆分镜"，
         * 那一场就会一直躺在那儿：功能是好的（再点一次分镜就会拆它），
         * 但没人知道该去点。
         *
         * 拆分镜要跑几十秒，而人这时候多半正看着大纲 —— 边跑边插一场
         * 是很自然的动作，所以这条提示很常用得上。
         */
        const pend = OUTLINE.pendingBeats(project.outline);
        const anyLocked = o.beats.some((b) => b.locked);
        if (pend.length && anyLocked) {
          const go = h('button', { class: 'btn primary sm', disabled: jobBusy() },
            `拆这 ${pend.length} 场的分镜`);
          go.onclick = () => runStage('script');
          budgetHost.append(h('div', { class: 'ob-pending' },
            h('b', {}, `有 ${pend.length} 场还没拆分镜`),
            h('span', {}, `：${pend.map((b) => b.scene || b.id).join('、')}。`
              + '已经拆过的那几场不会被动 —— 只拆这几场。'),
            go));
        }

        const bud = OUTLINE.budgetCheck(project.outline, project.targetDuration);
        for (const one of bud?.issues || []) {
          budgetHost.append(h('div', { class: `ob-issue ${one.kind === 'floor-over' ? 'hard' : ''}` },
            h('b', {}, one.what), h('div', { class: 'ob-why' }, one.why), h('div', { class: 'ob-fix' }, one.fix)));
        }
      };

      const buildBtn = h('button', { class: 'btn' }, '从剧本生成大纲');
      buildBtn.onclick = async () => {
        const o = OUTLINE.normalizeOutline(project.outline);
        if (o.beats.length && !confirm('重新生成会按当前剧本重排场次。已经拆过分镜的那几场（标着「锁」的）会原样留下。继续？')) return;
        buildBtn.disabled = true;
        const old = buildBtn.textContent;
        buildBtn.textContent = '拆场次中…';
        try {
          // cap:outline
          await stream(`/projects/${project.id}/outline/build`, {}, (ev) => {
            if (ev.type === 'stage' && ev.message) sumLine.textContent = ev.message;
            if (ev.type === 'error') toast(ev.message, 'err');
            if (ev.type === 'finished') {
              project.outline = ev.project?.outline || project.outline;
              paintOutline();
              toast('大纲出来了 —— 改顺了再拆分镜', 'ok');
            }
          });
        } catch (err) { toast(err.message, 'err'); } finally {
          buildBtn.disabled = false;
          buildBtn.textContent = old;
        }
      };

      /**
       * ── 说一句，看它想怎么改 ──
       *
       * 模型回的每一条都摊开成一个勾选框，并且**写清楚改之前是什么**。
       * 只说"第 3 场改成 2 分钟"，人没法判断该不该勾；
       * 说"3 分钟 → 2 分钟"才行。
       */
      const say = h('input', { type: 'text', class: 'ob-say', placeholder: '想怎么改？比如「第 2 场太拖了，砍一半」「在开头加一场雪夜追逐」' });
      const askBtn = h('button', { class: 'btn primary' }, '让它想想');
      const paintOps = (r) => {
        clear(chatHost);
        if (!r.preview?.length) {
          chatHost.append(h('div', { class: 'ob-note' }, r.note || '它没想出要改什么。把要求说具体一点试试。'));
          return;
        }
        if (r.note) chatHost.append(h('div', { class: 'ob-note' }, r.note));
        const boxes = [];
        for (const one of r.preview) {
          const cb = h('input', { type: 'checkbox' });
          cb.checked = !one.refused;
          cb.disabled = Boolean(one.refused);
          boxes.push({ cb, op: one.op });
          chatHost.append(h('label', { class: `ob-op${one.refused ? ' refused' : ''}` },
            cb,
            h('span', {}, one.text),
            // 注定被拒的当场标出来 —— 让人勾了再发现没生效，他会以为按钮坏了
            one.refused ? h('span', { class: 'ob-refused' }, `（做不了：${one.refused}）`) : ''));
        }
        const apply = h('button', { class: 'btn' }, '应用勾中的');
        apply.onclick = async () => {
          const ops = boxes.filter((x) => x.cb.checked).map((x) => x.op);
          if (!ops.length) { toast('一条都没勾', 'err'); return; }
          apply.disabled = true;
          try {
            // cap:outline-revise
            const res = await api(`/projects/${project.id}/outline/apply`, { method: 'POST', body: { ops } });
            project.outline = res.project.outline;
            paintOutline();
            clear(chatHost);
            toast(res.refused?.length
              ? `改了 ${res.applied} 条，${res.refused.length} 条没做：${res.refused[0].why}`
              : `改了 ${res.applied} 条`, 'ok');
          } catch (err) { toast(err.message, 'err'); } finally { apply.disabled = false; }
        };
        const drop = h('button', { class: 'btn ghost' }, '算了');
        drop.onclick = () => clear(chatHost);
        chatHost.append(h('div', { class: 'inline', style: 'margin-top:10px' }, apply, drop));
      };
      askBtn.onclick = async () => {
        if (!say.value.trim()) { toast('想改什么？说一句', 'err'); return; }
        askBtn.disabled = true;
        const old = askBtn.textContent;
        askBtn.textContent = '想…';
        try {
          // cap:outline-revise
          const r = await api(`/projects/${project.id}/outline/revise`, {
            method: 'POST', body: { instruction: say.value }
          });
          paintOps(r);
        } catch (err) { toast(err.message, 'err'); } finally {
          askBtn.disabled = false;
          askBtn.textContent = old;
        }
      };
      say.onkeydown = (e) => { if (e.key === 'Enter') askBtn.click(); };

      outlinePanel.append(
        h('div', { class: 'panel-head' },
          h('b', {}, '大纲'),
          h('span', { class: 'muted' },
            '一行一场戏。在这一层改比在分镜表上改省事得多 —— 而且拆出来的分镜是你已经同意过的。'
            + '标着「锁」的是已经拆过分镜的，模型碰不到。')),
        h('div', { class: 'inline' }, buildBtn, sumLine),
        listHost,
        budgetHost,
        h('div', { class: 'inline', style: 'margin-top:12px' }, say, askBtn),
        chatHost
      );
      paintOutline();
    }

    /**
     * ── 补上新增的角色和场景 ──
     *
     * 剧本一章一章往里加时，第二章必然冒出第一章没有的人和地方。
     * 在这颗按钮之前，能做的只有两件事，两件都不对：
     *
     *   什么都不做   新角色永远不在设定集里，而且**不吭声** ——
     *                那一镜没有参考图、没有外貌描述、复核没有基准，
     *                静默降级成"文生图"，而流水线一路绿
     *   重新生成     整份重建，所有参考图清空重出。老角色白花一次钱，
     *                而且重出那张未必和之前一样 —— 观众对主角换脸最敏感
     *
     * 这颗按钮只做一件事：扫还没扫过的章 → 只给没见过的名字建条目、出图。
     */
    const extendHost = h('div', { class: 'panel' });
    {
      const btn = h('button', { class: 'btn' }, '补上新增的角色和场景');
      const log = h('div', { class: 'field-hint', style: 'margin-top:8px' });
      btn.onclick = async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '扫描中…';
        log.textContent = '';
        try {
          // cap:extend-bible
          await stream(`/projects/${project.id}/extend-bible`, {}, (ev) => {
            if (ev.type === 'note' || ev.type === 'stage') log.textContent = ev.message || '';
            if (ev.type === 'sheet' && ev.status === 'running') log.textContent = ev.message || '';
            if (ev.type === 'error') toast(ev.message, 'err');
            if (ev.type === 'finished') {
              project.bible = ev.project?.bible || project.bible;
              const summary = ev.added?.length
                ? `补了 ${ev.added.length} 条：${ev.added.map((a) => a.name).join('、')}。已有的一条都没动。`
                : '没有新的角色或场景 —— 这几章用的都是已有的设定。';
              log.textContent = summary;
              toast(summary, 'ok');
              /**
               * ⚠ 这里**不能** rerender()。
               *
               * 整页重画会把这块面板连同刚写上去的那句结果一起换掉 ——
               * 于是点完之后面板一片空白，只剩一个几秒就消失的浮条。
               * 人回头想确认"到底补了谁"，已经无处可看了。
               *
               * remountBible 只重挂设定集那一块（新条目要在列表里出现），
               * 碰不到这块面板。
               */
              remountBible();
            }
          });
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = old;
        }
      };
      extendHost.append(
        h('div', { class: 'panel-head' },
          h('b', {}, '剧本又加了新章？'),
          h('span', { class: 'muted' },
            '扫一遍还没扫过的章，只把**没见过的**角色和场景补进来。'
            + '已有的一条都不动、一张图都不重出 —— 所以主角不会换脸，也不会重复花钱。')),
        h('div', { class: 'inline' }, btn),
        log
      );
    }

    const sitePanelHost = h('div', { class: 'panel', style: 'display:none' });
    let siteMounted = false;
    // 建好之后留一个把手，设定集变了就叫它重画一遍（见 remountBible）
    let sitePanelApi = null;

    function mountSite() {
      clear(sitePanelHost);
      sitePanelApi = siteCanvasMod.sitePanel(project, {
          onAlign: async (name) => {
            try {
              // cap:site-map
              const p2 = await api(`/projects/${project.id}/site/apply`, {
                method: 'POST', body: { site: name }
              });
              project.bible = p2.project.bible;
              toast(p2.changed.length
                ? `已按场地图对齐 ${p2.changed.length} 个场景：${p2.changed.join('、')}`
                : '这几个场景本来就和场地图一致，没有要改的', 'ok');
            } catch (err) { toast(err.message, 'err'); }
          },
          onPlace: async (scene, place) => {
            try {
              // cap:site-map
              const p2 = await api(`/projects/${project.id}/scene-place`, {
                method: 'POST', body: { scene, place }
              });
              project.bible = p2.bible;
            } catch (err) { toast(err.message, 'err'); }
          },
          onSite: async (name, patch) => {
            try {
              // cap:site-map
              const p2 = await api(`/projects/${project.id}/site`, {
                method: 'POST', body: { site: name, ...patch }
              });
              project.bible = p2.bible;
            } catch (err) { toast(err.message, 'err'); }
          }
        });
      sitePanelHost.append(
        h('div', { class: 'panel-head' },
          h('b', {}, '场地图'),
          h('span', { class: 'muted' },
            '把同一个地方的几个场景摆到一张图上。滚轮缩放，拖空白平移。'
            + '外景尤其要摆 —— 一片山坡上的三场戏，太阳只有一个。')),
        sitePanelApi.node
      );
    }

    /**
     * 视频这一步只给一行**只读**的时长摘要。
     *
     * 时长的可改之处只有一个：分镜。它是拆镜时的预算，改它等于重排每一镜的秒数 ——
     * 在出完图之后的这一步摆一个"按目标重排时长"，等于邀请你把已经审过的分镜表推翻。
     * 但完全不显示也不行：出视频前最该确认的就是"我这条片子到底多长"。
     * 所以这里显示、那里修改，两处不重复。
     */
    const durationLine = h('div', { class: 'note-line', style: 'display:none' });
    async function paintDurationLine() {
      const info = await durationInfo();
      if (!info) return;
      const s2 = info.summary;
      clear(durationLine);
      add(durationLine,
        h('b', {}, `计划 ${s2.planned}s`),
        s2.target ? `（目标 ${s2.target}s）` : '',
        ` · 模型实出 ${s2.generated}s · 合成后 ${s2.videoReady ? `${s2.final}s` : '—'}`,
        h('button', {
          class: 'btn ghost sm', style: 'margin-left:8px',
          title: '时长是分镜那一步的预算：改它等于重排每一镜的秒数，所以只在那儿能改',
          onclick: () => window.dispatchEvent(new CustomEvent('fd:goto-stage', { detail: { id: 'script' } }))
        }, '去分镜改时长'));
    }

    const stepPanels = {
      'script-src': [scriptPanel, chapterPanel, outlinePanel],
      bible: [readinessHost, extendHost, biblePanel, sitePanelHost],
      script: [durationPanel, chapterPanel, outlinePanel, shotsPanel],
      assets: [shotsPanel],
      video: [shotsPanel],
      voice: [shotsPanel],
      compose: [cutPanel, composePanel]
    };
    const allPanels = [scriptPanel, chapterPanel, outlinePanel, readinessHost, extendHost, biblePanel, sitePanelHost, durationPanel, shotsPanel, cutPanel, composePanel]
      .filter(Boolean);
    // 只读那一行摆在分镜面板顶上，跟着"视频"这一步出现
    shotsPanel.insertBefore(durationLine, shotsPanel.firstChild.nextSibling);

    /**
     * 账摆在所有步骤下面，而且**每一步都在** —— 它是项目级的事实，
     * 不属于某一步。默认折起来：日常不用看，要看的时候在手边。
     */
    root.append(stagePanel, ...allPanels, spendHost);
    loadSpend();

    function applyStepPanels() {
      const wanted = new Set((stepPanels[state.stage] || [shotsPanel]).filter(Boolean));
      for (const el of allPanels) el.style.display = wanted.has(el) ? '' : 'none';
      if (wanted.has(biblePanel) && !bibleMounted) {
        bibleMounted = true;
        mountBible();
      }
      // 场地图也只在第一次翻到这一步时才建 —— 它要画一整块 SVG
      if (wanted.has(sitePanelHost) && !siteMounted) {
        siteMounted = true;
        mountSite();
      }
      const showLine = state.stage === 'video';
      durationLine.style.display = showLine ? '' : 'none';
      if (showLine) paintDurationLine();
    }

    applyScope();

    /** 左边菜单点了别的步骤：不重新拉数据，只换显示 */
    const onStageEvent = () => {
      paintStageDetail();
      applyScope();
    };
    window.addEventListener('fd:stage', onStageEvent);
    // 这次渲染被换掉之后就别再听了，否则每切一次页面就多挂一个监听
    root.addEventListener('fd:detach', () => window.removeEventListener('fd:stage', onStageEvent));
    syncNav();

    // 从现在起，任务的动静由这次渲染来听。
    // 上一次渲染的回调在这里被顶掉 —— 它的 DOM 早就不在文档里了，留着只是浪费。
    job.onUpdate = onJobUpdate;

    // 切走的时候任务可能还在跑：把攒下的进度、正在生成哪一镜、失败原因，
    // 原样接上。这一步才是"回来还看得到状态"的关键。
    if (job.projectId === project.id) {
      paintLog({ full: true });
      if (job.failures.length) paintFailures(job.failures);
      if (jobBusy()) {
        toast(job.stage ? '这一步还在后台跑，进度已接上' : '还有镜头在重出，进度已接上', 'ok');
      }
    }

    return root;
  }
};

/**
 * 「这一镜到底照着什么生成」的那块面板。
 *
 * 视频是**两样东西**一起决定的，缺一个都解释不了看到的结果：
 *   首帧图  出图那步的成果，定住第一格 —— 人、衣服、场景、构图
 *   提示词  定住之后几秒演什么、镜头怎么动、谁在说话
 * 两样打架时模型多半跟着图走。所以改完描述只重出视频是不够的，
 * 图也得重出一张，否则会得到"画面还是旧的、动作有点新"的四不像。
 */
function promptPanel(project, shot, sc) {
  if (!shot.imagePath && !shot.videoPath) return null;
  const body = h('div', { class: 'shot-prompt-body' }, '点开加载…');
  let loaded = false;

  const box = h('details', { class: 'shot-prompt' },
    h('summary', {}, '看这一镜发给模型的提示词'),
    body);

  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    try {
      const r = await api(`/projects/${project.id}/shots/${shot.id}/prompts`);
      const block = (title, text, tone) =>
        h('div', { style: 'margin-bottom:10px' },
          h('div', { class: 'field-hint', style: `margin:0 0 3px;${tone ? `color:${tone}` : ''}` }, title),
          h('div', { class: 'mono', style: 'font-size:11.5px;line-height:1.6;white-space:pre-wrap' }, text || '（空）'));

      clear(body);
      add(body,
        h('div', { class: 'field-hint', style: 'margin:0 0 8px' },
          '视频照着两样东西生成：「首帧图」——出图那步的成果，定住第一格画面；'
          + '「下面这条提示词」——定住之后几秒演什么。两样打架时，模型多半跟着图走。'),
        r.imageOlderThanEdit
          ? h('div', { class: 'badge warn', style: 'margin-bottom:8px;display:block;white-space:normal;line-height:1.6' },
              '⚠ 这一镜的描述改过，但图还是改之前出的。直接出视频的话，'
              + '首帧是旧画面、提示词是新描述 —— 先重出这一镜的图，再出视频。')
          : null,
        block(
          sc.video
            ? `现在出视频会发这条（按当前描述现算，${r.videoPromptMode === 'full' ? '完整' : '精准'}模式，${r.now.video.length} 字）`
            : '现在出图会发这条（按当前描述现算）',
          sc.video ? r.now.video : r.now.image,
          'var(--good)'),
        (sc.video ? r.videoStale : r.imageStale)
          ? block(
              sc.video ? '上一次出视频实际发的是（已过时）' : '上一次出图实际发的是（已过时）',
              sc.video ? r.used.video : r.used.image,
              'var(--caution)')
          : h('div', { class: 'field-hint', style: 'margin:0' },
              (sc.video ? r.used.video : r.used.image)
                ? '和上一次发出去的完全一样 —— 描述没改过，或者改完已经重出过了。'
                : '这一镜还没出过，上面这条就是它将要用的。'),
        r.refs?.length
          ? h('div', { class: 'field-hint', style: 'margin:6px 0 0' }, `随提示词一起发的设定集参考图：${r.refs.join('、')}`)
          : null);
    } catch (e) {
      clear(body);
      body.append(`取不到：${e.message}`);
    }
  });

  return box;
}

function describe(ev) {
  switch (ev.type) {
    case 'stage':
      return `【${ev.stage}】${ev.status === 'running' ? '开始' : '完成'} ${ev.message || ''}`;
    case 'sheet':
      return `参考图 ${ev.name}：${ev.status}${ev.message ? ` — ${ev.message}` : ''}`;
    case 'shot':
      return `${ev.shotId} ${ev.status}${ev.message ? ` — ${ev.message}` : ''}${ev.score ? `（一致性 ${ev.score}）` : ''}`;
    case 'verify':
      return `复核 ${ev.character}：${ev.score} 分 ${ev.pass ? '通过' : `未通过 — ${(ev.issues || []).join('；')}`}`;
    case 'poll':
      return `轮询 #${ev.attempt} → ${ev.state || '…'}`;
    case 'note':
      return `※ ${ev.message}`;
    case 'progress':
      return `合成中 ${ev.seconds?.toFixed(1)}s`;
    case 'error':
      return `✕ ${ev.message}`;
    case 'finished':
      return '── 本轮结束 ──';
    default:
      return null;
  }
}

