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
import { inheritStage } from '/previz.js';
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
  return Boolean(job.stage) || job.shots.size > 0;
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
      }

      paintChapters();
      chapterPanel = h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, '章节'), chapterHost);
    }

    // ───────────── 实时进度 ─────────────
    // 出视频一镜要几分钟，中间全靠轮询。不把"现在轮到谁、轮询到第几次"显示出来，
    // 用户看到的就是一个卡住不动的界面，只能猜是不是死了。
    jobReset(project.id);
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
            h('div', { class: 'stage-detail-hint' }, meta.hint)
          ),
          h('div', { class: 'inline' },

            h('button', {
              class: 'btn primary',
              disabled: !runnable,
              title: isCostly ? '视频按镜数计费，是这条流水线最大的开销' : '',
              onclick: () => {
                if (isCostly && missing.length > 3
                  && !confirm(`将为 ${missing.length} 个镜头生成视频，按镜数计费且耗时较长。确定？`)) return;
                runStage(state.stage);
              }
            }, done ? `继续（还差 ${total - done}）` : '开始'),
            done && done === total
              ? h('button', {
                  class: 'btn ghost',
                  disabled: !runnable,
                  onclick: () => {
                    if (!confirm('这一步已经完成，重跑会覆盖已有产出并重新计费。确定？')) return;
                    runStage(state.stage, { regenerate: true });
                  }
                }, '整步重跑')
              : null
          )
        ),
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
                  if (!confirm(`从「${label}」往后跑 ${rest} 步。视频那步按镜数计费，可能是最大的一笔开销。确定？`)) return;
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
            : '当前这一步不在流水线里（比如「剧本」），只能从头跑。'));
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
          { kind, ...picker.values() },
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
            stageDraft = (sameSeg && inheritStage(prevShot.stage, names)) || blankStage(names);
          }
          // 上一镜的排位拿来比对轴线 —— 越轴是**两镜之间**的事，单看一镜看不出来
          const panel = previzPanel(stageDraft, {
            prevStage: prevShot?.stage || null,
            onChange: () => { /* 拖动时只更新读数，存盘等你点保存 */ }
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
        const openEdit = () => {
          editor.style.display = '';
          descEl.style.display = 'none';
          fields.description.focus();
          mark(true);
        };
        descEl.onclick = openEdit;

        // 用 add 而不是 editor.append：原生 append 不会摊平数组，也不会跳过 null ——
        // 直接 append 的话，"和上一镜的关系"那一组会被转成字符串印在界面上，
        // 第一镜（没有上一镜）还会真的显示一个 "null"。
        add(editor,
          h('label', {}, '画面描述'),
          fields.description,
          h('div', { class: 'shot-edit-grid' },
            h('div', {}, h('label', {}, '景别'), fields.camera),
            h('div', {}, h('label', {}, '运镜'), fields.motion),
            h('div', {}, h('label', {}, '场景'), fields.scene),
            h('div', {}, h('label', {}, '出场角色'), fields.characters)),
          h('label', {}, '台词'),
          fields.dialogue,
          h('label', {}, '画外音效'),
          fields.sound,
          h('div', { class: 'hint' },
            '听得见但看不见的东西写这里。写进"画面描述"的话，出图模型画不出声音，' +
            '会去画那个声音最像的东西 ——「敲门声」最常见的下场是画出一扇**开着的门**。'),
          h('div', { class: 'shot-edit-grid' },
            h('div', {}, h('label', {}, '谁说的'), fields.speaker),
          // 和「谁说的」并排：一个管声音用谁的，一个管嘴动不动
          h('div', {}, h('label', {}, '台词类型'), fields.lineKind),
            h('div', {}, h('label', {}, '模型档位'), fields.tier),
            h('div', {}, h('label', {}, '第几场'), fields.segment),
            h('div', {}, h('label', {}, '转场'), fields.transition)),
          h('div', { class: 'hint' },
            '场次 = 同一时间同一地点的一段戏。跨场次不能锁末帧、不能拿邻镜当参考图，' +
            '转场也只该出现在场次之间 —— 划错了这几件事都会做在错的地方。'),
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
          previzHost,
          h('div', { class: 'shot-edit-tip' },
            '只写画面，别写外貌 —— 长相由设定集定，写在这儿反而会和设定集打架。',
            shot.imagePath ? ' 改完这一镜已经出好的图不会变，要重出才生效。' : ''),
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
          h('article', { class: `shot-card ${flagged ? 'flagged' : ''} ${failed ? 'failed' : ''}` },
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
                verBtn
              ),
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
                  sc.image && shot.bibleRefs?.length
                    ? h('div', { class: 'shot-used' }, `上次出图参考：${shot.bibleRefs.join('、')}`)
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
                )
              )
            )
          );
        shotCards.set(shot.id, { card, editing: false, pending: false });
        return card;
      }
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
      bibleTimer = setTimeout(() => mountBible(), delay);
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
      'script-src': [scriptPanel, chapterPanel],
      bible: [readinessHost, biblePanel],
      script: [durationPanel, chapterPanel, shotsPanel],
      assets: [shotsPanel],
      video: [shotsPanel],
      voice: [shotsPanel],
      compose: [composePanel]
    };
    const allPanels = [scriptPanel, chapterPanel, readinessHost, biblePanel, durationPanel, shotsPanel, composePanel]
      .filter(Boolean);
    // 只读那一行摆在分镜面板顶上，跟着"视频"这一步出现
    shotsPanel.insertBefore(durationLine, shotsPanel.firstChild.nextSibling);

    root.append(stagePanel, ...allPanels);

    function applyStepPanels() {
      const wanted = new Set((stepPanels[state.stage] || [shotsPanel]).filter(Boolean));
      for (const el of allPanels) el.style.display = wanted.has(el) ? '' : 'none';
      if (wanted.has(biblePanel) && !bibleMounted) {
        bibleMounted = true;
        mountBible();
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
