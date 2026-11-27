// 把仓库中的传统曲谱编成器乐录音：拨弦与竹笛轮流主奏，以低音和琶音托住旋律。
// 仅制作资源时需要本机 ffmpeg，手机直接播放打包好的 MP3。
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workshopTunes } from '../src/ui/workshopTunes.js';

const output = new URL('../src/ui/assets/nestRadio/', import.meta.url);
mkdirSync(output, { recursive: true });
const frequency = note => 440 * 2 ** ((note - 69) / 12);
const rate = 32000;
const circle = 2 * Math.PI;
const arrangements = [
  { file: 'jasmine', roots: [48, 55, 45, 55, 48, 53, 55, 48], first: 'flute' },
  { file: 'flower-drum', roots: [45, 48, 45, 48, 53, 55, 45, 50], first: 'pluck' },
  { file: 'little-cabbage', roots: [48, 45, 53, 55], first: 'flute' }
];

function render(tune, arrangement) {
  const beat = 60 / tune.bpm;
  const bar = tune.title === '小白菜' ? 5 : 4;
  const phrase = tune.notes.reduce((sum, [, duration]) => sum + duration, 0);
  const total = (phrase * 2 + 5) * beat + 2;
  const samples = new Float32Array(Math.ceil(total * rate));
  function note(instrument, pitch, start, duration, gain) {
    const plucked = instrument === 'pluck';
    const tail = plucked ? .38 : .12;
    const length = duration + tail;
    const offset = Math.round(start * rate);
    let phase = 0;
    const increment = circle * frequency(pitch) / rate;
    for (let i = 0; i < length * rate && offset + i < samples.length; i++) {
      const t = i / rate;
      const vibrato = plucked ? 0 : .003 * Math.min(1, t * 3) * Math.sin(circle * 5.1 * t);
      phase += increment * (1 + vibrato - (plucked ? 0 : .012 * Math.exp(-24 * t)));
      const release = Math.min(1, (length - t) / tail);
      let value;
      if (plucked) {
        const envelope = Math.min(1, t * 260) * Math.exp(-3 * t) * release;
        value = envelope * (Math.sin(phase) + .48 * Math.sin(2 * phase) * Math.exp(-6 * t) +
          .26 * Math.sin(3.003 * phase) * Math.exp(-4 * t) + .14 * Math.sin(5.007 * phase) * Math.exp(-8 * t));
      } else {
        const envelope = Math.min(1, t / .065) * release * (.93 + .07 * Math.sin(circle * 3.7 * t));
        value = envelope * (Math.sin(phase) + .22 * Math.sin(2 * phase) + .08 * Math.sin(3 * phase));
      }
      samples[offset + i] += gain * value;
    }
  }
  const roots = arrangement.roots;
  // 两拍引子，第二遍换主奏，结尾留余响。
  note('pluck', roots[0], .09, beat, .15);
  note('pluck', roots[0] + 7, beat + .09, beat, .11);
  for (let verse = 0; verse < 2; verse++) {
    const start = .10 + (2 + verse * phrase) * beat;
    const lead = verse === 0 ? arrangement.first : arrangement.first === 'flute' ? 'pluck' : 'flute';
    let count = 0;
    for (const [pitch, duration] of tune.notes) {
      note(lead, pitch + (lead === 'flute' ? 12 : 0), start + count * beat, duration * beat * .87, .27);
      count += duration;
    }
    for (let at = 0; at < phrase; at += bar) {
      const root = roots[Math.floor(at / bar) % roots.length];
      for (let j = 0; j < bar && at + j < phrase; j++) {
        const pitch = root + [0, 7, 12, 7, 12][j];
        note('pluck', pitch, start + (at + j) * beat + .012, beat, j ? .085 : .14);
      }
    }
  }
  note('pluck', tune.notes.at(-1)[0] - 12, .15 + (2 + phrase * 2) * beat, beat * 2, .12);
  // 轻微室内早期反射，保留老收音机单声道的近距离感。
  const taps = [[.037, .11], [.079, .075], [.131, .03]];
  const encoded = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let value = samples[i];
    for (const [seconds, level] of taps) value += (samples[i - Math.round(seconds * rate)] || 0) * level;
    encoded.writeInt16LE(Math.round(32767 * Math.tanh(1.5 * value)), i * 2);
  }
  return encoded;
}

workshopTunes.forEach((tune, i) => {
  const filename = fileURLToPath(new URL(arrangements[i].file + '.mp3', output));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1',
    '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '5', '-metadata', 'title=' + tune.title,
    '-metadata', 'artist=未央小窝', '-metadata', 'album=小窝民乐', filename], { input: render(tune, arrangements[i]) });
});
