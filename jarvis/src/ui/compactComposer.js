/** 手机输入区只改变布局；草稿、发送、停止与模型选择继续由原处理器负责。 */
export function initCompactComposer(form, input, model) {
  if (!document.body.classList.contains('compact')) return;
  let editing = false;
  let pressed = false;
  let keyboard = document.body.classList.contains('wy-keyboard-open');
  let frame = 0;
  const pickerOpen = () => model.getAttribute('aria-expanded') === 'true';
  function sync() {
    const nextKeyboard = document.body.classList.contains('wy-keyboard-open');
    if (keyboard && !nextKeyboard && !pickerOpen() && !pressed) editing = false;
    keyboard = nextKeyboard;
    if (editing && !pressed && !keyboard && !pickerOpen() && !form.contains(document.activeElement)) editing = false;
    const expanded = editing || pickerOpen();
    const changed = form.classList.contains('composer-editing') !== expanded;
    form.classList.toggle('composer-editing', expanded);
    // CSS限制收起高度，展开时按原文实际高度恢复，不截断或改写多行草稿。
    if (changed && expanded) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
    }
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  }
  function begin() { editing = true; sync(); }
  input.addEventListener('focus', begin);
  input.addEventListener('pointerdown', begin);
  form.addEventListener('focusout', schedule);
  // 按钮会在pointerdown后让输入框失焦；等原click处理完成才允许收起。
  form.addEventListener('pointerdown', () => { pressed = true; });
  const release = () => { requestAnimationFrame(() => { pressed = false; sync(); }); };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  new MutationObserver(schedule).observe(model, { attributes: true, attributeFilter: ['aria-expanded'] });
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
}
