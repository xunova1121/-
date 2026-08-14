/**
 * 设定集：已冻结的角色 / 场景 / 道具与衍生品。
 *
 * 这一页是可以改的，而且值得改 —— 模型第一遍写的外貌描述往往偏笼统。
 * 手动把"藏青立领制服"这类具体的颜色和款式写进去，后面几十镜都跟着受益。
 *
 * 每条都能单独改描述、单独重出图、单独换模型，也能自己加条目
 * （中途出场的配角、后加的道具、周边衍生品都走这里）。
 */
import { h, clear, api, stream, toast, mediaUrl } from '../lib.js';
import { openLightbox } from '../lightbox.js';

const KINDS = [
  {
    kind: 'char',
    title: '角色',
    hint: '每个角色一颗固定种子 + 一张设定图。出镜头图时设定图会作为参考图一起送进模型 —— 这比任何文字描述都更能锁住脸和衣服。'
  },
  {
    kind: 'scene',
    title: '场景',
    hint: '场景基准图定住建筑、光线方向和色温。同一场景的不同镜头引用同一张，避免上一镜阴天下一镜晴天。'
  },
  {
    kind: 'prop',
    title: '道具与衍生品',
    hint: '镜头描述里提到道具名时，对应的外观和参考图会自动拼进提示词。一把刀、一枚徽章跨镜头长得不一样，同样出戏。'
  }
];

