/**
 * 真 FFmpeg 走一遍 —— 这一份和 selftest 补的是完全不同的洞。
 *
 * ════════ 为什么必须单独有它 ════════
 *
 * selftest 里那些合成相关的用例，验的是"**我们拼出来的参数**是不是想要的那串"。
 * 它挡得住切点算错、滤镜写反；挡不住的是另一整类问题：
 *
 *   · 滤镜名拼错了      —— 参数看着完全正常，真跑起来 FFmpeg 说 No such filter
 *   · 这个版本不支持    —— xfade 是 4.3 才有的，tpad 是 4.2
 *   · 参数顺序错了      —— `-t` 放在 -i 前面是"只读这么长"，放后面是"输出这么长"
 *   · 出来的东西不对    —— 命令成功退出，但成片时长和时间轴对不上
 *
 * 最后那一条是最要命的：**一切都"成功"了，只是片子不对**。
 * 而配音和字幕都按时间轴摆，成片时长一错，音画就全错。
 *
 * ════════ 怎么用 ════════
 *
 *     node scripts/realcheck.mjs
 *
 * 找 ffmpeg 的顺序：FFMPEG_PATH 环境变量 → 设置里配的 → PATH。
 * 一个都找不到就**跳过并明说**，退出码 0 —— 没装 FFmpeg 不是代码的错，
 * 但也绝不能假装验过了。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-realcheck-'));
process.env.FUTUREDREAM_DATA_DIR = path.join(DIR, 'data');

const settings = await import('../core/settings.js');
const ffmpeg = await import('../core/ffmpeg.js');
const transitions = await import('../core/transitions.js');

// ── 找一个真的 ffmpeg ──
function locate() {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'ffmpeg';
  return null;
}

const bin = locate();
if (!bin) {
  console.log('\n没找到 ffmpeg，这一份跳过（不算失败）。');
  console.log('要跑它：装一个 ffmpeg，或者设 FFMPEG_PATH 指向可执行文件。');
  console.log('⚠ 跳过意味着**转场、补帧、混音这几条真跑起来对不对，这次没有验过**。\n');
  process.exit(0);
}
settings.patch({ ffmpegPath: bin });
const info = ffmpeg.locate({ refresh: true });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail) console.log(`      ${String(detail).slice(0, 400)}`);
  }
}
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

console.log(`\n真 FFmpeg：${info.version}`);
console.log(`路径：${info.path}\n`);

// ── 先看这个版本有没有我们要用的东西 ──
section('这个 FFmpeg 有没有我们用到的滤镜');
{
  const filters = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '';
  const encoders = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  const has = (name) => new RegExp(`^\\s*[TSC.]{3}\\s+${name}\\s`, 'm').test(filters);

  // 每一条都写清楚少了它会怎样 —— "缺 xfade"这四个字对用户没有意义
  check('xfade（叠化转场）', has('xfade'), '缺它的话叠化做不了，会退回硬切');
  check('fade（黑场转场）', has('fade'), '缺它的话黑场做不了');
  check('tpad（片段短了定格补齐）', has('tpad'), '缺它的话短片段补不齐，成片会比时间轴短，配音字幕跟着全错');
  check('apad（补静音）', has('apad'), '缺它的话补出来那截没音轨，拼接时整条音轨可能消失');
  check('adelay + amix + volume（配音和音效按时间轴混）', has('adelay') && has('amix') && has('volume'));
  check('libx264', / libx264 /.test(encoders), '缺它的话裁剪和转场都没法重编码');
  check('aac', / aac /.test(encoders));
}

// ── 造几段真的视频 ──
const clip = (name, seconds, color) => {
  const out = path.join(DIR, name);
  const r = spawnSync(bin, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=25:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`造测试片失败：${r.stderr?.slice(-400)}`);
  return out;
};

const dur = async (f) => (await ffmpeg.probeStreams(f))?.seconds ?? null;

section('硬切拼接：不重编码的那条快路');
{
  const a = clip('a.mp4', 4, 'red');
  const b = clip('b.mp4', 4, 'green');
  const out = path.join(DIR, 'cut.mp4');
  const notes = [];
  await ffmpeg.concat([a, b], out, { transitions: ['cut', 'cut'], onNote: (m) => notes.push(m) });
  const got = await dur(out);
  check('拼出来了', fs.existsSync(out) && fs.statSync(out).size > 1000);
  // 硬切不吃时长，8 秒就该是 8 秒。差 0.3 秒以上说明有别的东西在动时长
  check(`总长 ≈ 8 秒（实际 ${got?.toFixed(2)}）`, got !== null && Math.abs(got - 8) < 0.3, String(got));
}

section('叠化：真的做出来了，而且真的吃掉那半秒');
{
  const a = clip('d1.mp4', 4, 'red');
  const b = clip('d2.mp4', 4, 'blue');
  const out = path.join(DIR, 'dis.mp4');
  const notes = [];
  await ffmpeg.concat([a, b], out, { transitions: ['cut', 'dissolve'], onNote: (m) => notes.push(m) });
  const got = await dur(out);
  const want = 8 - transitions.DISSOLVE_SECONDS;

  check('合成没报错', fs.existsSync(out) && fs.statSync(out).size > 1000, notes.join(' | '));
  // 没退回硬切 —— 退回时会往 onNote 里写一句，那说明 xfade 这一路其实没跑通
  check('没有偷偷退回硬切', !notes.some((m) => /硬切/.test(m)), notes.join(' | '));
  /**
   * 这一条是整份 realcheck 最该验的：叠化**必然**吃掉重叠的那段时间，
   * 而这个数已经写进 timelineOf，配音和字幕都按它算。
   * 真跑出来对不上的话，成片的音画会整体错开，而且没有任何报错。
   */
  check(`总长 ≈ ${want} 秒（叠化吃掉 0.5，实际 ${got?.toFixed(2)}）`,
    got !== null && Math.abs(got - want) < 0.3, String(got));

  // 抠中间那一帧看看是不是真的在混色 —— 命令成功不等于画面对
  const mid = path.join(DIR, 'mid.png');
  spawnSync(bin, ['-y', '-v', 'error', '-ss', '3.75', '-i', out, '-frames:v', '1', mid]);
  check('过渡处抠得出帧', fs.existsSync(mid) && fs.statSync(mid).size > 100);
}

