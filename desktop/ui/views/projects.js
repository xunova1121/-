/**
 * 项目：新建、切换、改画风、删除。
 *
 * 从创作台里拆出来单独一页，是因为这些是"项目级"的事，
 * 和"这一部片子怎么往下做"混在一张页面上，每次进创作台都要先滚过一堆
 * 用不上的项目管理控件。画风也归到这里 —— 它是建项目时定的，
 * 定完就不该在剧本旁边再摆一遍。
 */
import { h, clear, api, toast } from '../lib.js';
import { styleArtSVG } from '../style-art.js';

/**
 * 画风缩略图。
 *
 * 十二张画的是同一个镜头（湖畔、远山、栈桥上一个人影），只改画法和配色 ——
 * 并排看过去比较的是"这个风格会把画面变成什么样"，而不是"哪张图好看"。
 * 具体怎么画见 ui/style-art.js。
 */
export function swatchEl(s) {
  return h('div', { class: 'style-swatch', html: styleArtSVG(s) });
}

export function stylePicker(presets, currentId, onPick) {
  const grid = h('div', { class: 'style-grid' });
  for (const s of presets) {
    const card = h(
      'button',
      {
        class: `style-card ${s.id === currentId ? 'active' : ''}`,
        title: s.anchor || '自己写风格描述',
        onclick: () => {
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

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return '刚刚';
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前`;
  const days = Math.floor(ms / 86400000);
  return days < 30 ? `${days} 天前` : new Date(iso).toLocaleDateString('zh-CN');
}

export default {
  async render({ state, go }) {
    const { presets } = await api('/styles');
    let projects = await api('/projects');
    const styleName = (id) => presets.find((p) => p.id === id)?.name || '自定义';

    const root = h('div', { class: 'stack' });
    const listHost = h('div', {});

    /**
     * 删项目。
     *
     * 关键的一步是**先把页面上的媒体元素松手**：Windows 下只要还有人开着
     * assets 里的 mp4 / png，整个目录就删不掉（EBUSY），后端只能报错，
     * 界面上什么都不变 —— 看起来就是"删了没反应，重启才生效"。
     */
    async function removeProject(id, title) {
      if (!confirm(`删除「${title}」？已生成的图和视频会一并删掉，无法恢复。`)) return;

      for (const el of document.querySelectorAll('video, audio, img')) {
        try {
          el.pause?.();
        } catch {
          /* img 没有 pause，忽略 */
        }
        el.removeAttribute('src');
        el.load?.();
      }
      // 给浏览器一帧时间真正释放文件句柄，再发删除请求
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));

      try {
        const r = await api(`/projects/${id}`, { method: 'DELETE' });
        if (r?.ok?.leftover) {
          toast('已删除（有文件仍被占用，残留目录会在下次启动时清掉）', 'ok');
        } else {
          toast('已删除', 'ok');
        }
      } catch (err) {
        toast(`删不掉：${err.message}`, 'err');
        return;
      }

      if (state.projectId === id) {
        state.projectId = null;
        localStorage.removeItem('fd.projectId');
      }
      // 就地重画列表，不依赖整页刷新 —— 删完立刻就该看不见它
      projects = await api('/projects');
      paintList();
    }

    async function openProject(id) {
      state.projectId = id;
      localStorage.setItem('fd.projectId', id);
      await go('studio');
    }

    function paintList() {
      clear(listHost);
      if (!projects.length) {
        listHost.append(
          h('div', { class: 'empty' }, h('b', {}, '还没有项目'), '在上面填个名字、选个画风，就能开工。')
        );
        return;
      }

      const grid = h('div', { class: 'project-grid' });
      for (const p of projects) {
        const current = p.id === state.projectId;
        const preset = presets.find((x) => x.id === p.styleId);

        // 改画风：默认收着。改完立刻落盘，因为设定集是按画风冻结的，
        // 已经跑过设定集的项目改画风必须重跑第 01 步才生效 —— 这句话得说出来。
        const styleHost = h('div', { class: 'project-style-edit', style: 'display:none' });
        let picked = p.styleId;
        styleHost.append(
          stylePicker(presets, p.styleId, (id) => (picked = id)),
          h('div', { class: 'inline', style: 'margin-top:10px' },
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                await api(`/projects/${p.id}`, { method: 'PATCH', body: { styleId: picked } });
                projects = await api('/projects');
                toast(p.hasBible ? '画风已改。设定集是按画风冻结的，要重跑第 01 步才生效' : '画风已改', 'ok');
                paintList();
              }
            }, '保存画风'),
            h('button', { class: 'btn ghost sm', onclick: () => (styleHost.style.display = 'none') }, '收起'))
        );

        grid.append(
          h('article', { class: `project-card ${current ? 'current' : ''}` },
            preset ? swatchEl(preset) : null,
            h('div', { class: 'project-body' },
              h('div', { class: 'project-head' },
                h('b', {}, p.title),
                current ? h('span', { class: 'badge ok' }, '当前') : null
              ),
              h('div', { class: 'project-meta' },
                h('span', { class: 'badge' }, styleName(p.styleId)),
                p.targetDuration ? h('span', { class: 'badge' }, `${p.targetDuration}s`) : null,
                p.chapters ? h('span', { class: 'badge' }, `${p.chapters} 章`) : null,
                p.shots ? h('span', { class: 'badge' }, `${p.shots} 镜`) : h('span', { class: 'badge warn' }, '未拆分镜')
              ),
              h('div', { class: 'project-progress' },
                p.hasBible ? '设定集 ✓' : '设定集 —',
                ` · 出图 ${p.images}/${p.shots || 0}`,
                ` · 视频 ${p.videos}/${p.shots || 0}`,
                p.output ? ' · 成片 ✓' : ''),
              h('div', { class: 'project-time' }, `更新于 ${relTime(p.updatedAt)}`),
              h('div', { class: 'inline', style: 'margin-top:10px' },
                h('button', { class: 'btn sm primary', onclick: () => openProject(p.id) },
                  current ? '继续做' : '打开'),
                h('button', {
                  class: 'btn ghost sm',
                  onclick: () => {
                    styleHost.style.display = styleHost.style.display === 'none' ? '' : 'none';
                  }
                }, '改画风'),
                h('button', { class: 'btn danger sm', onclick: () => removeProject(p.id, p.title) }, '删除')),
              styleHost
            )
          )
        );
      }
      listHost.append(grid);
    }

    // ── 新建 ──
    const newTitle = h('input', { type: 'text', placeholder: '例：太湖夜巡' });
    const newDuration = h('input', { type: 'number', value: 60, min: 5, max: 3600 });
    let newStyleId = 'ink';

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '新建项目'),
        h('p', { class: 'panel-hint' },
          '画风在这里定一次就够了 —— 它会写进设定集，之后每一条提示词都从设定集里取，不用在剧本旁边再选一遍。'),
        h('div', { class: 'row' },
          h('div', {}, h('label', {}, '片名'), newTitle),
          h('div', { class: 'shrink', style: 'width:160px' }, h('label', {}, '目标时长（秒）'), newDuration)),
        h('label', { style: 'margin-top:12px' }, '画风'),
        stylePicker(presets, 'ink', (id) => (newStyleId = id)),
        h('div', { class: 'inline', style: 'margin-top:12px' },
          h('button', {
            class: 'btn primary',
            onclick: async (e) => {
              const title = newTitle.value.trim();
              if (!title) return toast('先起个名字', 'err');
              e.target.disabled = true;
              try {
                const p = await api('/projects', {
                  method: 'POST',
                  body: { title, styleId: newStyleId, targetDuration: Number(newDuration.value) || 60 }
                });
                toast('已创建，去创作台把剧本贴进来', 'ok');
                await openProject(p.id);
              } catch (err) {
                toast(err.message, 'err');
                e.target.disabled = false;
              }
            }
          }, '创建并打开'))
      )
    );

    paintList();
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '全部项目', h('span', { class: 'badge' }, `${projects.length} 个`)),
        h('p', { class: 'panel-hint' },
          '一个项目一个文件夹，整包拷给同事就能接着做。删除是真删，图、视频、成片一起没。'),
        listHost
      )
    );

    return root;
  }
};
