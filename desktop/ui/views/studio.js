/**
 * 创作台：项目、剧本、流水线阶段轨、分镜网格。
 * 阶段编号是真序列 —— 设定集必须在分镜之前跑，因为分镜要引用已冻结的人设。
 */
import { h, clear, api, stream, toast, mediaUrl, fmtMs } from '../lib.js';

let running = null;

export default {
  async render({ state }) {
    const stages = state.catalog.stages.filter((s) => s.id !== 'export');
    let projects = await api('/projects');
    let project = null;

    if (!state.projectId && projects.length) state.projectId = projects[0].id;
    if (state.projectId) {
      project = await api(`/projects/${state.projectId}`).catch(() => null);
      if (!project) state.projectId = null;
    }

    const root = h('div', { class: 'stack' });

    // ───────────── 项目选择条 ─────────────
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
    const newStyle = h('input', { type: 'text', value: '国风水墨，电影感构图，冷调', placeholder: '全片画风' });

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
          : h('p', { class: 'panel-hint' }, '还没有项目。填个名字，从下面开始。'),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('div', {}, h('label', {}, '新建项目'), newTitle),
          h('div', {}, h('label', {}, '画风'), newStyle),
          h('div', { class: 'shrink' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                const title = newTitle.value.trim();
                if (!title) return toast('先起个名字', 'err');
                const p = await api('/projects', {
                  method: 'POST',
                  body: { title, style: newStyle.value.trim() }
                });
                state.projectId = p.id;
                localStorage.setItem('fd.projectId', p.id);
                toast('已创建', 'ok');
                rerender();
              }
            }, '创建'))
        )
      )
    );

    if (!project) {
      root.append(h('div', { class: 'empty' }, h('b', {}, '还没有选中项目'), '创建一个，然后把剧本贴进来。'));
      return root;
    }

    // ───────────── 剧本 ─────────────
    const scriptArea = h('textarea', { rows: 9 }, project.script || '');
    const shotCount = h('input', { type: 'number', value: project.shots?.length || 8, min: 2, max: 60 });

    root.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '剧本',
          h('span', { class: 'badge' }, `${project.style || '未设画风'}`)
        ),
        h('p', { class: 'panel-hint' }, '小说片段、大纲、完整剧本都行。写完记得保存，再从下面第 01 步开始。'),
        scriptArea,
        h('div', { class: 'row', style: 'margin-top:11px' },
          h('div', { class: 'shrink', style: 'width:130px' }, h('label', {}, '目标镜数'), shotCount),
          h('div', {}),
          h('div', { class: 'shrink' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                await api(`/projects/${project.id}`, { method: 'PATCH', body: { script: scriptArea.value } });
                toast('剧本已保存', 'ok');
              }
            }, '保存剧本'))
        )
      )
    );

    // ───────────── 阶段轨 ─────────────
    const progressLog = h('div', { class: 'stream-log', style: 'display:none' });
    const track = h('div', { class: 'stage-track' });

    function paintTrack() {
      clear(track);
      stages.forEach((s, i) => {
        const status = project.stageStatus?.[s.id] || 'pending';
        track.append(
          h(
            'button',
            {
              class: `stage-chip ${status} ${running === s.id ? 'running' : ''}`,
              title: s.hint,
              disabled: Boolean(running),
              onclick: () => runStage(s.id)
            },
            h('span', { class: 'stage-num' }, String(i + 1).padStart(2, '0')),
            h('span', {}, s.label),
            status === 'done' ? h('span', { class: 'dot ok' }) : null,
            status === 'partial' ? h('span', { class: 'dot warn' }) : null
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
            onclick: () => runStage('all')
          },
          h('span', { class: 'stage-num' }, '▶'),
          h('span', {}, '一键跑完')
        )
      );
    }

    async function runStage(stageId) {
      if (running) return;
      running = stageId;
      paintTrack();
      progressLog.style.display = '';
      clear(progressLog);

      const started = Date.now();
      try {
        await stream(
          `/projects/${project.id}/stage/${stageId}`,
          { shotCount: Number(shotCount.value) || 8 },
          (ev) => {
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
        project = (await api(`/projects/${project.id}`).catch(() => project)) || project;
        paintTrack();
        paintShots();
      }
    }

    paintTrack();
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '流水线'),
        h('p', { class: 'panel-hint' },
          '按顺序跑。第 01 步「设定集」会把角色和场景的外貌冻结下来并出参考图 —— 后面每一镜都引用它，这是画面前后不脱节的根本原因，别跳过。'),
        track,
        progressLog
      )
    );

    // ───────────── 分镜网格 ─────────────
    const shotHost = h('div', {});

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
        const failed = shot.status === 'failed';

        let thumb;
        if (shot.videoPath) {
          thumb = h('video', { src: mediaUrl(shot.videoPath), controls: true, preload: 'metadata' });
        } else if (shot.imagePath) {
          thumb = h('img', { src: mediaUrl(shot.imagePath), alt: `第 ${shot.index} 镜`, loading: 'lazy' });
        } else {
          thumb = h('span', {}, failed ? '生成失败' : '待生成');
        }

        grid.append(
          h('article', { class: `shot-card ${flagged ? 'flagged' : ''} ${failed ? 'failed' : ''}` },
            h('div', { class: 'shot-thumb' }, thumb),
            h('div', { class: 'shot-body' },
              h('div', { class: 'shot-head' },
                h('span', { class: 'shot-no' }, `SH ${String(shot.index).padStart(3, '0')}`),
                h('span', { class: 'shot-no' }, `${shot.duration.toFixed(1)}s`)
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
                flagged ? h('span', { class: 'badge warn' }, '待人工确认') : null
              ),
              shot.dialogue ? h('div', { class: 'shot-desc', style: 'color:var(--ink-faint)' }, `「${shot.dialogue}」`) : null
            )
          )
        );
      }
      shotHost.append(grid);
    }

    paintShots();
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '分镜',
          project.outputs?.video
            ? h('a', { class: 'badge ok', href: mediaUrl(project.outputs.video), target: '_blank' }, '成片已就绪')
            : null
        ),
        h('p', { class: 'panel-hint' }, '「一致性」是把成图和角色设定图交给多模态模型比对后的分数。低于阈值会自动换种子重试，重试到头仍不达标的会标成「待人工确认」。'),
        shotHost
      )
    );

    function rerender() {
      document.querySelector('#btn-refresh').click();
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
