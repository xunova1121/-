/**
 * 设定集：已冻结的角色 / 场景 / 道具。
 *
 * 这一页是可以改的，而且值得改 —— 模型第一遍写的外貌描述往往偏笼统。
 * 手动把"藏青立领制服"这类具体的颜色和款式写进去，后面几十镜都跟着受益。
 */
import { h, clear, api, toast, mediaUrl } from '../lib.js';

export default {
  async render({ state }) {
    if (!state.projectId) {
      return h('div', { class: 'empty' }, h('b', {}, '先去创作台选一个项目'), '设定集属于某个具体项目。');
    }
    const project = await api(`/projects/${state.projectId}`);
    const root = h('div', { class: 'stack' });

    if (!project.bible) {
      return h('div', { class: 'empty' },
        h('b', {}, `「${project.title}」还没有设定集`),
        '回创作台跑第 01 步，模型会读一遍剧本，把角色和场景的外貌固定下来并出参考图。');
    }

    const bible = project.bible;

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
        )
      )
    );

    // ── 角色 / 场景 ──
    function section(title, hint, items, kind) {
      if (!items.length) return null;
      const grid = h('div', { class: 'sheet-grid' });
      for (const item of items) {
        const area = h('textarea', { rows: 5, style: 'font-size:11.5px' }, item.appearance);
        area.dataset.kind = kind;
        area.dataset.name = item.name;
        grid.append(
          h('div', { class: 'sheet-card' },
            item.sheetPath
              ? h('img', { src: mediaUrl(item.sheetPath), alt: `${item.name} 参考图`, loading: 'lazy' })
              : h('div', { class: 'ph' }, '参考图未生成'),
            h('div', { class: 'sheet-body' },
              h('div', { class: 'sheet-name' }, item.name),
              item.role ? h('div', { class: 'sheet-role' }, item.role) : null,
              h('div', { style: 'margin-top:8px' }, area),
              h('div', { class: 'sheet-seed' }, `seed ${item.seed}`)
            )
          )
        );
      }
      return h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, title, h('span', { class: 'badge' }, `${items.length}`)),
        h('p', { class: 'panel-hint' }, hint),
        grid
      );
    }

    const charSection = section(
      '角色',
      '每个角色一颗固定种子 + 一张设定图。出镜头图时，设定图会作为参考图一起送进模型 —— 这比任何文字描述都更能锁住脸和衣服。',
      bible.characters,
      'char'
    );
    const sceneSection = section(
      '场景',
      '场景基准图定住建筑、光线方向和色温。同一场景的不同镜头引用同一张，避免上一镜阴天下一镜晴天。',
      bible.scenes,
      'scene'
    );

    if (charSection) root.append(charSection);
    if (sceneSection) root.append(sceneSection);

    if (bible.props?.length) {
      root.append(
        h('div', { class: 'panel' },
          h('h2', { class: 'panel-title' }, '道具', h('span', { class: 'badge' }, `${bible.props.length}`)),
          h('p', { class: 'panel-hint' }, '镜头描述里提到道具名时，对应的外观描述会自动拼进提示词。'),
          h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, '名称'), h('th', {}, '外观'), h('th', { class: 'mono' }, 'SEED'))),
              h('tbody', {}, bible.props.map((p) =>
                h('tr', {}, h('td', {}, p.name), h('td', { class: 'wrap' }, p.appearance), h('td', { class: 'mono' }, p.seed))
              ))
            )
          )
        )
      );
    }

    // ── 操作 ──
    root.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '操作'),
        h('p', { class: 'panel-hint' },
          '改完记得保存。重新生成设定集会让人设整体漂移一次 —— 只在剧本大改后才这么做，已出的图不会自动跟着更新。'),
        h('div', { class: 'inline' },
          h('button', {
            class: 'btn primary',
            onclick: async (e) => {
              const btn = e.target;
              btn.disabled = true;
              const next = structuredClone(bible);
              next.style.anchor = anchorInput.value.trim();
              next.style.palette = paletteInput.value.trim();
              next.style.negative = negativeInput.value.trim();
              for (const area of root.querySelectorAll('textarea[data-kind]')) {
                const bucket = area.dataset.kind === 'char' ? next.characters : next.scenes;
                const target = bucket.find((x) => x.name === area.dataset.name);
                if (target) target.appearance = area.value.trim();
              }
              try {
                await api(`/projects/${project.id}`, { method: 'PATCH', body: { bible: next } });
                toast('设定已保存，下一批出图立刻生效', 'ok');
              } catch (err) {
                toast(err.message, 'err');
              } finally {
                btn.disabled = false;
              }
            }
          }, '保存设定'),
          h('button', {
            class: 'btn danger',
            onclick: () => {
              if (!confirm('重新生成会覆盖现有设定和参考图，已生成的镜头图不会自动更新，前后可能对不上。确定？')) return;
              toast('回创作台点第 01 步「设定集」即可重跑');
            }
          }, '重新生成设定集…')
        )
      )
    );

    return root;
  }
};
