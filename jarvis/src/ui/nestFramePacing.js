// 只在电脑小窝刚显示或换姿势时短暂采样。同一轮多次慢帧才降低装饰动画的插值频率。
export function createNestFramePacing(scene) {
  let frame = 0, paced = false;

  function sample() {
    if (frame || paced || document.hidden || !scene.closest('.wb-desk')) return;
    let last = null, samples = 0, slow = 0;
    function measure(time) {
      frame = 0;
      if (document.hidden || !scene.isConnected) return;
      if (last !== null) {
        samples++;
        if (time - last >= 65) slow++;
        if (slow >= 3) {
          paced = true;
          scene.setAttribute('data-paced-motion', '');
          return;
        }
        if (samples >= 32) return;
      }
      last = time;
      frame = requestAnimationFrame(measure);
    }
    frame = requestAnimationFrame(measure);
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  return { sample, stop };
}
