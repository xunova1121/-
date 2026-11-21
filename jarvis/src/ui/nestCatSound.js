import greeting from './assets/nestAudio/pet-greeting.mp3';

// 手机要求在用户手势中解锁音频。只有猫接受抚摸后才接入扬声器。
export function createNestCatSound(scene) {
  let context, decoded, source, generation = 0;
  function prepare() {
    const Engine = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Engine) return;
    try {
      context ||= new Engine();
      if (context.state !== 'running') context.resume().catch(() => {});
      if (!decoded) {
        const owner = context;
        decoded = fetch(greeting).then(async response => {
          if (!response.ok) throw new Error('猫咪音效未载入');
          return owner.decodeAudioData(await response.arrayBuffer());
        }).catch(() => { if (owner === context) decoded = null; return null; });
      }
    } catch { /* 静音或当前设备不支持 Web Audio 时，猫仍能用动作回应。 */ }
  }
  // 只有音轨确实接入了扬声器才让收音机让出音量，结束或被打断时成对还原。
  function sounding(playing) {
    if ((scene.dataset.catSound === 'playing') === playing) return;
    if (playing) scene.dataset.catSound = 'playing';
    else delete scene.dataset.catSound;
    scene.dispatchEvent(new CustomEvent('workshop:cat-sound', { detail: { playing } }));
  }
  function stop() {
    generation++;
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = null;
    }
    sounding(false);
  }
  async function play() {
    stop();
    const turn = generation, owner = context;
    const buffer = await decoded;
    if (!buffer || !owner || turn !== generation || document.hidden || owner.state !== 'running') return;
    const sound = owner.createBufferSource();
    sound.buffer = buffer;
    sound.connect(owner.destination);
    sound.onended = () => {
      sound.disconnect();
      if (source === sound) { source = null; sounding(false); }
    };
    source = sound;
    sound.start();
    sounding(true);
  }
  function release() {
    stop();
    const owner = context;
    context = decoded = null;
    if (owner && owner.state !== 'closed') owner.close().catch(() => {});
  }
  return { prepare, play, stop, release };
}
