/**
 * ══════════ 指令框（电脑端） ══════════
 *
 * 一句人话 → 先摆出**要做什么** → 你点了才执行。
 *
 * ── 中间那一步为什么不能省 ──
 *
 * 省掉就变成了"说一句话它就动手"。而这个应用里动手的代价是真钱
 * 和几十镜的文案 —— 一次说岔了要拿钱重跑。所以：
 *
 *   · 打字时实时预览。解析在服务端算，但纯字符串匹配，不调模型、不花钱，
 *     所以可以边打边看，而不是"点一下才知道它理解成了什么"
 *   · 执行按钮上写的是**这次到底动哪几镜、改成什么**，不是"确定"
 *   · 花钱的动作不在这儿执行，交回给原来那条预检 + 估算的路
 *
 * ── 为什么和表格视图放在一起 ──
 *
 * 两者互相印证：指令说"第 6-12 镜"，表格里就该看见那 7 行。
 * 分开放的话，用户没法确认它选的和他想的是不是同一批 ——
 * 而"选错了一批然后批量改"是这个框最坏的失败方式。
 */

import { h, clear, api, toast } from './lib.js';

export function commandBox(project, { onDone = () => {}, onGo = () => {} } = {}) {
  const box = h('input', {
    type: 'text',
    class: 'cmd-input',
    placeholder: '说一句话：第 6-12 镜改成中景 / 有父亲的镜头加上仰拍 / 第 22 镜为什么没图'
  });
  const preview = h('div', { class: 'cmd-preview' });
  const go = h('button', { class: 'btn sm', disabled: true }, '先说要做什么');
  let plan = null;

  const render = () => {
    if (!plan) {
      preview.className = 'cmd-preview';
      preview.textContent = '';
      go.disabled = true;
      go.textContent = '先说要做什么';
      return;
    }
    if (!plan.ok) {
      preview.className = 'cmd-preview bad';
      clear(preview);
      preview.append(h('span', {}, plan.why));
      /**
       * 看不懂的时候光说"看不懂"等于让人去猜我们支持什么句式。
       * 例子做成**可点的**：点一下直接填进去，比让他照着抄快得多。
       */
      for (const eg of plan.examples || []) {
        preview.append(h('button', {
          class: 'cmd-eg-btn',
          onclick: () => { box.value = eg; box.dispatchEvent(new Event('input')); }
        }, eg));
      }
      go.disabled = true;
      go.textContent = '没听懂';
      return;
    }
    preview.className = `cmd-preview ${plan.costs ? 'costly' : 'ok'}`;
    preview.textContent = plan.say
      + (plan.costs ? '　⚠ 这一步要花钱，按下去只是跳到那一步，还会再过一遍预检和估算。' : '');
    go.disabled = false;
    go.textContent = plan.verb === 'ask' ? '看一下' : plan.costs ? '去那一步' : `就这么改（${plan.targets.length} 镜）`;
  };

  let timer = null;
  box.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const text = box.value.trim();
      if (!text) { plan = null; render(); return; }
      try {
        plan = await api(`/projects/${project.id}/command`, { method: 'POST', body: { text } });
      } catch (err) {
        plan = { ok: false, why: err.message, examples: [] };
      }
      render();
    }, 250);
  };
  // 回车 = 按下执行按钮。手不用离开键盘，这个框才用得起来
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && !go.disabled) go.click();
  };

  go.onclick = async () => {
    if (!plan?.ok) return;
    if (plan.verb === 'edit') {
      go.disabled = true;
      try {
        const r = await api(`/projects/${project.id}/shots/batch`, {
          method: 'POST',
          body: {
            ids: plan.targets,
            patch: plan.patch,
            addSkills: plan.addSkills,
            removeSkills: plan.removeSkills
          }
        });
        /**
         * ⚠ 报的是**服务端说改了几镜**，不是我们请求了几镜。
         * 两者会不一样：本来就是这个值的那几镜不算改动。
         * 报请求数的话，"改了 7 镜"里可能有 5 镜根本没动 ——
         * 这个项目已经为"记的是意图不是事实"修过好几回了。
         */
        toast(r.changed ? `改了 ${r.changed} 镜（选中 ${r.total} 镜）` : '这几镜本来就是这个值，没动', 'ok');
        box.value = '';
        plan = null;
        render();
        onDone();
      } catch (err) {
        toast(err.message, 'bad');
        go.disabled = false;
      }
      return;
    }
    /**
     * 花钱的和"问一问"的都交回给现成的那条路 —— 预检、估算、停下来
     * 那一整套已经在流水线那一步上了。指令框不另起炉灶：另起一套的话，
     * 那几道闸门就会有一条绕过它们的近路。
     */
    if (plan.verb === 'run') {
      onGo(plan.stage);
      toast(`已跳到「${plan.say}」—— 确认清单之后再开始`, 'ok');
      return;
    }
    onGo(plan.topic === 'estimate' ? 'assets' : null, plan);
  };

  const undoBar = h('div', { class: 'undo-bar' });
  const paintUndo = async () => {
    clear(undoBar);
    let result;
    try { result = await api(`/projects/${project.id}/undo`); } catch { return; }
    if (!result.items?.length) return;
    const top = result.items[0];
    undoBar.append(
      h('button', {
        class: 'btn ghost sm',
        title: '把分镜表退回这一步之前；已经生成的图片和视频不删除',
        onclick: async () => {
          if (!window.confirm(`退回到「${top.label}」之前？\n\n分镜表会恢复到当时的 ${top.shots} 镜，已经生成的媒体文件不会删除。`)) return;
          await api(`/projects/${project.id}/undo/${top.n}`, { method: 'POST' });
          toast('已退回上一步', 'ok');
          onDone();
        }
      }, `↶ 撤销：${top.label}`),
      result.items.length > 1 ? h('span', { class: 'field-hint', style: 'margin:0' }, `还能再退 ${result.items.length - 1} 步`) : null
    );
  };
  paintUndo();

  return h('div', { class: 'cmd-box' },
    h('div', { class: 'cmd-row' }, box, go),
    preview,
    undoBar,
    h('div', { class: 'field-hint', style: 'margin:6px 0 0' },
      '它只会做你本来就能做的事，做之前先摆给你看。看不懂就说看不懂，不猜。'));
}
