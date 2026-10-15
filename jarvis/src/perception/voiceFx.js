/**
 * 科幻声线（Web Audio 效果链）。只处理“拿得到音频”的语音（云端 TTS 返回的音频）；
 * 浏览器自带的 speechSynthesis 不暴露音频流，无法加效果。
 *
 * 链路：音源(变调) → 高通 → 低频增厚 → 临场感提升 → ┬ 干声
 *                                                     ├ 合唱（调制短延迟，“多声部 AI”质感）
 *                                                     ├ 环形调制（全息通讯的金属颤动）
 *                                                     └ 混响（舱内 / 大厅空间感）
 *                                       → 压缩 → 分析器（驱动光核的真实音量） → 输出
 */

/** 声线预设：数值都是“轻微”的——要的是电影里那种有质感的人声，不是机器人怪声 */
export const FX_PRESETS = {
  jarvis: {
    name: '未央 · 管家', desc: '沉稳、略低沉，带一点点空间与双声部光泽',
    detune: -70, highpass: 90, lowpass: 12000, lowGain: 2.5, presence: 3, chorus: 0.16, ring: 0, ringHz: 0, reverb: 0.1, decay: 0.7, stereo: 0.25
  },
  holo: {
    name: '全息通讯', desc: '像从头盔 / 全息投影里传来，频带收窄、带细微金属颤动',
    detune: -40, highpass: 260, lowpass: 7000, lowGain: 0, presence: 4.5, chorus: 0.3, ring: 0.1, ringHz: 48, reverb: 0.12, decay: 0.5, stereo: 0.4
  },
  ship: {
    name: '星舰主机', desc: '更低沉，带大空间混响，像舰桥广播',
    detune: -140, highpass: 70, lowpass: 10000, lowGain: 3.5, presence: 2, chorus: 0.2, ring: 0, ringHz: 0, reverb: 0.26, decay: 2.1, stereo: 0.3
  },
  none: {
    name: '原声', desc: '不加效果',
    detune: 0, highpass: 40, lowpass: 20000, lowGain: 0, presence: 0, chorus: 0, ring: 0, ringHz: 0, reverb: 0, decay: 0.5, stereo: 0
  }
};

/** 生成混响冲激响应：带预延迟的指数衰减立体声噪声（不需要下载 IR 文件） */
export function makeImpulse(ctx, seconds, preDelay = 0.012) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * (seconds + preDelay)));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * preDelay);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * t) / seconds) * (1 - 0.35 * Math.min(1, t * 6));
    }
  }
  return buf;
}

/**
 * @param {AudioContext} ctx
 * @param {keyof FX_PRESETS} presetId
 * @returns {{ input: AudioNode, analyser: AnalyserNode, detune: number, dispose(): void }}
 */
export function buildFx(ctx, presetId = 'jarvis') {
  const p = FX_PRESETS[presetId] ?? FX_PRESETS.jarvis;
  const nodes = [];
  const add = (n) => (nodes.push(n), n);
  const biquad = (type, freq, gain = 0, Q = 0.707) => {
    const f = add(ctx.createBiquadFilter());
    f.type = type; f.frequency.value = freq; f.gain.value = gain; f.Q.value = Q;
    return f;
  };

  const input = add(ctx.createGain());
  const hp = biquad('highpass', p.highpass);
  const lp = biquad('lowpass', p.lowpass);
  const low = biquad('lowshelf', 180, p.lowGain);
  const pres = biquad('peaking', 3000, p.presence, 0.9);
  const air = biquad('highshelf', 9000, p.presence * 0.4);
  input.connect(hp).connect(low).connect(pres).connect(air).connect(lp);

  const sum = add(ctx.createGain());
  const dry = add(ctx.createGain());
  dry.gain.value = 1;
  lp.connect(dry).connect(sum);

  const lfos = [];
  if (p.chorus > 0) {
    // 两路调制延迟分别送左右声道：干净的“双声部”光泽
    const merger = add(ctx.createChannelMerger(2));
    [[0.017, 0.21], [0.023, 0.29]].forEach(([base, rate], ch) => {
      const d = add(ctx.createDelay(0.05));
      d.delayTime.value = base;
      const lfo = add(ctx.createOscillator());
      lfo.frequency.value = rate;
      const depth = add(ctx.createGain());
      depth.gain.value = 0.0025;
      lfo.connect(depth).connect(d.delayTime);
      lfos.push(lfo);
      const g = add(ctx.createGain());
      g.gain.value = p.chorus;
      lp.connect(d).connect(g).connect(merger, 0, ch);
    });
    const width = add(ctx.createGain());
    width.gain.value = 0.5 + p.stereo;
    merger.connect(width).connect(sum);
  }

  if (p.ring > 0) {
    // 环形调制：信号 × 低频正弦，只混入一小部分
    const ringAmp = add(ctx.createGain());
    ringAmp.gain.value = 0;
    const carrier = add(ctx.createOscillator());
    carrier.frequency.value = p.ringHz;
    carrier.connect(ringAmp.gain);
    lfos.push(carrier);
    const mix = add(ctx.createGain());
    mix.gain.value = p.ring;
    lp.connect(ringAmp).connect(mix).connect(sum);
  }

  if (p.reverb > 0) {
    const conv = add(ctx.createConvolver());
    conv.buffer = makeImpulse(ctx, p.decay);
    const send = add(ctx.createGain());
    send.gain.value = p.reverb;
    const tone = biquad('lowpass', 5500);
    lp.connect(send).connect(conv).connect(tone).connect(sum);
  }

  const comp = add(ctx.createDynamicsCompressor());
  comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.18;
  const out = add(ctx.createGain());
  out.gain.value = 0.95;
  const analyser = add(ctx.createAnalyser());
  analyser.fftSize = 1024;
  sum.connect(comp).connect(out).connect(analyser).connect(ctx.destination);
  for (const o of lfos) o.start();

  return {
    input,
    analyser,
    detune: p.detune,
    dispose() {
      for (const o of lfos) { try { o.stop(); } catch { /* 已停止 */ } }
      for (const n of nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
    }
  };
}

/** 读取分析器的 RMS 音量（0..1，已做感知压缩） */
export function levelOf(analyser, buf = new Float32Array(analyser.fftSize)) {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(s / buf.length) * 4.5);
}

/** 科幻提示音：开口前一声轻“启动音”，说完一声轻“收尾音”（合成，无需音频文件） */
export function playCue(ctx, kind = 'start', volume = 0.06) {
  const t0 = ctx.currentTime + 0.01;
  const notes = kind === 'start' ? [[880, 0], [1320, 0.07]] : [[1175, 0], [784, 0.06]];
  const out = ctx.createGain();
  out.gain.value = volume;
  const echo = ctx.createDelay(0.5);
  echo.delayTime.value = 0.11;
  const fb = ctx.createGain();
  fb.gain.value = 0.28;
  out.connect(ctx.destination);
  out.connect(echo).connect(fb).connect(echo);
  fb.connect(ctx.destination);
  for (const [f, at] of notes) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t0 + at);
    o.frequency.exponentialRampToValueAtTime(f * 1.012, t0 + at + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(1, t0 + at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.16);
    o.connect(g).connect(out);
    o.start(t0 + at);
    o.stop(t0 + at + 0.2);
  }
  setTimeout(() => { try { out.disconnect(); echo.disconnect(); fb.disconnect(); } catch { /* ignore */ } }, 1500);
}