section('黑场：淡出淡入都在，而且一秒都不吃');
{
  const a = clip('f1.mp4', 4, 'red');
  const b = clip('f2.mp4', 4, 'blue');
  const out = path.join(DIR, 'fade.mp4');
  const notes = [];
  await ffmpeg.concat([a, b], out, { transitions: ['cut', 'fade'], onNote: (m) => notes.push(m) });
  const got = await dur(out);
  check('合成没报错', fs.existsSync(out) && fs.statSync(out).size > 1000, notes.join(' | '));
  check('没有偷偷退回硬切', !notes.some((m) => /硬切/.test(m)), notes.join(' | '));
  // 黑场是原地做的，总长一秒不该变 —— 这正是它和叠化最重要的区别
  check(`总长 ≈ 8 秒（黑场不吃时长，实际 ${got?.toFixed(2)}）`,
    got !== null && Math.abs(got - 8) < 0.3, String(got));

  /**
   * 接缝那一帧该是黑的。
   *
   * 只验时长的话，"滤镜写反了"（该淡出的淡入）这类错完全看不出来 ——
   * 命令成功、时长正确、画面全错。所以这里真去量那一帧的亮度。
   */
  const seam = path.join(DIR, 'seam.png');
  spawnSync(bin, ['-y', '-v', 'error', '-ss', '3.98', '-i', out,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', seam]);
  const lum = fs.existsSync(seam) ? fs.readFileSync(seam)[0] : 255;
  check(`接缝处画面确实压黑了（亮度 ${lum}/255）`, lum < 90, String(lum));
}

section('片段比分镜短：定格补齐');
{
  // 3 秒的片子，分镜要 5 秒 —— 不补的话成片短 2 秒，后面每句配音都提前 2 秒
  const a = clip('s1.mp4', 3, 'red');
  const b = clip('s2.mp4', 5, 'green');
  const out = path.join(DIR, 'pad.mp4');
  const notes = [];
  await ffmpeg.concat([a, b], out, { trims: [5, 5], transitions: ['cut', 'cut'], onNote: (m) => notes.push(m) });
  const got = await dur(out);

  check('补齐说出来了', notes.some((m) => /补齐/.test(m)), notes.join(' | '));
  check(`总长 ≈ 10 秒（3+5 补成 5+5，实际 ${got?.toFixed(2)}）`,
    got !== null && Math.abs(got - 10) < 0.4, String(got));
  // 补出来那截必须还有音轨，否则拼接时整条音轨可能从这儿断掉
  const st = await ffmpeg.probeStreams(out);
  check('补完之后音轨还在', st?.hasAudio === true, JSON.stringify(st));
}

section('按时间轴混音：音效压在台词底下');
{
  const mk = (name, freq, seconds) => {
    const out = path.join(DIR, name);
    spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, out]);
    return out;
  };
  const line = mk('line.m4a', 300, 2);
  const knock = mk('knock.m4a', 900, 1);
  const track = path.join(DIR, 'mix.m4a');

  await ffmpeg.buildVoiceTrack([
    { path: line, at: 0 },
    { path: knock, at: 6, gain: 0.35 }
  ], track);

  const got = await dur(track);
  check('混出来了', fs.existsSync(track) && fs.statSync(track).size > 500);
  // 第二条摆在第 6 秒、长 1 秒 —— 整条音轨该到 7 秒，而不是 3 秒（顺次拼的话就是 3）
  check(`按时间点摆而不是顺次拼（总长 ≈ 7 秒，实际 ${got?.toFixed(2)}）`,
    got !== null && Math.abs(got - 7) < 0.4, String(got));

  /**
   * 真去量两段的音量。
   *
   * 这一条 selftest 验不了：它只能看到 `volume=0.350` 这串字符在不在，
   * 看不到它有没有生效。而"音效盖掉台词"是自己做音频最容易做砸的一处，
   * 也是最难在事后察觉的 —— 素材各自听着都正常。
   */
  const vol = (from, to) => {
    const r = spawnSync(bin, ['-v', 'info', '-ss', String(from), '-t', String(to - from),
      '-i', track, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = (r.stderr || '').match(/max_volume:\s*(-?[\d.]+) dB/);
    return m ? Number(m[1]) : null;
  };
  const speech = vol(0.2, 1.8);
  const sfx = vol(6.2, 6.8);
  check(`台词段和音效段都量得到（${speech} / ${sfx} dB）`, speech !== null && sfx !== null);
  // 0.35 倍 ≈ −9dB。留一点余量给编码
  check(`音效确实压低了（低 ${speech !== null && sfx !== null ? (speech - sfx).toFixed(1) : '?'} dB）`,
    speech !== null && sfx !== null && speech - sfx > 6, `${speech} vs ${sfx}`);
}

section('整条走一遍：转场 + 补齐 + 混音一起来');
{
  /**
   * 单项都过不代表合起来能过。这三样在同一次合成里会互相影响：
   * 转场要重编码、补齐也要重编码、混音要另起一条音轨再合流 ——
   * 参数放错位置的话，最典型的表现是**音轨没了**或者**时长对不上**，
   * 而每一项单独跑都是好的。
   */
  const clips = [clip('m1.mp4', 3, 'red'), clip('m2.mp4', 4, 'green'), clip('m3.mp4', 4, 'blue')];
  const voice = path.join(DIR, 'v.m4a');
  spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', voice]);

  const out = path.join(DIR, 'full.mp4');
  const notes = [];
  await ffmpeg.concat(clips, out, {
    trims: [4, 4, 4],
    transitions: ['cut', 'fade', 'dissolve'],
    audioAt: [{ path: voice, at: 0 }, { path: voice, at: 5, gain: 0.35 }],
    onNote: (m) => notes.push(m)
  });

  const st = await ffmpeg.probeStreams(out);
  // 4+4+4 = 12，减去一处叠化的 0.5
  const want = 12 - transitions.DISSOLVE_SECONDS;
  check('合成出来了', fs.existsSync(out) && fs.statSync(out).size > 2000, notes.join(' | '));
  check(`总长 ≈ ${want} 秒（实际 ${st?.seconds?.toFixed(2)}）`,
    st?.seconds != null && Math.abs(st.seconds - want) < 0.5, JSON.stringify(st));
  check('音轨在', st?.hasAudio === true, JSON.stringify(st));
  check('第一段短了 1 秒，补齐了', notes.some((m) => /补齐/.test(m)), notes.join(' | '));
  check('转场没退回硬切', !notes.some((m) => /没做成|按硬切合成/.test(m)), notes.join(' | '));
}

// ── 收尾 ──
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${'─'.repeat(50)}`);
if (fail) {
  console.log(`\x1b[31m${fail} 项未通过\x1b[0m（通过 ${pass} 项）：${failures.join('、')}`);
  process.exit(1);
}
console.log(`\x1b[32m真 FFmpeg 全过：${pass} 项\x1b[0m`);
