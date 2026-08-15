/**
 * 项目：新建、切换、改画风、删除。
 *
 * 从创作台里拆出来单独一页，是因为这些是"项目级"的事，
 * 和"这一部片子怎么往下做"混在一张页面上，每次进创作台都要先滚过一堆
 * 用不上的项目管理控件。画风也归到这里 —— 它是建项目时定的，
 * 定完就不该在剧本旁边再摆一遍。
 */
import { h, clear, api, stream, toast, mediaUrl } from '../lib.js';
import { styleArtSVG } from '../style-art.js';
import { openLightbox } from '../lightbox.js';
import { ratioPicker } from '../ratios.js';

/**
 * 画风缩略图。三种形态，按优先级：
 *
 *   ① 你自己模型出过的预览图 → 一直用它。这张最有价值，因为它回答的是
 *      "这个画风在**我的模型**上长什么样"，而不是"别人那儿长什么样"。
 *   ② 随应用带的示例图（ui/style-img/<id>.webp）→ 一眼就能认出画风。
 *   ③ 都没有 → style-art.js 现画的示意图。离线、免费、构图统一，
 *      新加一个画风预设时不至于开天窗。
 *
 * 三层都留着是有原因的：示例图能让人**一眼选对**，自出的预览图能让人
 * **选得准**，而示意图保证任何时候都不会出现一个碎掉的图框。
 */
