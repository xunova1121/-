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

const VARIANT_META = {
  char: { title: '造型', hint: '同一个人的不同穿搭。脸不变、种子不变，只换衣服', ph: '例：雨夜外套' },
  scene: { title: '时段 / 内外景', hint: '同一个地方的不同光线。建筑不变，只换天气时段', ph: '例：内景·值班室' },
  prop: { title: '状态', hint: '同一件东西的不同状态', ph: '例：破损' }
};

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
  /**
   * `rerender` 由挂载方给：设定集现在挂在创作台的「设定集」那一步里，
   * 重画应该只重画它自己，而不是把整页（包括你正在编辑的分镜）一起冲掉。
   * 单独打开时退回全页刷新。
   */
  async render({ state, rerender: remount }) {
    if (!state.projectId) {
      return h('div', { class: 'empty' }, h('b', {}, '先去创作台选一个项目'), '设定集属于某个具体项目。');
    }
    let project = await api(`/projects/${state.projectId}`);
    const root = h('div', { class: 'stack' });
    const rerender = remount || (() => document.querySelector('#btn-refresh').click());

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
          // frozenAt 可能没有（老项目、手改过的 project.json）——
          // 没有就别显示，印一个 "Invalid Date" 比不印更糟
          bible.frozenAt && Number.isFinite(Date.parse(bible.frozenAt))
            ? h('span', { class: 'badge' }, `冻结于 ${new Date(bible.frozenAt).toLocaleString('zh-CN')}`)
            : null
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
      /**
       * 描述随时能改，没有"冻结/解冻"这一层。
       *
       * 试过加：生成完锁上、要改先解冻、改完再确认冻结。道理上像回事，
       * 用起来全是多余的点击 —— 设定集本来就是边看边调的东西，
       * 而真正需要防的从来不是手滑，是"改了不生效"。后者已经修好了
       * （见 studio.sheetPrompt 里那段注释）。
       *
       * 剩下两件事是分开的，这才是关键：
       *   存文字 —— 免费、立刻生效，下一批出图就按新描述走
       *   改完重出 —— 花钱，什么时候想让这张图跟上文字，什么时候点
       */
      const area = h('textarea', {
        rows: 4,
        style: 'font-size:11.5px',
        title: '改完点「存文字」（不花钱），想让图跟上就点「改完重出」'
      }, item.appearance || '');
      const nameInput = h('input', {
        type: 'text', class: 'mini', value: item.name,
        title: '改名会同步更新所有分镜里对它的引用'
      });
      /**
       * 出图提示词：**可选的覆盖**，默认空。
       *
       * 摆出来是因为踩过一个很难查的坑：这个字段以前由模型预填，
       * 而它一旦有值就会盖住上面的描述 —— 于是你改描述、重出图，
       * 画的还是旧描述，怎么重出都没用。现在它默认空、改描述会自动清掉，
       * 而且**看得见**。
       */
      const promptInput = h('textarea', {
        rows: 2, style: 'font-size:11px',
        placeholder: '留空 = 用上面的描述出图（推荐）。写了这里就以这里为准',
        value: (item.variants?.[0]?.sheetPrompt) || item.sheetPrompt || ''
      });
      /**
       * 音色：和种子一样是**身份的一部分**。
       * 全片一个音色，两个人对话时观众分不出谁在说话 ——
       * 画面上做了四层一致性，声音上却是同一个人配了所有角色。
       */
      const voiceList = state.catalog.providers.find((x) => x.id === state.catalog.routing.tts?.provider)?.voices || [];
      const voiceSel = kind === 'char'
        ? h('select', { class: 'mini' },
            h('option', { value: '' }, '（未指定，配音时自动分）'),
            voiceList.map((v) => h('option', { value: v.id, selected: v.id === item.voice }, v.label || v.id)),
            item.voice && !voiceList.some((v) => v.id === item.voice)
              ? h('option', { value: item.voice, selected: true }, `${item.voice}（当前）`)
              : null)
        : null;

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

      /** 只存文字，不出图。免费、立刻生效。 */
      async function saveText(extra = {}) {
        const r = await api(`/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}`, {
          method: 'PATCH',
          body: {
            name: nameInput.value,
            appearance: area.value,
            sheetPrompt: promptInput.value,
            ...(voiceSel ? { voice: voiceSel.value } : {}),
            ...extra
          }
        });
        if (r.renamed) {
          // 改名会牵动分镜里的引用，改了几处要说出来 —— 悄悄改动别人的数据很吓人
          toast(`已改名为「${r.renamedTo}」，同步更新了 ${r.renamed} 处分镜引用`, 'ok');
        }
        return r;
      }

      const saveBtn = h('button', {
        class: 'btn sm',
        title: '只存文字，不出图，不花钱。下一批出图就按新描述走',
        onclick: async () => {
          saveBtn.disabled = true;
          try {
            const r = await saveText();
            if (!r.renamed) toast(r.changed.length ? '已保存（没重出图，不花钱）' : '没有改动', 'ok');
            rerender();
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            saveBtn.disabled = false;
          }
        }
      }, '存文字');

      // 文字改过、图还是按旧描述出的 —— 这是最容易被忽略的一种不一致：
      // 提示词按新描述走，参考图却还是旧的那张，两边在打架
      const textNewer = item.textAt && item.sheetAt && Date.parse(item.textAt) > Date.parse(item.sheetAt);

      /**
       * 变体：另一套衣服 / 另一个时段。
       *
       * 关键是它们**共用条目的身份种子和身份锚** —— 换了衣服还是同一张脸，
       * 换了时段还是同一个码头。拆成两个独立条目做不到这一点
       * （见 core/pipeline/variants.js）。
       */
      const meta = VARIANT_META[kind];
      const list = item.variants || [];
      const variantHost = h('div', { class: 'variant-list' });
      for (const v of list) {
        const isDefault = v.id === 'v-default';
        const vName = h('input', {
          type: 'text', class: 'mini', value: v.name,
          disabled: isDefault, title: isDefault ? '默认那版就是身份基准本身，名字不用改' : ''
        });
        const vDesc = h('input', {
          type: 'text', class: 'mini',
          placeholder: isDefault ? '默认那版不用写 —— 它就是上面的身份描述' : `只写变的那部分，${meta.ph}`,
          value: v.appearance || '', disabled: isDefault
        });
        const vUrl = `/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/variants/${v.id}`;
        variantHost.append(
          h('div', { class: 'variant-row' },
            v.sheetPath
              ? h('img', {
                  class: 'variant-thumb zoomable',
                  src: `${mediaUrl(v.sheetPath)}&v=${Date.parse(v.sheetAt || '') || item.seed}`,
                  alt: v.name, loading: 'lazy',
                  onclick: () => openLightbox([{ src: mediaUrl(v.sheetPath), title: `${item.name}·${v.name}`, note: v.appearance || '' }], 0)
                })
              : h('div', { class: 'variant-thumb ph' }, '未出图'),
            h('div', { class: 'variant-main' }, vName, vDesc),
            h('div', { class: 'variant-acts' },
              isDefault ? null : h('button', {
                class: 'btn ghost sm',
                onclick: async () => {
                  try {
                    await api(vUrl, { method: 'PATCH', body: { name: vName.value, appearance: vDesc.value } });
                    toast('已保存（不花钱）。想让图跟上就点它的「出图」', 'ok');
                    rerender();
                  } catch (e) { toast(e.message, 'err'); }
                }
              }, '存'),
              h('button', {
                class: 'btn sm',
                title: '只重出这一版',
                onclick: async (ev) => {
                  ev.target.disabled = true;
                  try {
                    let err = null;
                    await stream(
                      `/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/regenerate`,
                      { variantId: v.id },
                      (e2) => { if (e2.type === 'error') err = e2.message; }
                    );
                    if (err) throw new Error(err);
                    toast(`${item.name}·${v.name} 已出`, 'ok');
                    rerender();
                  } catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
                }
              }, v.sheetPath ? '重出' : '出图'),
              isDefault ? null : h('button', {
                class: 'btn ghost sm',
                onclick: async () => {
                  if (!confirm(`删掉「${item.name}·${v.name}」这一版？指着它的分镜会退回默认那版。`)) return;
                  try {
                    const r = await api(vUrl, { method: 'DELETE' });
                    toast(r.cleared ? `已删除，${r.cleared} 个分镜退回默认那版` : '已删除', 'ok');
                    rerender();
                  } catch (e) { toast(e.message, 'err'); }
                }
              }, '删'))
          )
        );
      }

      const newVName = h('input', { type: 'text', class: 'mini', placeholder: meta.ph });
      const newVDesc = h('input', { type: 'text', class: 'mini', placeholder: '只写变的那部分' });
      variantHost.append(
        h('div', { class: 'variant-row new' },
          h('div', { class: 'variant-main' }, newVName, newVDesc),
          h('button', {
            class: 'btn ghost sm',
            onclick: async () => {
              if (!newVName.value.trim()) return toast(`先起个名字，${meta.ph}`, 'err');
              try {
                await api(`/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/variants`, {
                  method: 'POST', body: { name: newVName.value, appearance: newVDesc.value }
                });
                toast('已加一版。点它的「出图」出这一版的设定图', 'ok');
                rerender();
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '+ 加一版'))
      );

      return h('div', { class: 'sheet-card' },
        img,
        h('div', { class: 'sheet-body' },
          h('div', { class: 'sheet-name' },
            nameInput,
            // 标明这张图是谁出的。过两天没人分得清哪张是模型出的、哪张是自己传的，
            // 而这直接决定"重出一次"会不会把你传的图冲掉
            item.sheetSource === 'upload'
              ? h('span', { class: 'badge', title: item.sheetFileName || '你上传的图片' }, '自传图')
              : null),
          item.role ? h('div', { class: 'sheet-role' }, item.role) : null,
          h('div', { style: 'margin-top:8px' }, area),
          h('details', { class: 'shot-prompt', style: 'margin-top:6px' },
            h('summary', {}, item.sheetPrompt ? '出图提示词（已自定义）' : '出图提示词（默认跟着上面的描述走）'),
            h('div', { class: 'shot-prompt-body' },
              promptInput,
              item.sheetPromptUsed
                ? h('div', { class: 'shot-used', style: 'margin-top:6px' },
                    `上次真正发出去的：${item.sheetPromptUsed}`)
                : null)),
          textNewer
            ? h('div', { class: 'sheet-seed', style: 'margin-top:6px;color:var(--caution)' },
                '文字改过了，图还是按旧描述出的 —— 出图时提示词和参考图会打架。想让图跟上就点「改完重出」。')
            : null,
          voiceSel
            ? h('div', { class: 'sheet-actions' },
                h('span', { class: 'sheet-seed', style: 'flex:none' }, '音色'), voiceSel)
            : null,
          h('div', { class: 'sheet-actions' }, provSel, modelSel),
          item.sheetSource === 'upload'
            ? h('div', { class: 'sheet-seed', style: 'margin-top:6px' }, '这张是你传的，点「改完重出」会用模型重画一张盖掉它')
            : null,
          h('details', { class: 'shot-prompt', style: 'margin-top:8px' },
            h('summary', {}, `${meta.title}（${list.length} 版）`),
            h('div', { class: 'shot-prompt-body' },
              h('div', { style: 'margin-bottom:6px' }, meta.hint,
                '。所有版共用同一颗种子和上面那段身份描述 —— 这才是"换了衣服还是同一个人"的原因。'),
              variantHost)),
          h('div', { class: 'inline', style: 'margin-top:8px' },
            saveBtn,
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
