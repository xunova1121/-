import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNestRadio } from '../src/ui/nestRadio.js';

const events = vi.hoisted(() => ({ stopWorkshopHum: vi.fn(), workshopHumTitle: vi.fn() }));
vi.mock('../src/ui/workshopHum.js', () => events);

function control() {
  return Object.assign(new EventTarget(), { dataset: {}, setAttribute(key, value) { this[key] = value; } });
}
function mount() {
  const scene = control();
  const audio = Object.assign(new EventTarget(), {
    paused: true, src: '', currentTime: 0,
    play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  });
  const dial = control(), toggle = control(), next = control(), onMusic = vi.fn();
  scene.append = () => {};
  document.createElement = () => audio;
  const player = createNestRadio({ scene, dial, toggle, next, onMusic });
  player.setVisible(true);
  return { player, scene, audio, dial, toggle, next, onMusic };
}

describe('电视上的收音机', () => {
  beforeEach(() => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal('window', new EventTarget());
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('直接点物件播放、断点续播，换曲和自然播完使用下一份独立录音', () => {
    const { player, dial, audio, toggle } = mount();
    expect(audio.src).toBe('');
    dial.onclick();
    expect(dial['aria-pressed']).toBe('true');
    const first = audio.src;
    audio.currentTime = 4.2;
    dial.onclick();
    expect(audio.paused).toBe(true);
    player.flip();
    expect(audio.src).toBe(first);
    expect(audio.currentTime).toBe(4.2);
    player.next();
    const second = audio.src;
    expect(toggle.textContent).toContain('凤阳花鼓');
    audio.dispatchEvent(new Event('ended'));
    expect(new Set([first, second, audio.src]).size).toBe(3);
    expect(toggle.textContent).toContain('小白菜');
    audio.dispatchEvent(new Event('ended'));
    expect(audio.src).toBe(first);
  });

  it('电视、哼唱、后台与离开工作台能各自停声，回到前台继续等用户点播', () => {
    const { player, scene, audio, dial } = mount();
    const close = vi.fn();
    scene.dataset.mediaDevice = 'tv';
    scene.addEventListener('workshop:close-media', close);
    dial.onclick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(events.stopWorkshopHum).toHaveBeenCalledTimes(1);
    scene.dispatchEvent(new CustomEvent('workshop:media-opening', { detail: { device: 'monitor' } }));
    expect(audio.paused).toBe(false);
    scene.dispatchEvent(new CustomEvent('workshop:media-opening', { detail: { device: 'tv' } }));
    expect(audio.paused).toBe(true);
    dial.onclick();
    events.workshopHumTitle.mockReturnValue('茉莉花');
    window.dispatchEvent(new Event('jarvis:workshop-song'));
    expect(audio.paused).toBe(true);
    dial.onclick();
    window.dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: false } }));
    expect(audio.paused).toBe(true);
    dial.onclick();
    player.setVisible(false);
    player.next();
    player.setVisible(true);
    expect(audio.paused).toBe(true);
    dial.onclick();
    player.setNest(false);
    expect(dial.hidden && audio.paused).toBe(true);
  });

  it('猫咪语音和叫声压低收音机，结束、切工位或离开都恢复进入前的音量而不复播', () => {
    const { player, scene, audio, dial } = mount();
    const cue = playing => scene.dispatchEvent(new CustomEvent('workshop:cat-sound', { detail: { playing } }));
    audio.volume = .4;
    dial.onclick();
    cue(true);
    cue(true);
    expect(audio.volume).toBeCloseTo(.088);
    expect(audio.paused).toBe(false);
    player.next();
    expect(audio.volume).toBeCloseTo(.088);
    cue(false);
    expect(audio.volume).toBe(.4);
    cue(true);
    player.setVisible(false);
    expect(audio.volume).toBe(.4);
    expect(audio.paused).toBe(true);
    player.setVisible(true);
    cue(true);
    player.setNest(false);
    expect(audio.volume).toBe(.4);
    expect(audio.paused).toBe(true);
  });

  it('快速换歌后忽略被上一首打断的播放请求，仅当前曲目出错时显示重试', async () => {
    const { player, audio, dial, toggle } = mount();
    let rejectOld;
    audio.play = () => new Promise((resolve, reject) => { rejectOld = reject; });
    dial.onclick();
    audio.play = () => { audio.paused = false; audio.dispatchEvent(new Event('playing')); return Promise.resolve(); };
    player.next();
    rejectOld(new Error('切歌打断'));
    await Promise.resolve();
    expect(audio.paused).toBe(false);
    audio.error = { code: 3 };
    audio.dispatchEvent(new Event('error'));
    expect(audio.paused).toBe(true);
    expect(toggle.textContent).toContain('重试');
  });
});