export function swatchEl(s) {
  if (s.previewPath) {
    return h('div', { class: 'style-swatch' },
      h('img', {
        src: `${mediaUrl(s.previewPath)}&v=${Date.parse(s.previewAt || '') || 0}`,
        alt: `${s.name} 预览图`,
        loading: 'lazy'
      }));
  }
  if (s.sample) {
    return h('div', { class: 'style-swatch' },
      h('img', { src: s.sample, alt: `${s.name} 示例`, loading: 'lazy' }));
  }
  // 两种真图都没有时用内置示意图
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
    let presets = (await api('/styles')).presets;
    let projects = await api('/projects');
    const styleName = (id) => presets.find((p) => p.id === id)?.name || '自定义';

    const root = h('div', { class: 'stack' });
    const listHost = h('div', {});
    const styleHosts = []; // 页面上所有画风网格，出完预览图要一起换掉

    /** 重画所有画风网格（出完预览图之后） */
    async function refreshStyles() {
      presets = (await api('/styles')).presets;
      for (const { host, current, onPick } of styleHosts) {
        clear(host).append(stylePicker(presets, current(), onPick));
      }
      paintList();
    }

    /**
     * 出画风预览图 —— 用**你自己配的出图模型**。
     *
     * 不打包现成图片是刻意的：网上找来的是别人的作品，随应用分发出去版权说不清。
     * 而且自己出的这张更有用 —— 它回答的是"这个画风在**我的模型**上长什么样"，
     * 这才是选画风时真正想知道的事。
     */
    async function makePreviews(ids, statusEl, btn) {
      const model = state.catalog.routing.image;
      btn.disabled = true;
      let done = 0;
      let failed = 0;
      for (const id of ids) {
        const name = presets.find((x) => x.id === id)?.name || id;
        statusEl.textContent = `正在出「${name}」（${done + 1}/${ids.length}）…`;
        try {
          let err = null;
          await stream(`/styles/${id}/preview`, {}, (ev) => {
            if (ev.type === 'error') err = ev.message;
            if (ev.type === 'note') statusEl.textContent = `「${name}」：${ev.message}`;
          });
          if (err) throw new Error(err);
          done += 1;
        } catch (e) {
          failed += 1;
          statusEl.textContent = `「${name}」失败：${e.message}`;
          // 一张失败不该拖垮剩下的，但也别闷头继续 —— 十二张全错就没必要跑完
          if (failed >= 3) break;
        }
      }
      btn.disabled = false;
      await refreshStyles();
      statusEl.textContent = failed
        ? `出了 ${done} 张，${failed} 张失败（用的是 ${model.provider} / ${model.model}）`
        : `${done} 张预览图已就绪，用的是 ${model.provider} / ${model.model}`;
      toast(failed ? `${failed} 张没出成` : '预览图已更新', failed ? 'err' : 'ok');
    }

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
        let pickedRatio = p.aspectRatio || '';
        styleHost.append(
          h('label', {}, '影片比例'),
          ratioPicker(pickedRatio, (id) => (pickedRatio = id), {
            allowInherit: true,
            fallback: state.catalog?.settings?.aspectRatio || '16:9'
          }),
          // 已经出过图还改比例，等于让新旧镜头长得不一样宽 —— 说清楚，别让人事后才发现
          p.images
            ? h('div', { class: 'field-hint' },
                `这个项目已经出了 ${p.images} 张图。改比例只影响之后新出的，旧的要重出才会跟着变。`)
            : null,
          h('label', { style: 'margin-top:12px' }, '画风'),
          stylePicker(presets, p.styleId, (id) => (picked = id)),
          h('div', { class: 'inline', style: 'margin-top:10px' },
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                const styleChanged = picked !== p.styleId;
                await api(`/projects/${p.id}`, {
                  method: 'PATCH',
                  body: { styleId: picked, aspectRatio: pickedRatio }
                });
                projects = await api('/projects');
                toast(
                  styleChanged && p.hasBible
                    ? '已保存。设定集是按画风冻结的，要重跑第 01 步才生效'
                    : '已保存',
                  'ok'
                );
                paintList();
              }
            }, '保存'),
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
                p.aspectRatio
                  ? h('span', { class: 'badge', title: '这一部片子的画幅' }, p.aspectRatio)
                  : h('span', { class: 'badge', title: '没单独设，跟随「设置 → 画幅」' },
                      `${state.catalog?.settings?.aspectRatio || '16:9'}（跟随设置）`),
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
                }, '改画风 / 比例'),
                h('button', { class: 'btn danger sm', onclick: () => removeProject(p.id, p.title) }, '删除')),
              styleHost
            )
          )
        );
      }
      listHost.append(grid);
    }

    /** 预览图工具条：出真图 / 只补没出过的 / 清掉 */
    function previewBar() {
      const status = h('span', { class: 'field-hint', style: 'margin:0' });
      const missing = () => presets.filter((p) => !p.previewPath && p.id !== 'custom').map((p) => p.id);

      const genAll = h('button', {
        class: 'btn ghost sm',
        onclick: () => {
          const ids = presets.filter((p) => p.id !== 'custom').map((p) => p.id);
          if (!confirm(`用你自己的出图模型出 ${ids.length} 张预览图？会真的调用 ${ids.length} 次出图接口，按你的计费方式扣费。`)) return;
          makePreviews(ids, status, genAll);
        }
      }, '用我的模型出全部预览图');

      const genMissing = h('button', {
        class: 'btn ghost sm',
        onclick: () => {
          const ids = missing();
          if (!ids.length) return toast('每个画风都已经有预览图了', 'ok');
          if (!confirm(`补出 ${ids.length} 张缺的预览图？会调用 ${ids.length} 次出图接口。`)) return;
          makePreviews(ids, status, genMissing);
        }
      }, '只补缺的');

      const clearAll = h('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          if (!confirm('清掉全部预览图？清完会退回内置的示意图，随时可以再出。')) return;
          for (const p of presets) await api(`/styles/${p.id}/preview`, { method: 'DELETE' }).catch(() => {});
          await refreshStyles();
          toast('已清空，退回示意图', 'ok');
        }
      }, '清掉预览图');

      const have = presets.filter((p) => p.previewPath).length;
      const bundled = presets.filter((p) => !p.previewPath && p.sample).length;
      // 说清楚现在这些图**是谁出的**：随应用带的示例图只能告诉你这个画风长什么样，
      // 换成你自己模型出的那张，才能回答"它在我的模型上长什么样"——那才是选画风时真正要知道的
      clear(status);
      if (have) {
        status.append(`${have} 个画风是你自己模型出的图${bundled ? `，${bundled} 个是随应用带的示例图` : ''}`);
      } else {
        // 注意别在文本节点里写 **粗体** —— 那是 Markdown，不是 HTML，会原样印出星号
        status.append('现在显示的是随应用带的示例图。想知道这些画风在', h('b', {}, '你的模型'), '上长什么样，点左边出一遍。');
      }

      /**
       * 用本地图片当某个画风的示例图。
       *
       * 卡片上那张图有三层（自己出的 > 随应用带的 > 现画的示意图），
       * 而随应用带的那层不是每个画风都有 —— 它必须是有权分发的图。
       * 可你手上往往**正好有一张**想要的参照：截的一帧、客户给的稿、以前的成片。
       * 让它直接变成示例图，比再去出一张快得多，也准得多。
       */
      const pickFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
      const styleSel = h('select', { class: 'mini' },
        presets.filter((p) => p.id !== 'custom').map((p) => h('option', { value: p.id }, p.name)));
      pickFile.onchange = async () => {
        const file = pickFile.files?.[0];
        pickFile.value = '';
        if (!file) return;
        if (file.size > 12 * 1024 * 1024) return toast('这张图有点大（超过 12MB），换一张或先压一下', 'err');
        const id = styleSel.value;
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('读不出这个文件'));
            r.readAsDataURL(file);
          });
          await api(`/styles/${id}/preview/upload`, { method: 'POST', body: { dataUrl } });
          await refreshStyles();
          toast(`已把这张图设成「${presets.find((p) => p.id === id)?.name || id}」的示例图`, 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      };

      return h('div', { class: 'inline', style: 'margin-top:10px;flex-wrap:wrap' },
        genAll, genMissing, have ? clearAll : null,
        h('span', { class: 'inline', style: 'gap:6px' },
          styleSel,
          h('button', {
            class: 'btn ghost sm',
            title: '手上有想要的参照图就直接用它 —— 比再去出一张快，也准',
            onclick: () => pickFile.click()
          }, '用本地图片当示例')),
        pickFile,
        status);
    }

    // ── 新建 ──
    const newTitle = h('input', { type: 'text', placeholder: '例：太湖夜巡' });
    const newDuration = h('input', { type: 'number', value: 60, min: 5, max: 3600 });
    let newStyleId = 'ink';
    // 画幅是**这一部片子**的属性，不是全局设置：
    // 手上同时有横屏宣传片和竖屏短剧是常事，挂在设置里就意味着每次切项目都得记得回去改一次。
    const defaultRatio = state.catalog?.settings?.aspectRatio || '16:9';
    let newRatio = defaultRatio;

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '新建项目'),
        h('p', { class: 'panel-hint' },
          '画风在这里定一次就够了 —— 它会写进设定集，之后每一条提示词都从设定集里取，不用在剧本旁边再选一遍。'),
        h('div', { class: 'row' },
          h('div', {}, h('label', {}, '片名'), newTitle),
          h('div', { class: 'shrink', style: 'width:160px' }, h('label', {}, '目标时长（秒）'), newDuration)),
        h('label', { style: 'margin-top:12px' }, '影片比例'),
        h('p', { class: 'field-hint', style: 'margin-top:0' },
          '定完就一路带到底：出图按这个比例出，出视频也按这个比例出。中途改会和已经出好的镜头对不上，所以建的时候就选准。'),
        ratioPicker(newRatio, (id) => (newRatio = id)),
        h('label', { style: 'margin-top:12px' }, '画风'),
        (() => {
          const host = h('div', {});
          const onPick = (id) => (newStyleId = id);
          host.append(stylePicker(presets, 'ink', onPick));
          styleHosts.push({ host, current: () => newStyleId, onPick });
          return host;
        })(),
        previewBar(),
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
                  body: {
                    title,
                    styleId: newStyleId,
                    targetDuration: Number(newDuration.value) || 60,
                    aspectRatio: newRatio
                  }
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
