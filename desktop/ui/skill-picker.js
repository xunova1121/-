/**
 * 技法选择器：镜头运用、机位、光线、动作、氛围。
 *
 * 两条界面上的规矩，都是为了**让界面和事实一致**：
 *
 *   ① 互斥组做成单选（再点一下取消）。让人先选出一个自相矛盾的组合、
 *      再弹个错误告诉他不行，是很差的设计 —— 不能同时仰拍又俯拍，
 *      那就不该让他点得下去。
 *   ② 运镜类标出"只影响视频"。在出图那一步选了运镜却什么都没变，
 *      会让人以为功能坏了，其实是它本来就不作用于静态图。
 */
import { h, clear, api, toast } from './lib.js';

/**
 * @param groups  /api/skills 回来的分组清单
 * @param picked  当前已选的 id 数组（会被就地更新）
 * @param onChange 每次变化回调，参数是新的 id 数组
 */
export function skillPicker(groups, picked, onChange) {
  const chosen = new Set(picked || []);
  const root = h('div', { class: 'skill-picker' });

  function repaint() {
    clear(root);
    for (const g of groups) {
      if (!g.skills?.length) continue;
      const row = h('div', { class: 'skill-row' });
      for (const s of g.skills) {
        const on = chosen.has(s.id);
        row.append(h('button', {
          type: 'button',
          class: `skill-chip ${on ? 'on' : ''} ${s.custom ? 'custom' : ''}`,
          title: [s.hint, s.fragment].filter(Boolean).join('\n— 发给模型的原话：'),
          onclick: () => {
            if (on) {
              chosen.delete(s.id);
            } else {
              // 互斥组：先把同组的其它选择摘掉，再选中这个
              if (g.exclusive) for (const x of g.skills) chosen.delete(x.id);
              chosen.add(s.id);
            }
            const next = [...chosen];
            picked.length = 0;
            picked.push(...next);
            repaint();
            onChange?.(next);
          }
        }, s.name));
      }
      root.append(
        h('div', { class: 'skill-group' },
          h('div', { class: 'skill-group-head' },
            h('span', { class: 'skill-group-name' }, g.name),
            g.exclusive ? h('span', { class: 'skill-group-tag' }, '单选') : null,
            g.slot === 'motion' ? h('span', { class: 'skill-group-tag' }, '只影响视频') : null,
            h('span', { class: 'skill-group-hint' }, g.hint)),
          row)
      );
    }
  }

  repaint();
  return root;
}

/**
 * 自己加一张技法卡。
 *
 * 存在数据目录里、不挂项目 —— 你总结出来的手法应该跨项目复用，
 * 而不是换个项目就得重写一遍。
 */
export function customSkillForm(groups, onAdded) {
  const name = h('input', { type: 'text', placeholder: '技法名，例：低速快门拖影' });
  const frag = h('input', { type: 'text', placeholder: '发给模型的那句话（越具体越稳）' });
  const group = h('select', {}, groups.map((g) => h('option', { value: g.id }, g.name)));

  const btn = h('button', {
    class: 'btn sm',
    onclick: async () => {
      btn.disabled = true;
      try {
        const r = await api('/skills', {
          method: 'POST',
          body: { name: name.value, fragment: frag.value, group: group.value }
        });
        name.value = '';
        frag.value = '';
        toast('已加入技法库，所有项目都能用', 'ok');
        onAdded?.(r.groups);
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }
  }, '加进技法库');

  return h('details', { class: 'shot-prompt' },
    h('summary', {}, '自己加一张技法卡'),
    h('div', { class: 'shot-prompt-body' },
      h('div', { style: 'margin-bottom:6px' },
        '写清楚"发给模型的那句话"是关键：把术语和它的', h('b', {}, '视觉结果'),
        '一起给，命中率高得多 —— "伦勃朗光"不如"侧上方主光，暗侧颧骨下形成三角形光斑"。'),
      h('div', { class: 'inline', style: 'flex-wrap:wrap' }, group, name),
      frag,
      btn));
}
