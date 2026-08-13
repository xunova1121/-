/**
 * 创作台：项目、画风、章节、流水线阶段轨、分镜网格。
 * 阶段编号是真序列 —— 设定集必须在分镜之前跑，因为分镜要引用已冻结的人设。
 */
import { h, clear, add, api, stream, toast, mediaUrl, fmtMs } from '../lib.js';

let running = null;

export default {
  async render({ state }) {
    const stages = state.catalog.stages.filter((s) => s.id !== 'export');
    const { presets } = await api('/styles');
    const projects = await api('/projects');
    let project = null;

    if (!state.projectId && projects.length) state.projectId = projects[0].id;
    if (state.projectId) {
      project = await api(`/projects/${state.projectId}`).catch(() => null);
      if (!project) state.projectId = null;
    }

    const root = h('div', { class: 'stack' });
    const rerender = () => document.querySelector('#btn-refresh').click();

    // ───────────── 项目 ─────────────
    const projectSel = h(
      'select',
      {
        onchange: (e) => {
          state.projectId = e.target.value;
          localStorage.setItem('fd.projectId', e.target.value);
          rerender();
        }
      },
      projects.map((p) =>
        h('option', { value: p.id, selected: p.id === state.projectId }, `${p.title}（${p.shots} 镜）`)
      )
    );

    const newTitle = h('input', { type: 'text', placeholder: '例：太湖夜巡' });
    const newDuration = h('input', { type: 'number', value: 60, min: 5, max: 3600 });
    let newStyleId = 'ink';

    /** 画风缩略图：用配色和纹理现画，不外链图片，离线也能看 */
    function swatchEl(s) {
      const { from, to, accent, texture } = s.swatch;
      const overlays = {
        ink: `radial-gradient(ellipse at 30% 70%, ${accent}55 0%, transparent 55%)`,
        flat: `linear-gradient(180deg, transparent 55%, ${accent}66 55%)`,
        fine: `repeating-linear-gradient(45deg, ${accent}22 0 3px, transparent 3px 8px)`,
        photo: `radial-gradient(circle at 70% 30%, ${accent}88 0%, transparent 45%)`,
        grain: `repeating-linear-gradient(0deg, ${accent}18 0 1px, transparent 1px 3px)`,
        neon: `radial-gradient(circle at 25% 75%, ${accent}cc 0%, transparent 40%), radial-gradient(circle at 75% 25%, ${to}aa 0%, transparent 40%)`,
        soft: `radial-gradient(circle at 50% 40%, ${accent}77 0%, transparent 60%)`,
        noir: `linear-gradient(105deg, transparent 0 12%, ${accent}44 12% 16%, transparent 16% 28%, ${accent}44 28% 32%, transparent 32%)`,
        wash: `radial-gradient(ellipse at 60% 40%, ${accent}66 0%, transparent 50%)`
      };
      return h('div', {
        class: 'style-swatch',
        style: `background: ${overlays[texture] || ''}, linear-gradient(135deg, ${from}, ${to});`
      });
    }

    function stylePicker(currentId, onPick) {
      const grid = h('div', { class: 'style-grid' });
      for (const s of presets) {
        const card = h(
          'button',
          {
            class: `style-card ${s.id === currentId ? 'active' : ''}`,
            title: s.anchor || '自己写风格描述',
            onclick: () => {
              currentId = s.id;
              onPick(s.id);
              for (const el of grid.children) el.classList.remove('active');
              card.classList.add('active');
            }
          },
          swatchEl(s),
          h('div', { class: 'style-name' }, s.name),
          h('div', { class: 'style-hint' }, s.hint)
        );
        grid.append(card);
      }
      return grid;
    }

    root.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', { class: 'panel-title' }, '项目'),
        projects.length
          ? h('div', { class: 'row' },
              h('div', {}, h('label', {}, '当前项目'), projectSel),
              h('div', { class: 'shrink' },
                h('button', {
                  class: 'btn danger',
                  onclick: async () => {
                    if (!state.projectId) return;
                    if (!confirm('删除这个项目？已生成的图和视频会一并删掉，无法恢复。')) return;
                    await api(`/projects/${state.projectId}`, { method: 'DELETE' });
                    state.projectId = null;
                    localStorage.removeItem('fd.projectId');
                    toast('已删除', 'ok');
                    rerender();
                  }
                }, '删除项目'))
            )
          : h('p', { class: 'panel-hint' }, '还没有项目。填个名字，选个画风，从下面开始。'),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('div', {}, h('label', {}, '新建项目'), newTitle),
          h('div', { class: 'shrink', style: 'width:160px' }, h('label', {}, '目标时长（秒）'), newDuration)),
        h('label', {}, '画风'),
        stylePicker('ink', (id) => (newStyleId = id)),
        h('div', { class: 'inline', style: 'margin-top:12px' },
          h('button', {
            class: 'btn',
            onclick: async () => {
              const title = newTitle.value.trim();
              if (!title) return toast('先起个名字', 'err');
              const p = await api('/projects', {
                method: 'POST',
                body: { title, styleId: newStyleId, targetDuration: Number(newDuration.value) || 60 }
              });
              state.projectId = p.id;
              localStorage.setItem('fd.projectId', p.id);
              toast('已创建', 'ok');
              rerender();
            }
          }, '创建'))
      )
    );

    if (!project) {
      root.append(h('div', { class: 'empty' }, h('b', {}, '还没有选中项目'), '创建一个，然后把剧本贴进来。'));
      return root;
    }

    // ───────────── 剧本 + 画风 ─────────────
    const scriptArea = h('textarea', { rows: 9 }, project.script || '');
    const shotCount = h('input', { type: 'number', value: 8, min: 2, max: 60 });
    const extraStyle = h('input', { type: 'text', value: project.style || '', placeholder: '在预设之上补充，例：冷调、雨天、低机位' });
    let pickedStyle = project.styleId || 'ink';

    root.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', { class: 'panel-title' }, '剧本'),
        h('p', { class: 'panel-hint' }, '小说片段、大纲、完整剧本都行。写完记得保存，再从下面第 01 步开始。'),
        scriptArea,
        h('div', { style: 'margin-top:14px' }, h('label', {}, '画风'), stylePicker(pickedStyle, (id) => (pickedStyle = id))),
        h('div', { class: 'field', style: 'margin-top:10px' }, h('label', {}, '补充描述（可留空）'), extraStyle),
        h('div', { class: 'row', style: 'margin-top:11px' },
          h('div', { class: 'shrink', style: 'width:150px' }, h('label', {}, '每章目标镜数'), shotCount),
          h('div', {}),
          h('div', { class: 'shrink' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                await api(`/projects/${project.id}`, {
                  method: 'PATCH',
                  body: { script: scriptArea.value, styleId: pickedStyle, style: extraStyle.value.trim() }
                });
                toast('已保存', 'ok');
                rerender();
              }
            }, '保存剧本与画风'))
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
                  paintShots();
                  paintTrack();
                } catch (err) {
                  toast(err.message, 'err');
                } finally {
                  ev.target.disabled = false;
                }
              }
            }, project.shots?.length ? '按目标重排时长' : '保存目标'))
        ),
        h('div', { class: 'field-hint' },
          project.shots?.length
            ? `每镜时长可以在分镜卡片里单独改。厂商只接受固定档位（5/10 秒之类），所以"模型实出"通常比"计划"长 —— 合成时按策略裁剪。`
            : `还没拆分镜。按这个目标，建议拆 ${suggestedShots} 个镜头左右，拆分镜时会把时长预算一并交给模型。`)
      );
    }

    await paintDuration();
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '时长'),
        h('p', { class: 'panel-hint' },
          '目标时长是「输入」：分镜数由它反推，拆分镜时会把预算交给模型，让它自己分配节奏 —— 紧张段用短镜，抒情段用长镜。'),
        durationHost
      )
    );

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
            h('div', { class: 'inline', style: 'margin-top:12px' },
              h('button', {
                class: 'btn primary',
                onclick: async () => {
                  await api(`/projects/${project.id}/chapters/split`, { method: 'POST', body: {} });
                  toast('已分章', 'ok');
                  rerender();
                }
              }, '切分章节'))
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
                h('div', { class: 'chapter-meta' },
                  `${ch.chars} 字`,
                  shots.length ? ` · ${shots.length} 镜` : ' · 未拆分镜',
                  shots.length ? ` · 出图 ${withImg}/${shots.length}` : '')
              ),
              h('div', { class: 'inline' },
                h('button', {
                  class: 'btn sm',
                  disabled: Boolean(running),
                  onclick: () => runStage('script', { chapterId: ch.id })
                }, shots.length ? '重拆分镜' : '拆分镜'),
                h('button', {
                  class: 'btn sm',
                  disabled: Boolean(running) || !shots.length,
                  onclick: () => runStage('assets', { chapterId: ch.id })
                }, '出图'),
                h('button', {
                  class: 'btn sm',
                  disabled: Boolean(running) || !withImg,
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
    const live = new Map(); // shotId → { status, message }
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
      if (running) {
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
    const track = h('div', { class: 'stage-track' });
    const stageDetail = h('div', { class: 'stage-detail' });
    let selectedStage = localStorage.getItem('fd.stage') || 'bible';

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
          return { done: shots.filter((s) => s.videoPath).length, total: shots.length, unit: '段视频' };
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
              class: `stage-chip ${status} ${running === s.id ? 'running' : ''} ${selectedStage === s.id ? 'selected' : ''}`,
              title: s.hint,
              onclick: () => {
                selectedStage = s.id;
                localStorage.setItem('fd.stage', s.id);
                paintTrack();
                paintStageDetail();
              }
            },
            h('span', { class: 'stage-num' }, String(i + 1).padStart(2, '0')),
            h('span', {}, s.label),
            total ? h('span', { class: 'stage-count' }, `${done}/${total}`) : null,
            status === 'done' ? h('span', { class: 'dot ok' }) : null,
            status === 'partial' ? h('span', { class: 'dot warn' }) : null,
            running === s.id ? h('span', { class: 'spin' }, '◐') : null
          )
        );
      });
      track.append(
        h(
          'button',
          {
            class: 'stage-chip',
            style: 'margin-left:auto;border-color:var(--beam)',
            disabled: Boolean(running),
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

      const runnable = !running;
      const isCostly = selectedStage === 'video';

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

    async function runStage(stageId, extra = {}) {
      if (running) return;
      running = stageId;
      live.clear();
      paintTrack();
      paintStageDetail();
      progressLog.style.display = '';
      clear(progressLog);

      const started = Date.now();
      try {
        await stream(
          `/projects/${project.id}/stage/${stageId}`,
          { shotCount: Number(shotCount.value) || 8, ...extra },
          (ev) => {
            trackLive(ev);
            const text = describe(ev);
            if (!text) return;
            progressLog.append(h('div', { class: `ev-${ev.type}` }, text));
            progressLog.scrollTop = progressLog.scrollHeight;
            if (ev.type === 'finished' && ev.project) project = ev.project;
            if (ev.type === 'error') toast(ev.message, 'err');
          }
        );
        toast(`完成，用时 ${fmtMs(Date.now() - started)}`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        running = null;
        live.clear();
        clear(liveBadge);
        project = (await api(`/projects/${project.id}`).catch(() => project)) || project;
        paintTrack();
        paintStageDetail();
        paintShots();
      }
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
        progressLog
      )
    );

    // ───────────── 分镜网格 ─────────────
    const shotHost = h('div', {});

    /** 出图/出视频的服务商 + 模型下拉，重出时用 */
    function modelPicker(capability, defaults) {
      const candidates = state.catalog.providers.filter((p) => (p.capabilities || []).includes(capability));
      const provSel = h('select', { class: 'mini' },
        h('option', { value: '' }, `默认（${defaults.provider}）`),
        ...candidates.map((p) => h('option', { value: p.id }, p.name)));
      const modelSel = h('select', { class: 'mini' }, h('option', { value: '' }, '默认模型'));
      const refill = () => {
        const p = state.catalog.providers.find((x) => x.id === (provSel.value || defaults.provider));
        clear(modelSel).append(h('option', { value: '' }, `默认（${defaults.model}）`));
        for (const m of (p?.models || []).filter((m) => !m.capability || m.capability === capability)) {
          modelSel.append(h('option', { value: m.id }, m.label || m.id));
        }
      };
      provSel.addEventListener('change', refill);
      refill();
      return {
        el: h('div', { class: 'shot-model-row' }, provSel, modelSel),
        values: () => ({ provider: provSel.value || undefined, model: modelSel.value || undefined })
      };
    }

    async function regenerate(shot, kind, picker, btn) {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '生成中…';
      try {
        await stream(
          `/projects/${project.id}/shots/${shot.id}/regenerate`,
          { kind, ...picker.values() },
          (ev) => {
            if (ev.type === 'finished' && ev.project) project = ev.project;
            if (ev.type === 'error') toast(ev.message, 'err');
            if (ev.type === 'note' || ev.type === 'poll') btn.textContent = '生成中…';
          }
        );
        toast(`第 ${shot.index} 镜已重出`, 'ok');
        paintShots();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }

    function paintShots() {
      clear(shotHost);
      if (!project.shots?.length) {
        shotHost.append(h('div', { class: 'empty' }, h('b', {}, '还没有分镜'), '先跑第 01 步设定集，再跑第 02 步分镜。'));
        return;
      }
      const grid = h('div', { class: 'shot-grid' });
      for (const shot of project.shots.slice().sort((a, b) => a.index - b.index)) {
        const c = shot.consistency;
        const flagged = c?.needsReview;
        const failed = shot.status === 'failed' || !shot.imagePath;

        let thumb;
        if (shot.videoPath) {
          thumb = h('video', { src: mediaUrl(shot.videoPath), controls: true, preload: 'metadata' });
        } else if (shot.imagePath) {
          thumb = h('img', { src: `${mediaUrl(shot.imagePath)}&v=${shot.seed || 0}`, alt: `第 ${shot.index} 镜`, loading: 'lazy' });
        } else {
          thumb = h('span', {}, shot.status === 'failed' ? '生成失败' : '待生成');
        }

        const imgPicker = modelPicker('t2i', state.catalog.routing.image);
        const vidPicker = modelPicker('i2v', state.catalog.routing.video);
        const imgBtn = h('button', { class: 'btn sm', onclick: () => regenerate(shot, 'image', imgPicker, imgBtn) },
          shot.imagePath ? '重出图' : '出图');
        const vidBtn = h('button', {
          class: 'btn sm',
          disabled: !shot.imagePath,
          onclick: () => regenerate(shot, 'video', vidPicker, vidBtn)
        }, shot.videoPath ? '重出视频' : '出视频');

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
                    : null)
              ),
              h('div', { class: 'shot-desc' }, shot.description || '（无描述）'),
              h('div', { class: 'shot-meta' },
                shot.camera ? h('span', { class: 'badge' }, shot.camera) : null,
                shot.scene ? h('span', { class: 'badge' }, shot.scene) : null,
                ...(shot.characters || []).map((n) => h('span', { class: 'badge beam' }, n)),
                c?.score !== null && c?.score !== undefined
                  ? h('span', { class: `badge ${c.pass ? 'ok' : 'warn'}`, title: (c.issues || []).join('；') || '一致性复核通过' },
                      `一致性 ${c.score}`)
                  : null,
                c?.attempts > 1 ? h('span', { class: 'badge warn' }, `重试 ${c.attempts - 1}`) : null,
                flagged ? h('span', { class: 'badge warn' }, '待人工确认') : null,
                shot.videoPath ? h('span', { class: 'badge ok' }, '视频已出') : shot.imagePath ? h('span', { class: 'badge' }, '待出视频') : null
              ),
              shot.dialogue ? h('div', { class: 'shot-desc', style: 'color:var(--ink-faint)' }, `「${shot.dialogue}」`) : null,
              // 单镜重出：批量出图总有零星失败或不满意的，为几张图重跑整个阶段既慢又要重烧
              h('details', { class: 'shot-redo' },
                h('summary', {}, '单独重出'),
                h('div', { class: 'shot-redo-body' },
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
                  h('label', { style: 'margin-top:10px' }, '出图用'),
                  imgPicker.el,
                  imgBtn,
                  h('label', { style: 'margin-top:10px' }, '出视频用'),
                  vidPicker.el,
                  vidBtn,
                  shot.modelUsed ? h('div', { class: 'shot-used' }, `出图用了 ${shot.modelUsed}`) : null,
                  shot.videoModelUsed ? h('div', { class: 'shot-used' }, `出视频用了 ${shot.videoModelUsed}`) : null,
                  // 把真正发给视频模型的提示词摊开 —— 片段和剧本对不上时，先看这里
                  shot.videoPrompt
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

    paintShots();
    const missing = (project.shots || []).filter((s) => !s.imagePath).length;
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '分镜',
          missing ? h('span', { class: 'badge warn' }, `${missing} 镜缺图`) : null,
          project.outputs?.video
            ? h('a', { class: 'badge ok', href: mediaUrl(project.outputs.video), target: '_blank' }, '成片已就绪')
            : null
        ),
        h('p', { class: 'panel-hint' },
          '「一致性」是把成图和角色设定图交给多模态模型比对后的分数。低于阈值会自动换种子重试；不满意的可以展开「单独重出」，还能临时换一家模型 —— 有些镜头就是某家画不好，换一家比反复重试有效。'),
        shotHost
      )
    );

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
