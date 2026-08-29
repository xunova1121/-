/**
 * ══════════ 分镜表：一行一镜，能多选，能用键盘 ══════════
 *
 * ── 这个视图存在的理由 ──
 *
 * 卡片视图一屏放得下三四镜。五十镜的片子要滚十几屏，而**改一样东西**
 * （时长、技法卡、档位）往往要挨个点开、改、关掉、再点下一个。
 * 那是这个应用里最大的一块时间黑洞，而且它不产生任何创作价值 ——
 * 纯粹是操作损耗。
 *
 * 表格视图不替代卡片：看画面还是卡片好（缩略图大、状态全）。
 * 表格解决的是**通读和批量改**这两件卡片做不好的事。
 *
 * ── 为什么必须能用键盘 ──
 *
 * 通读五十镜时，手离开键盘去够鼠标、点一下、再回来，一镜要两秒；
 * 上下键则是每镜零点几秒。这个差别在五十镜上是一分钟对十秒。
 * 而且键盘操作让"连选一段"变成 Shift+↓ 按住不放 —— 鼠标框选在
 * 一个会滚动的长列表里非常难用。
 *
 * ⚠ **快捷键必须在输入框里失效。**
 *
 * 这一条不是细节：表格里有可以就地编辑的输入框，人在里面打字时按下 j
 * 要出现一个 j，而不是跳到下一镜。漏了这一条的表格，第一次输入就会
 * 让人觉得"这东西坏了"—— 而且他不会再试第二次。
 */

/** 一行显示得下的长度。太长会把表格撑成卡片，那就白做了 */
const CLIP = 46;
const clip = (s, n = CLIP) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 这一镜跑到哪一步了。
 *
 * ⚠ 用**文字**不用纯色点：颜色在深浅两套主题、在色觉差异上都不可靠，
 * 而这一列是人扫视时唯一要看的东西。颜色做辅助，字是本体。
 */
function statusOf(shot) {
  if (shot.videoPath) return { text: '视频', tone: 'done' };
  if (shot.imagePath) return { text: '图', tone: 'half' };
  return { text: '待出', tone: 'todo' };
}

/**
 * @param shots      已经按镜号排好的那一份
 * @param selected   Set<shotId>，**由调用方持有** —— 表格重画时选择不能丢，
 *                   而重画在这个界面上非常频繁（跑完一镜就刷新一次）
 * @param onSelect   选择变了
 * @param onOpen     要打开某一镜的完整编辑器（双击 / Enter）
 * @param skillNames id → 中文名，用来在行里显示技法卡
 */
