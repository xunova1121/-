/**
 * 手机上的建议：没有舞台，光核旁边的三条建议改成输入框上方一排可点的小标签。
 * 接口和 callouts.js 一致（set / show / retract / items / visible / pick）。
 */
export function initChips({ onPick }) {
  const bar = document.createElement('div');
  bar.className = 'chip-bar';
  bar.setAttribute('aria-label', '建议');
  document.querySelector('.composer')?.before(bar);
  let items = [];
  let shown = false;

  function pick(item) {
    if (!item) return;
    retract();
    onPick?.(item);
  }
  function set(next) {
    items = (next || []).filter(Boolean).slice(0, 3);
    bar.replaceChildren(...items.map((item) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = item.title;
      b.title = item.prompt ? `发送：${item.prompt}` : `打开：${item.title}`;
      b.addEventListener('click', () => pick(item));
      return b;
    }));
    show();
  }
  function show() {
    shown = items.length > 0;
    bar.hidden = !shown;
  }
  function retract() {
    shown = false;
    bar.hidden = true;
  }
  return {
    set,
    retract,
    show,
    get items() { return items; },
    get visible() { return shown; },
    pick: (i) => pick(items[i])
  };
}
