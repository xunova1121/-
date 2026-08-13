/**
 * 创作台：项目、画风、章节、流水线阶段轨、分镜网格。
 * 阶段编号是真序列 —— 设定集必须在分镜之前跑，因为分镜要引用已冻结的人设。
 */
import { h, clear, api, stream, toast, mediaUrl, fmtMs } from '../lib.js';

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
        h('div', { class: 'field', style: 'margin-top:12px' }, h('label', {}, '新建项目'), newTitle),
        h('label', {}, '画风'),
        stylePicker('ink', (id) => (newStyleId = id)),
        h('div', { class: 'inline', style: 'margin-top:12px' },
          h('button', {
            class: 'btn',
            onclick: async () => {
              const title = newTitle.value.trim();
              if (!title) return toast('先起个名字', 'err');
              const p = await api('/projects', { method: 'POST', body: { title, styleId: newStyleId } });
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

    async function runStage(stageId, extra = {}) {
      if (running) return;
      running = stageId;
      paintTrack();
      progressLog.style.display = '';
      clear(progressLog);

      const started = Date.now();
      try {
        await stream(
          `/projects/${project.id}/stage/${stageId}`,
          { shotCount: Number(shotCount.value) || 8, ...extra },
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
          '按顺序跑。第 01 步「设定集」会把角色、场景、道具的外貌冻结下来并各出一张参考图 —— 后面每一镜都引用它，这是画面前后不脱节的根本原因，别跳过。'),
        track,
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

        grid.append(
          h('article', { class: `shot-card ${flagged ? 'flagged' : ''} ${failed ? 'failed' : ''}` },
            h('div', { class: 'shot-thumb' }, thumb),
            h('div', { class: 'shot-body' },
              h('div', { class: 'shot-head' },
                h('span', { class: 'shot-no' }, `SH ${String(shot.index).padStart(3, '0')}`),
                h('span', { class: 'shot-no' }, `${Number(shot.duration).toFixed(1)}s`)
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
              shot.dialogue ? h('div', { class: 'shot-desc', style: 'color:var(--ink-faint)' }, `「${shot.dialogue}」`) : null,
              // 单镜重出：批量出图总有零星失败或不满意的，为几张图重跑整个阶段既慢又要重烧
              h('details', { class: 'shot-redo' },
                h('summary', {}, '单独重出'),
                h('div', { class: 'shot-redo-body' },
                  h('label', {}, '出图用'),
                  imgPicker.el,
                  imgBtn,
                  h('label', { style: 'margin-top:10px' }, '出视频用'),
                  vidPicker.el,
                  vidBtn,
                  shot.modelUsed ? h('div', { class: 'shot-used' }, `上次用了 ${shot.modelUsed}`) : null
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
