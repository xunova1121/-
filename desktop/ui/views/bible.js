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

/**
 * "你选的画风，和设定集里冻结的那段话对不上了。"
 *
 * 两种情况会走到这里：换了画风；或者预设本身被改进了（比如给古风工笔补上留白和逆光）。
 * 以前这两种情况都只能重跑第 01 步，代价是手改过的角色外貌全丢 —— 为了换一句话不值。
 *
 * 所以这里只换风格锚这一段，别的一个字不动。**必须让人先看见要换成什么**再点，
 * 因为这会盖掉手写的风格描述；直接偷偷换掉，等于让人改的字凭空消失。
 */
function driftNotice(project, anchorInput, paletteInput, negativeInput) {
  const host = h('div', {});

  /**
   * 重进这一步要重查一遍。
   *
   * 设定集面板只在第一次打开时挂载，之后切走再回来不重新拉数据 —— 那是有意的，
   * 免得把正在改的字冲掉。但换画风恰恰是在**别的页面**做的，回来时面板还是老的，
   * 提示永远冒不出来。所以这里单独听一下：只重查画风这一件事，别的一个字不动。
   */
  const onStage = () => {
    if (!host.isConnected) return window.removeEventListener('fd:stage', onStage);
    return run();
  };
  window.addEventListener('fd:stage', onStage);

  const run = () => api(`/projects/${project.id}/style`)
    .then((d) => {
      clear(host);
      if (!d.drifted) return;
      host.append(
        h('div', { class: 'notice warn' },
          h('b', {}, `画风「${d.name}」的预设和这里冻结的不一样`),
          h('p', {},
            '风格锚是跑第 01 步时冻结的，所以换画风、或者预设本身有改进，都不会自动生效。'
            + '按下面这个按钮只换这一段话，角色和场景的描述、参考图、种子一个都不动。'),
          h('div', { class: 'diff-pair' },
            h('div', {}, h('label', {}, '现在是'), h('code', {}, d.current.anchor)),
            h('div', {}, h('label', {}, '换成'), h('code', {}, d.preset.anchor))),
          h('button', {
            class: 'btn sm',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                // cap:style-sync
                const out = await api(`/projects/${project.id}/style/sync`, { method: 'POST' });
                // 直接把输入框里的字换掉 —— 不整页重画，免得把正在改的别处冲掉
                anchorInput.value = out.style.anchor;
                paletteInput.value = out.style.palette || '';
                negativeInput.value = out.style.negative || '';
                clear(host);
                toast('画风已同步，下一批出图生效。已经出过的图要重出才会跟着变', 'ok');
              } catch (err) {
                toast(err.message, 'err');
                e.target.disabled = false;
              }
            }
          }, '换成预设的那一段')
        )
      );
    })
    .catch(() => {
      /* 查不到就当没这回事，不能因为一个提示把整页挡住 */
    });

  run();
  return host;
}

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

    /**
     * ── 老的半身设定图，提醒一下 ──
     *
     * 角色设定图从「正面半身」改成了「一张四视图」（上半身特写 + 全身正/侧/背）。
     * 但**已经出过的图不会自己变** —— 改的是提示词，不是磁盘上那张 png。
     *
     * 不提醒的话，老项目在这一页看起来完全没变化，用户会以为这个改动没生效，
     * 或者更糟：以为已经生效了，然后继续在半身图的基础上出视频，
     * 而全景和背影照样每镜一个样。
     *
     * 认老图靠 sheetPromptUsed（上次真正发出去的那句话）—— 它记的是**事实**，
     * 不是"应该发什么"。按理该发的那句话现在人人都一样，只有真发过的那句能分辨新旧。
     */
    const staleChars = (bible.characters || []).filter((c) => {
      const used = c.sheetPromptUsed || '';
      // 没出过图的不算"旧"，那是"还没出" —— 两件事，提示语也不一样
      return c.sheetPath && !used.includes('角色三视图');
    });

    // ── 全片风格锚 ──
    const anchorInput = h('textarea', { rows: 2 }, bible.style.anchor);
    const paletteInput = h('input', { type: 'text', value: bible.style.palette || '' });
    const negativeInput = h('textarea', { rows: 2 }, bible.style.negative);

    if (staleChars.length) {
      const redoAll = h('button', { class: 'btn sm primary' }, `重出这 ${staleChars.length} 张（要花钱）`);
      const status = h('span', { class: 'field-hint' });
      redoAll.onclick = async () => {
        redoAll.disabled = true;
        let done = 0;
        for (const c of staleChars) {
          status.textContent = `正在重出「${c.name}」（${done + 1}/${staleChars.length}）…`;
          try {
            await stream(
              // cap:sheet-regen
              `/projects/${project.id}/bible/char/${encodeURIComponent(c.name)}/regenerate`,
              { appearance: c.appearance || '' },
              (ev) => { if (ev.type === 'error') toast(ev.message, 'err'); }
            );
            done += 1;
          } catch (err) {
            toast(`「${c.name}」没出成：${err.message}`, 'err');
          }
        }
        status.textContent = `重出了 ${done} 张`;
        toast(done ? `${done} 张已换成三视图` : '一张都没出成', done ? 'ok' : 'err');
        rerender();
      };
      root.append(
        h('div', { class: 'panel' },
          h('h2', { class: 'panel-title' }, '这几张还是老的半身图',
            h('span', { class: 'badge' }, `${staleChars.length} 个角色`)),
          h('p', { class: 'panel-hint' },
            // 纯文本节点里写 ** 只会原样印出来，要强调就用元素（这个坑本仓库踩过）
            '角色设定图现在出的是', h('b', {}, '一张四视图'), '：上半身特写 + 全身正面 / 侧面 / 背面。'
            + '下面这几位的图是改之前出的，只有正面半身 —— '
            + '半身图里没有腿、没有鞋、没有后脑勺、没有衣服背面，'
            + '所以全景一出，裤子和鞋每镜一个样；人一转身，后背的图案是模型现编的。'
            + '而复核那一层比的全是半身图里有的东西，永远判 pass，不会报错。'),
          h('p', { class: 'panel-hint' },
            h('b', {}, staleChars.map((c) => c.name).join('、')),
            '。重出会**按当前描述重画**，脸有可能和现在这张不完全一样 —— '
            + '还没出过分镜图的话现在换最划算；已经出了一半，换完那些镜要跟着重出才对得上。'),
          h('div', { class: 'inline' }, redoAll, status))
      );
    }

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
        driftNotice(project, anchorInput, paletteInput, negativeInput),
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
              // cap:sheet-regen
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

      /**
       * 补角度：侧面 / 背面 / 俯视平面。
       *
       * 默认不出，是因为一个角色从 1 张变 3 张、一个场景变 4 张 ——
       * 十个条目就是三四十张图，而多数片子里大部分角色从头到尾都是正面。
       * 谁需要谁补，让钱花在看得出差别的地方。
       *
       * 补出来之后，出图和出视频会**按这一镜的朝向自动挑**：
       * 描述里有"背对/背影/转身离开"就发背面那张，有"俯拍"就发俯视图。
       */
      // 角度表由 /catalog 下发 —— ui/ 不能 import core/ 里的模块（那些文件不发给浏览器）
      const angleSet = (state.catalog.sheetAngles || {})[kind] || [];
      const primaryVariant = item.variants?.[0] || item;
      const have = new Set((primaryVariant.angles || []).filter((a) => a?.sheetPath).map((a) => a.id));
      const angleBtn = angleSet.length
        ? h('button', {
          class: 'btn ghost sm',
          disabled: !item.sheetPath,
          title: item.sheetPath
            ? `补出${angleSet.map((a) => a.label).join(' / ')}。拿正面那张当参考画，保证还是同一个`
            : '要先有主图 —— 补角度是拿主图当参考画出来的',
          onclick: async () => {
            const missing = angleSet.filter((a) => !have.has(a.id));
            const todo = missing.length ? missing : angleSet;
            if (!confirm(
              `给「${item.name}」补 ${todo.length} 张：${todo.map((a) => a.label).join('、')}\n\n`
              + `每张都是一次出图开销。补出来之后，需要那个朝向的镜头会自动改用对应的图。`
            )) return;
            angleBtn.disabled = true;
            const label = angleBtn.textContent;
            angleBtn.textContent = '补图中…';
            try {
              let err = null;
              await stream(
                // cap:sheet-angles
                `/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/angles`,
                { angles: todo.map((a) => a.id) },
                (ev) => {
                  if (ev.type === 'finished' && ev.project) project = ev.project;
                  if (ev.type === 'error') err = ev.message;
                  if (ev.type === 'sheet' && ev.message) angleBtn.textContent = ev.message.slice(0, 12);
                }
              );
              if (err) throw new Error(err);
              toast(`${item.name} 的角度补好了`, 'ok');
              rerender();
            } catch (e) {
              toast(e.message, 'err');
            } finally {
              angleBtn.disabled = false;
              angleBtn.textContent = label;
            }
          }
        }, have.size ? `补角度（已有 ${have.size}/${angleSet.length}）` : '补角度')
        : null;

      /** 只存文字，不出图。免费、立刻生效。 */
      async function saveText(extra = {}) {
        // cap:bible-edit
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
            angleBtn,
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