export default {
  async render({ state }) {
    if (!state.projectId) {
      return h('div', { class: 'empty' }, h('b', {}, '先去创作台选一个项目'), '设定集属于某个具体项目。');
    }
    let project = await api(`/projects/${state.projectId}`);
    const root = h('div', { class: 'stack' });
    const rerender = () => document.querySelector('#btn-refresh').click();

    if (!project.bible) {
      return h('div', { class: 'empty' },
        h('b', {}, `「${project.title}」还没有设定集`),
        '回创作台跑第 01 步，模型会读一遍剧本，把角色、场景、道具的外貌固定下来并各出一张参考图。');
    }

    const bible = project.bible;
    const imageProviders = state.catalog.providers.filter((p) => (p.capabilities || []).includes('t2i'));

    // ── 全片风格锚 ──
    const anchorInput = h('textarea', { rows: 2 }, bible.style.anchor);
    const paletteInput = h('input', { type: 'text', value: bible.style.palette || '' });
    const negativeInput = h('textarea', { rows: 2 }, bible.style.negative);

    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' },
          '全片风格锚',
          h('span', { class: 'badge' }, `冻结于 ${new Date(bible.frozenAt).toLocaleString('zh-CN')}`)
        ),
        h('p', { class: 'panel-hint' }, '这段话会出现在每一条绘图提示词的最前面。放在最前是有讲究的：越靠后的描述越容易被稀释掉。'),
        h('div', { class: 'field' }, h('label', {}, '风格描述'), anchorInput),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', {}, '主色调'), paletteInput),
          h('div', { class: 'field' }, h('label', {}, '负向提示词'), negativeInput)
        ),
        h('button', {
          class: 'btn primary',
          onclick: async (e) => {
            e.target.disabled = true;
            const next = structuredClone(bible);
            next.style.anchor = anchorInput.value.trim();
            next.style.palette = paletteInput.value.trim();
            next.style.negative = negativeInput.value.trim();
            try {
              await api(`/projects/${project.id}`, { method: 'PATCH', body: { bible: next } });
              toast('风格锚已保存，下一批出图立刻生效', 'ok');
            } catch (err) {
              toast(err.message, 'err');
            } finally {
              e.target.disabled = false;
            }
          }
        }, '保存风格锚')
      )
    );

    // ── 三类条目 ──
    for (const { kind, title, hint } of KINDS) {
      const items = kind === 'char' ? bible.characters : kind === 'scene' ? bible.scenes : bible.props || [];
      const grid = h('div', { class: 'sheet-grid' });

      for (const item of items) grid.append(sheetCard(kind, item));

      // 新增条目
      const newName = h('input', { type: 'text', placeholder: '名称' });
      const newDesc = h('input', { type: 'text', placeholder: '外观描述（越具体越好）' });

      root.append(
        h('div', { class: 'panel' },
          h('h2', { class: 'panel-title' }, title, h('span', { class: 'badge' }, `${items.length}`)),
          h('p', { class: 'panel-hint' }, hint),
          items.length ? grid : h('div', { class: 'empty' }, '这一类还是空的，可以在下面手动加。'),
          h('div', { class: 'row', style: 'margin-top:14px' },
            h('div', { class: 'shrink', style: 'width:180px' }, newName),
            h('div', {}, newDesc),
            h('div', { class: 'shrink' },
              h('button', {
                class: 'btn',
                onclick: async (e) => {
                  if (!newName.value.trim()) return toast('先起个名字', 'err');
                  e.target.disabled = true;
                  try {
                    await api(`/projects/${project.id}/bible/${kind}`, {
                      method: 'POST',
                      body: { name: newName.value.trim(), appearance: newDesc.value.trim() }
                    });
                    toast('已加入设定集，点它的「重出」出图', 'ok');
                    rerender();
                  } catch (err) {
                    toast(err.message, 'err');
                  } finally {
                    e.target.disabled = false;
                  }
                }
              }, `+ 加${title.slice(0, 2)}`))
          )
        )
      );
    }

    /** 一张设定卡：图 + 可改描述 + 换模型重出 + 删除 */
    function sheetCard(kind, item) {
      const area = h('textarea', { rows: 4, style: 'font-size:11.5px' }, item.appearance || '');
      const provSel = h('select', { class: 'mini' },
        h('option', { value: '' }, `默认（${state.catalog.routing.image.provider}）`),
        ...imageProviders.map((p) => h('option', { value: p.id }, p.name)));
      const modelSel = h('select', { class: 'mini' });

      const refill = () => {
        const p = state.catalog.providers.find((x) => x.id === (provSel.value || state.catalog.routing.image.provider));
        clear(modelSel).append(h('option', { value: '' }, `默认（${state.catalog.routing.image.model}）`));
        for (const m of (p?.models || []).filter((m) => !m.capability || m.capability === 't2i' || m.capability === 'i2i')) {
          modelSel.append(h('option', { value: m.id }, m.label || m.id));
        }
      };
      provSel.addEventListener('change', refill);
      refill();

      const img = item.sheetPath
        ? h('img', {
            class: 'zoomable',
            src: `${mediaUrl(item.sheetPath)}&v=${item.seed}`,
            alt: `${item.name} 参考图`,
            loading: 'lazy',
            title: '点开看大图',
            // 设定图是全片的基准，比镜头图更该看清楚：脸和服装配色都要在这儿定下来
            onclick: () => {
              const all = [...(project.bible.characters || []), ...(project.bible.scenes || []), ...(project.bible.props || [])]
                .filter((x) => x.sheetPath);
              openLightbox(
                all.map((x) => ({
                  src: `${mediaUrl(x.sheetPath)}&v=${x.seed}`,
                  title: x.name,
                  note: x.appearance || ''
                })),
                all.findIndex((x) => x.name === item.name)
              );
            }
          })
        : h('div', { class: 'ph' }, '未生成');

      const redoBtn = h('button', {
        class: 'btn sm',
        onclick: async () => {
          redoBtn.disabled = true;
          const label = redoBtn.textContent;
          redoBtn.textContent = '生成中…';
          try {
            await stream(
              `/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/regenerate`,
              {
                appearance: area.value.trim(),
                provider: provSel.value || undefined,
                model: modelSel.value || undefined
              },
              (ev) => {
                if (ev.type === 'finished' && ev.project) project = ev.project;
                if (ev.type === 'error') toast(ev.message, 'err');
              }
            );
            toast(`${item.name} 已重出`, 'ok');
            rerender();
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            redoBtn.disabled = false;
            redoBtn.textContent = label;
          }
        }
      }, item.sheetPath ? '改完重出' : '生成');

      /**
       * 用本地图片当设定图。
       *
       * 有些参照是**模型画不出来的**：真人演员的照片、客户给的产品图、
       * 已经定稿的角色三视图 —— 你要的就是这一张，不是"像这一张"。
       *
       * 传上来之后它和模型出的设定图完全同等：一致性复核拿它当基准，
       * 每一镜出图都会把它作为参考图带上。也就是说，
       * 传一张真人照片，后面所有镜头都会照着这个人画。
       */
      const fileInput = h('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp',
        style: 'display:none',
        onchange: async () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          uploadBtn.disabled = true;
          const label = uploadBtn.textContent;
          uploadBtn.textContent = '读取中…';
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => reject(new Error('这个文件读不出来'));
              fr.readAsDataURL(file);
            });
            uploadBtn.textContent = '上传中…';
            let err = null;
            await stream(
              `/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/upload`,
              { dataUrl, fileName: file.name },
              (ev) => {
                if (ev.type === 'finished' && ev.project) project = ev.project;
                if (ev.type === 'error') err = ev.message;
              }
            );
            if (err) throw new Error(err);
            toast(`${item.name} 已换成你传的图。后面出图都会照着它画`, 'ok');
            rerender();
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            fileInput.value = '';
            uploadBtn.disabled = false;
            uploadBtn.textContent = label;
          }
        }
      });
      const uploadBtn = h('button', {
        class: 'btn ghost sm',
        title: '真人照片、客户给的产品图、定稿的三视图 —— 这些模型画不出来，直接传上来当基准',
        onclick: () => fileInput.click()
      }, '传本地图');

      return h('div', { class: 'sheet-card' },
        img,
        h('div', { class: 'sheet-body' },
          h('div', { class: 'sheet-name' },
            item.name,
            // 标明这张图是谁出的。过两天没人分得清哪张是模型出的、哪张是自己传的，
            // 而这直接决定"重出一次"会不会把你传的图冲掉
            item.sheetSource === 'upload'
              ? h('span', { class: 'badge', title: item.sheetFileName || '你上传的图片' }, '自传图')
              : null),
          item.role ? h('div', { class: 'sheet-role' }, item.role) : null,
          h('div', { style: 'margin-top:8px' }, area),
          h('div', { class: 'sheet-actions' }, provSel, modelSel),
          item.sheetSource === 'upload'
            ? h('div', { class: 'sheet-seed', style: 'margin-top:6px' }, '这张是你传的，点「改完重出」会用模型重画一张盖掉它')
            : null,
          h('div', { class: 'inline', style: 'margin-top:8px' },
            redoBtn,
            uploadBtn,
            fileInput,
            h('button', {
              class: 'btn ghost sm',
              title: '从设定集里移除',
              onclick: async () => {
                if (!confirm(`把「${item.name}」从设定集里删掉？已生成的镜头图不受影响。`)) return;
                await api(`/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}`, { method: 'DELETE' });
                toast('已删除', 'ok');
                rerender();
              }
            }, '删除')
          ),
          h('div', { class: 'sheet-seed' }, `seed ${item.seed}`)
        )
      );
    }

    return root;
  }
};
