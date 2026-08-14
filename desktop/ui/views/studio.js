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
}

export default {
  async render({ state, go }) {
    const stages = state.catalog.stages.filter((s) => s.id !== 'export');
    const { presets } = await api('/styles');
    const projects = await api('/projects');
    // 技法库：镜头运用、光线、动作、氛围。全局的，跨项目共用
    let skillGroups = (await api('/skills').catch(() => null))?.groups || [];
    let project = null;

    if (!state.projectId && projects.length) state.projectId = projects[0].id;
    if (state.projectId) {
      project = await api(`/projects/${state.projectId}`).catch(() => null);
      if (!project) state.projectId = null;
    }

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
     * 当前选中的流水线阶段。
     *
     * 它不只是"看哪一步"，还决定**下面显示哪些参数**：
     * 在出图那一步摆一堆秒数和视频模型，是逼人在一屏噪音里找那一个按钮。
     * 每一步只留这一步真正用得上的。
     */
    let selectedStage = localStorage.getItem('fd.stage') || 'bible';

    /** 这一阶段该显示哪些参数 */
    function scope(stage = selectedStage) {
      return {
        // 时长是视频的输入：几秒的片段由它决定。分镜那步也要，因为拆镜时就在分配预算。
        duration: stage === 'script' || stage === 'video',
        image: stage === 'assets',
        video: stage === 'video',
        // 设定集那两步的产出都在「设定集」页，分镜网格帮不上忙
        shots: stage !== 'bible' && stage !== 'sheets'
      };
    }

    // ───────────── 剧本 ─────────────
    // 画风不在这儿 —— 建项目时已经定过了，摆两遍只会让人怀疑到底哪个算数。
    // 要改去「项目」页，那里会顺便提醒"设定集是按画风冻结的，改完得重跑第 01 步"。
    const scriptArea = h('textarea', { rows: 9 }, project.script || '');
    const shotCount = h('input', { type: 'number', value: 8, min: 2, max: 60 });

    root.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', { class: 'panel-title' }, '剧本'),
        h('p', { class: 'panel-hint' }, '小说片段、大纲、完整剧本都行。写完记得保存，再从下面第 01 步开始。'),
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
      )
    );

    // ───────────── 时长 ─────────────
    // 三个数分开摆：目标是你要的，计划是分镜表算的，实际是厂商档位吃完剩的。
    // 混成一个数就会出现"界面说 32 秒、成片 40 秒"这种谁也说不清的情况。
    const durationHost = h('div', {});

    async function paintDuration() {
      const info = await api(`/projects/${project.id}/duration`).catch(() => null);
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
                  paintTrack();
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
    const durationPanel = h('div', { class: 'panel' },
      h('h2', { class: 'panel-title' }, '时长'),
      h('p', { class: 'panel-hint' },
        '目标时长是「输入」：分镜数由它反推，拆分镜时会把预算交给模型，让它自己分配节奏 —— 紧张段用短镜，抒情段用长镜。'),
      durationHost
    );
    root.append(durationPanel);

    // ───────────── 章节（长篇才出现）─────────────
    const chapterInfo = await api(`/projects/${project.id}/chapters`).catch(() => null);
    const hasChapters = (project.chapters || []).length > 0;

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
      root.append(h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, '章节'), chapterHost));
    }

    // ───────────── 实时进度 ─────────────
    // 出视频一镜要几分钟，中间全靠轮询。不把"现在轮到谁、轮询到第几次"显示出来，
    // 用户看到的就是一个卡住不动的界面，只能猜是不是死了。
    jobReset(project.id);
    const live = job.live; // 状态在模块级，切页面不丢
    const liveBadge = h('span', {});
    const liveEls = new Map(); // shotId → 卡片上那块状态区

    function trackLive(ev) {
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
    const track = h('div', { class: 'stage-track' });

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

    /** 这一阶段做完了多少：给详情面板和阶段轨共用 */
    function stageProgress(id) {
      const shots = project.shots || [];
      const bible = project.bible;
      switch (id) {
        case 'bible': {
          const all = bible ? [...bible.characters, ...bible.scenes, ...(bible.props || [])] : [];
          return { done: all.filter((x) => x.sheetPath).length, total: all.length, unit: '张参考图' };
        }
        case 'script':
          return { done: shots.length, total: shots.length || 0, unit: '个分镜' };
        case 'assets':
          return { done: shots.filter((s) => s.imagePath).length, total: shots.length, unit: '张镜头图' };
        case 'video':
          return {
            done: shots.filter((s) => s.videoPath).length,
            total: shots.length,
            unit: '段视频',
            // 提交成功但取不回来的：既不算完成也不算失败，单独数一份
            pending: shots.filter((s) => s.pendingTask && !s.videoPath).length
          };
        case 'voice': {
          const need = shots.filter((s) => s.dialogue?.trim());
          return { done: need.filter((s) => s.audioPath).length, total: need.length, unit: '条配音' };
        }
        case 'compose':
          return { done: project.outputs?.video ? 1 : 0, total: 1, unit: '支成片' };
        default:
          return { done: 0, total: 0, unit: '' };
      }
    }

    function paintTrack() {
      clear(track);
      stages.forEach((s, i) => {
        const status = project.stageStatus?.[s.id] || 'pending';
        const { done, total } = stageProgress(s.id);
        track.append(
          h(
            'button',
            {
              class: `stage-chip ${status} ${job.stage === s.id ? 'running' : ''} ${selectedStage === s.id ? 'selected' : ''}`,
              title: s.hint,
              onclick: () => {
                selectedStage = s.id;
                localStorage.setItem('fd.stage', s.id);
                paintTrack();
                paintStageDetail();
                applyScope();
              }
            },
            h('span', { class: 'stage-num' }, String(i + 1).padStart(2, '0')),
            h('span', {}, s.label),
            total ? h('span', { class: 'stage-count' }, `${done}/${total}`) : null,
            status === 'done' ? h('span', { class: 'dot ok' }) : null,
            status === 'partial' ? h('span', { class: 'dot warn' }) : null,
            job.stage === s.id ? h('span', { class: 'spin' }, '◐') : null
          )
        );
      });
      track.append(
        h(
          'button',
          {
            class: 'stage-chip',
            style: 'margin-left:auto;border-color:var(--beam)',
            disabled: jobBusy(),
            title: '从设定集一路跑到合成，中间任一步失败就停下，已完成的都在盘上',
            onclick: () => {
              if (!confirm('一键跑完会依次跑完六步，视频那步按镜数计费，可能是这条流水线最大的一笔开销。确定？')) return;
              runStage('all');
            }
          },
          h('span', { class: 'stage-num' }, '▶'),
          h('span', {}, '一键跑完')
        )
      );
    }

    /** 选中阶段的详情：产出统计 + 缺什么 + 明确的运行按钮 */
    function paintStageDetail() {
      clear(stageDetail);
      const meta = stages.find((s) => s.id === selectedStage);
      if (!meta) return;
      const { done, total, unit } = stageProgress(selectedStage);
      const pct = total ? Math.round((done / total) * 100) : 0;
      const shots = project.shots || [];

      // 这一阶段还缺哪些，列出来点得到
      let missing = [];
      if (selectedStage === 'assets') missing = shots.filter((s) => !s.imagePath);
      else if (selectedStage === 'video') missing = shots.filter((s) => s.imagePath && !s.videoPath);
      else if (selectedStage === 'voice') missing = shots.filter((s) => s.dialogue?.trim() && !s.audioPath);
      else if (selectedStage === 'bible' && project.bible) {
        missing = [...project.bible.characters, ...project.bible.scenes, ...(project.bible.props || [])]
          .filter((x) => !x.sheetPath);
      }

      const runnable = !jobBusy();
      const isCostly = selectedStage === 'video';
      const pendingCount = stageProgress('video').pending || 0;

      /**
       * 待认领的任务：提交成功了、钱花了、片子在厂商那边，我们没取回来。
       *
       * 这类状态最要命的地方在于它**卡住整条流水线**：既不算完成（合成时缺一块），
       * 也不算失败（重跑要再花一次钱）。所以给一个零成本的出口 ——
       * 重查一次不产生任何生成费用，刚在「接口地址」里填对路径的话，
       * 这一下能把之前卡住的全收回来。
       */
      const pendingBox = pendingCount && selectedStage === 'video'
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

      add(stageDetail,
        h('div', { class: 'stage-detail-head' },
          h('div', {},
            h('div', { class: 'stage-detail-title' }, meta.label),
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
                runStage(selectedStage);
              }
            }, done ? `继续（还差 ${total - done}）` : '开始'),
            done && done === total
              ? h('button', {
                  class: 'btn ghost',
                  disabled: !runnable,
                  onclick: () => {
                    if (!confirm('这一步已经完成，重跑会覆盖已有产出并重新计费。确定？')) return;
                    runStage(selectedStage, { regenerate: true });
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
      job.live.clear();
      job.log = [];
      job.failures = [];
      job.startedAt = Date.now();
      jobNotify('start');

      try {
        await stream(
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
        job.stage = null;
        job.live.clear();
        jobNotify('done');
        toast(
          failed ? `${failed} 项失败，看流水线下面的失败原因` : `完成，用时 ${fmtMs(spent)}`,
          failed ? 'err' : 'ok'
        );
      }
    }

    /** 重查待认领的任务。只是再问一次，不重新生成，所以不花钱。 */
    async function recheckTasks() {
      if (jobBusy()) return;
      job.projectId = project.id;
      job.stage = 'video';
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
      if (kind === 'start') {
        clear(progressLog);
        painted = 0;
        clear(failHost);
        progressLog.style.display = '';
        paintTrack();
        paintStageDetail();
        return;
      }
      if (kind === 'tick') {
        paintLog();
        return;
      }
      // done
      paintLog();
      clear(liveBadge);
      paintFailures(job.failures);
      project = (await api(`/projects/${project.id}`).catch(() => project)) || project;
      await paintDuration();
      paintTrack();
      paintStageDetail();
      applyScope();
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

    paintTrack();
    paintStageDetail();
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '流水线', liveBadge),
        h('p', { class: 'panel-hint' },
          '按顺序跑。点阶段是「查看」这一步的产出，要跑得在下面明确按运行 —— 每一步都真花钱，不该一点就走。'),
        track,
        stageDetail,
        progressLog,
        failHost
      )
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
      job.shots.add(shot.id);
      job.live.set(shot.id, { status: 'running', message: '提交中…' });
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '生成中…';
      const failures = [];
      try {
        await stream(
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

    function paintShots() {
      clear(shotHost);
      if (!project.shots?.length) {
        shotHost.append(h('div', { class: 'empty' }, h('b', {}, '还没有分镜'), '先跑第 01 步设定集，再跑第 02 步分镜。'));
        return;
      }
      const grid = h('div', { class: 'shot-grid' });
      const sc = scope();
      const ordered = project.shots.slice().sort((a, b) => a.index - b.index);
      for (const [ordinal, shot] of ordered.entries()) {
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
        if (shot.videoPath) {
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

        // 厂商的时长档位：设 4 秒而模型只出 5/10 秒时，得在这儿就说清楚
        const steps = state.catalog.videoDurations || [];
        const aligned = steps.find((x) => x >= shot.duration) || steps.at(-1);

        // ── 手改这一镜的文案 ──
        // 分镜描述是这一镜出图、出视频的**唯一输入**。模型拆分镜时写偏一句
        //（把"雨夜"写成"清晨"、把"特写"写成"全景"），后面每次重出都是在错的基础上重来。
        // 所以描述本身就是可点的：点一下直接改，比"发现不对 → 重跑整个分镜"快得多，也不会把别的镜头一起冲掉。
        const editor = h('div', { class: 'shot-edit', style: 'display:none' });
        const pickedSkills = [...(shot.skills || [])];
        const descEl = h('div', {
          class: 'shot-desc editable',
          title: '点一下改这一镜的描述'
        }, shot.description || '（无描述）');

        const fields = {
          description: h('textarea', { rows: 3 }, shot.description || ''),
          camera: h('input', { type: 'text', placeholder: '中景 / 特写 / 航拍…', value: shot.camera || '' }),
          motion: h('input', { type: 'text', placeholder: '镜头缓慢推进…', value: shot.motion || '' }),
          scene: h('input', { type: 'text', placeholder: '场景名（要和设定集里的一致）', value: shot.scene || '' }),
          characters: h('input', {
            type: 'text', placeholder: '出场角色，逗号分隔', value: (shot.characters || []).join('、')
          }),
          dialogue: h('input', { type: 'text', placeholder: '这一镜的台词（没有就留空）', value: shot.dialogue || '' }),
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
              const r = await api(`/projects/${project.id}/shots/${shot.id}`, {
                method: 'PATCH',
                body: {
                  description: fields.description.value,
                  camera: fields.camera.value,
                  motion: fields.motion.value,
                  scene: fields.scene.value,
                  characters: fields.characters.value,
                  dialogue: fields.dialogue.value,
                  link: fields.link.value,
                  skills: pickedSkills
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
              paintShots();
            } catch (e) {
              toast(e.message, 'err');
              saveEdit.disabled = false;
            }
          }
        }, '保存文案');

        const closeEdit = () => {
          editor.style.display = 'none';
          descEl.style.display = '';
        };
        const openEdit = () => {
          editor.style.display = '';
          descEl.style.display = 'none';
          fields.description.focus();
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

        grid.append(
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
                h('button', { class: 'shot-edit-btn', title: '改这一镜的描述、景别、台词', onclick: openEdit }, '改文案')
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
                shot.videoPath ? h('span', { class: 'badge ok' }, '视频已出') : shot.imagePath ? h('span', { class: 'badge' }, '待出视频') : null
              ),
              shot.dialogue ? h('div', { class: 'shot-desc', style: 'color:var(--ink-faint)' }, `「${shot.dialogue}」`) : null,
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
                  // 把真正发给视频模型的提示词摊开 —— 片段和剧本对不上时，先看这里
                  sc.video && shot.videoPrompt
                    ? h('details', { class: 'shot-prompt' },
                        h('summary', {}, '看发给视频模型的提示词'),
                        h('div', { class: 'shot-prompt-body' }, shot.videoPrompt))
                    : null
                )
              )
            )
          )
        );
      }
      shotHost.append(grid);
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
      title: '模型读一遍每镜的画面描述，从技法库里挑。一次调用管全片，只改文案不出图',
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

    const shotBadge = h('span', {});
    const shotHint = h('p', { class: 'panel-hint' });
    const stageName = h('span', { class: 'badge beam' });

    const HINTS = {
      bible: '这一步只出文字，几秒钟就回来。去「设定集」页把描述过一遍，确认没问题再跑下一步出图。',
      sheets: '按已确认的描述出设定图，出完自动冻结。之后想改：去「设定集」页解冻 → 改描述 → 重出那一张。',
      script: '分镜是后面所有步骤的清单。每镜的时长在这里分配，加起来就是计划时长。',
      assets:
        '「一致性」是把成图和角色设定图交给多模态模型比对后的分数。低于阈值会自动换种子重试；不满意的展开「单独重出」，还能临时换一家模型 —— 有些镜头就是某家画不好，换一家比反复重试有效。',
      video:
        '以镜头图为首帧、配上从设定集装配的提示词生成片段。哪一镜在跑、轮询到第几次都会实时显示在缩略图上；失败的那几镜可以单独重出，还能临时换清晰度或换一家。',
      voice: '按台词逐条合成配音。没有台词的镜头会跳过。',
      compose: 'FFmpeg 按分镜顺序拼接，按时长策略裁剪。这一步不花钱，跑错了重跑就行。'
    };

    /** 阶段换了：把只属于某一步的参数收起来，分镜卡片也重画一遍 */
    function applyScope() {
      const sc = scope();
      durationPanel.style.display = sc.duration ? '' : 'none';
      const meta = stages.find((x) => x.id === selectedStage);
      clear(stageName).append(`当前：${meta?.label || ''}`);
      shotHint.textContent = HINTS[selectedStage] || '这一步的产出不在分镜网格里，切到对应的页面看。';
      const miss = (project.shots || []).filter((s) => (selectedStage === 'video' ? !s.videoPath : !s.imagePath)).length;
      const pend = (project.shots || []).filter((s) => s.pendingTask && !s.videoPath).length;
      clear(shotBadge);
      if (miss) {
        shotBadge.append(
          h('span', { class: 'badge warn' }, selectedStage === 'video' ? `${miss} 镜缺视频` : `${miss} 镜缺图`)
        );
      }
      // "待认领"和"缺"要分开说：前者是钱花了没取回来，后者是压根没跑
      if (pend && selectedStage === 'video') {
        shotBadge.append(h('span', { class: 'badge warn' }, `${pend} 个任务待认领`));
      }
      paintShots();
    }

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '分镜',
          stageName,
          shotBadge,
          project.outputs?.video
            ? h('a', { class: 'badge ok', href: mediaUrl(project.outputs.video), target: '_blank' }, '成片已就绪')
            : null
        ),
        shotHint,
        h('div', { class: 'inline', style: 'margin-bottom:10px;flex-wrap:wrap' }, suggestBtn, suggestStatus),
        shotHost
      )
    );
    applyScope();

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