export function shotTable(shots, {
  selected = new Set(),
  onSelect = () => {},
  onOpen = () => {},
  onPatch = null,
  skillNames = {}
} = {}) {
  const host = document.createElement('div');
  host.className = 'shot-table-wrap';
  const table = document.createElement('table');
  table.className = 'shot-table';
  host.append(table);

  const head = document.createElement('thead');
  head.innerHTML = '<tr>'
    + '<th class="c-pick"></th><th class="c-no">镜</th><th class="c-desc">画面</th>'
    + '<th class="c-cam">景别</th><th class="c-dur">时长</th>'
    + '<th class="c-skill">技法</th><th class="c-st">状态</th></tr>';
  table.append(head);

  const body = document.createElement('tbody');
  table.append(body);

  /** 键盘焦点落在第几行。和"选中"是两回事 —— 焦点是光标，选中是勾 */
  let cursor = 0;
  /** Shift 连选的锚点。没有它的话，Shift+↓ 只能一格一格加，退不回去 */
  let anchor = 0;

  const rows = [];

  const paintRow = (row, shot) => {
    row.classList.toggle('picked', selected.has(shot.id));
  };

  const setCursor = (n, { scroll = true } = {}) => {
    cursor = Math.max(0, Math.min(shots.length - 1, n));
    rows.forEach((r, i) => r.classList.toggle('cursor', i === cursor));
    if (scroll && rows[cursor]) rows[cursor].scrollIntoView({ block: 'nearest' });
  };

  const toggle = (i, { range = false } = {}) => {
    if (range) {
      const [a, b] = anchor <= i ? [anchor, i] : [i, anchor];
      for (let n = a; n <= b; n += 1) selected.add(shots[n].id);
    } else {
      const id = shots[i].id;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = i;
    }
    rows.forEach((r, n) => paintRow(r, shots[n]));
    onSelect(selected);
  };

  shots.forEach((shot, i) => {
    const row = document.createElement('tr');
    row.dataset.shotId = shot.id;
    row.dataset.shotIndex = String(shot.index);

    const pick = document.createElement('td');
    pick.className = 'c-pick';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(shot.id);
    box.onclick = (e) => {
      e.stopPropagation();
      setCursor(i, { scroll: false });
      toggle(i, { range: e.shiftKey });
      box.checked = selected.has(shot.id);
    };
    pick.append(box);

    const no = document.createElement('td');
    no.className = 'c-no';
    no.textContent = String(shot.index);

    const desc = document.createElement('td');
    desc.className = 'c-desc';
    desc.title = shot.description || '';
    desc.textContent = clip(shot.description) || '（没写画面）';

    const cam = document.createElement('td');
    cam.className = 'c-cam';
    cam.textContent = clip(shot.camera, 8) || '—';

    /**
     * 时长**就地可改**。
     *
     * 这是表格里唯一一个可以直接编辑的字段，因为它是批量调整里最常改的
     * 一样，而且它没有歧义（一个数）。描述、台词这些要在完整编辑器里改 ——
     * 在一个一行高的格子里改一段话，比点开编辑器还难受。
     */
    const dur = document.createElement('td');
    dur.className = 'c-dur';
    if (onPatch) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.5';
      inp.min = '0.5';
      inp.value = String(shot.duration || '');
      inp.className = 'cell-num';
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => onPatch(shot.id, { duration: Number(inp.value) });
      dur.append(inp);
    } else {
      dur.textContent = shot.duration ? `${shot.duration}s` : '—';
    }

    const skill = document.createElement('td');
    skill.className = 'c-skill';
    const names = (shot.skills || []).map((id) => skillNames[id] || id);
    skill.title = names.join('、');
    skill.textContent = names.length ? clip(names.join('、'), 18) : '—';
    if (!names.length) skill.classList.add('none');

    const st = statusOf(shot);
    const status = document.createElement('td');
    status.className = `c-st ${st.tone}`;
    status.textContent = st.text;

    row.append(pick, no, desc, cam, dur, skill, status);
    row.onclick = () => setCursor(i);
    row.ondblclick = () => onOpen(shot);
    body.append(row);
    rows.push(row);
    paintRow(row, shot);
  });

  setCursor(0, { scroll: false });

  /**
   * ⚠ **在输入框里一律不接管按键。**
   *
   * 表格里有就地编辑的数字框。人在里面打字时按下 j 要出现一个 j，
   * 而不是跳到下一镜。漏了这一条的表格，第一次输入就会让人觉得
   * "这东西坏了"，而且他不会再试第二次。
   */
  const inField = (t) => {
    const tag = (t?.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
  };

  host.tabIndex = 0;
  host.onkeydown = (e) => {
    if (inField(e.target)) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setCursor(cursor + 1);
      // Shift 按着就是连选：这是长列表里选一段最快的方式
      if (e.shiftKey) toggle(cursor, { range: true });
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setCursor(cursor - 1);
      if (e.shiftKey) toggle(cursor, { range: true });
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle(cursor);
      const box = rows[cursor]?.querySelector('input[type=checkbox]');
      if (box) box.checked = selected.has(shots[cursor].id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(shots[cursor]);
    } else if (e.key === 'Escape') {
      /**
       * 清空选择。没有这一下的话，选了二十镜之后想重来只能一个个点掉 ——
       * 而"我到底选了哪些"在滚动过的长列表里是看不全的。
       */
      selected.clear();
      rows.forEach((r, n) => paintRow(r, shots[n]));
      rows.forEach((r) => { const b = r.querySelector('input[type=checkbox]'); if (b) b.checked = false; });
      onSelect(selected);
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      shots.forEach((s) => selected.add(s.id));
      rows.forEach((r, n) => paintRow(r, shots[n]));
      rows.forEach((r) => { const b = r.querySelector('input[type=checkbox]'); if (b) b.checked = true; });
      onSelect(selected);
    }
  };

  return {
    node: host,
    focus: () => host.focus(),
    /** 外面改了选择（比如"全选这一场"）之后，让表格跟上 */
    refresh: () => {
      rows.forEach((r, n) => {
        paintRow(r, shots[n]);
        const b = r.querySelector('input[type=checkbox]');
        if (b) b.checked = selected.has(shots[n].id);
      });
    }
  };
}
