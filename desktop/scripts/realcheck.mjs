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
 *
 * 一个都找不到时：本机上跳过并明说（退出码 0，没装不是代码的错）；
 * **CI 里直接红**（设了 REALCHECK_REQUIRED=1）—— 加了一个验证步骤
 * 而它什么都没验，比没有这个步骤更糟，因为它会让人以为验过了。
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
  /**
   * 在自己机器上没装 ffmpeg，跳过是合理的 —— 那不是代码的错。
   *
   * 但在**流水线里**，跳过是不能接受的：加了一个验证步骤而它什么都没验，
   * 比没有这个步骤还糟，因为它会让人以为验过了。
   *
   * 这一条是踩出来的：第一版流水线里写着"Windows runner 自带 ffmpeg"，
   * 而它并不自带。那一步每次都安静地跳过，绿了好几轮。
   * 所以 CI 里显式要求它必须真跑，跳过就红。
   */
  const required = process.env.REALCHECK_REQUIRED === '1';
  console.log('\n没找到 ffmpeg。');
  console.log('要跑它：装一个 ffmpeg，或者设 FFMPEG_PATH 指向可执行文件。');
  console.log('⚠ 没跑意味着**转场、补帧、混音这几条真跑起来对不对，这次没有验过**。\n');
  if (required) {
    console.log('\x1b[31m这是 CI，跳过不算通过（REALCHECK_REQUIRED=1）\x1b[0m\n');
    process.exit(1);
  }
  console.log('（本机上这不算失败）\n');
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

/**
 * ── freezedetect：FFmpeg 自己那个"画面冻住了"的滤镜 ──
 *
 * 拿它换掉了原来"每 0.2 秒抠一张 PNG + 感知哈希"那套。换的理由不是省事，
 * 是**准**：哈希那条路被编码噪点咬过一次（第一帧 I 帧、第二帧 P 帧，
 * 画面一样 dHash 也差 1），同一段素材换个 -preset 结论就不一样。
 * 这一节要证明的正是"换个 preset 也认得出来"。
 */
section('freezedetect：开头冻了多久');
{
  const mk = (name, extra) => {
    const out = path.join(DIR, name);
    spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2.8',
      '-vf', 'tpad=start_mode=clone:start_duration=1.2', '-c:v', 'libx264', ...extra,
      '-pix_fmt', 'yuv420p', out], { encoding: 'utf8' });
    return out;
  };
  const fast = mk('fz-fast.mp4', ['-preset', 'ultrafast']);
  const norm = mk('fz-norm.mp4', []);
  const a1 = await ffmpeg.headFreeze(fast);
  const a2 = await ffmpeg.headFreeze(norm);
  check('认出开头冻了约 1.2 秒', a1 != null && Math.abs(a1 - 1.2) < 0.25, String(a1));
  check('换个编码 preset 结论一样（哈希那条路在这儿会翻车）',
    a2 != null && Math.abs(a2 - a1) < 0.15, `${a1} vs ${a2}`);

  const moving = path.join(DIR, 'fz-moving.mp4');
  spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', moving], { encoding: 'utf8' });
  check('全程在动的那段判 0（不能乱剪真内容）',
    (await ffmpeg.headFreeze(moving)) === 0, String(await ffmpeg.headFreeze(moving)));

  /**
   * 中间冻住的**不能**算废头 —— 那是内容本身（比如一个静止的定格），
   * 剪掉会丢东西。只有从 0 开始的那一段才算起势。
   */
  const midFreeze = path.join(DIR, 'fz-mid.mp4');
  spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1.5',
    '-vf', 'tpad=stop_mode=clone:stop_duration=1.5', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', midFreeze], { encoding: 'utf8' });
  check('冻在后半段的不算废头（那是内容，剪了会丢东西）',
    (await ffmpeg.headFreeze(midFreeze)) === 0, String(await ffmpeg.headFreeze(midFreeze)));
}

// ── 自动剪辑：真视频，真采帧 ──
{
  const ih = await import('../core/imghash.js');
  const ac = await import('../core/autocut.js');

  /**
   * 这一段非在真 FFmpeg 上跑不可 —— 它抓到过一个单元测试完全看不见的 bug。
   *
   * 判"没动"原来用的是**绝对阈值**（汉明距离 ≤ 3）。假数据里我造的差值都是
   * 大数，一路绿灯；而真视频里一段**从第一帧就在动**的片子，相邻帧差只有
   * 2~4 —— 全落在阈值以下，于是整段被判成"开头一秒没动"，白剪一秒真内容。
   *
   * 造两段形态相反的片子，看它分不分得开。
   */
  const deadHead = path.join(DIR, 'dead-head.mp4');
  const moving = path.join(DIR, 'moving.mp4');
  // 冻住首帧 1.2 秒再开始动 —— 和模型"起势"那几帧是同一个形态
  spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2.8',
    '-vf', 'tpad=start_mode=clone:start_duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', deadHead]);
  spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', moving]);

  const windowOf = async (file) => {
    const dir = path.join(DIR, `fr-${path.basename(file, '.mp4')}`);
    const frames = await ffmpeg.sampleFrames(file, dir, { step: ac.STEP });
    const hashes = [];
    for (const f of frames) hashes.push(await ih.hashImage(f));
    const total = await ffmpeg.probeDuration(file);
    return { win: ac.pickWindow(hashes, total, 3, { hamming: ih.hamming }), frames: frames.length };
  };

  const a = await windowOf(deadHead);
  const b = await windowOf(moving);
  check(`采帧真的采出来了（${a.frames} 帧）`, a.frames > 10, String(a.frames));
  check(`冻头那段被认出来了（入点 ${a.win.in}s）`, a.win.in > 0.5, JSON.stringify(a.win));
  /**
   * 这一条就是那个 bug 的回执。它要是红了，说明判据又变回"绝对阈值"那种，
   * 而后果是每一段都被白剪掉一秒。
   *
   * ⚠ 量的是 **deadHead**（检测结果），不是 in（最终入点）。
   * 原来写的是 `in === 0`，那是把两件事混在了一起 —— 后来加了"富余不多时
   * 从头上切"之后，一段全程在动、但比要的长 1 秒的片子，
   * 入点会（正确地）落在 1 秒，而 deadHead 仍然是 0。
   * 盯着 in 的话，这条会因为一个**正确的**改动而红，
   * 然后逼着人去改回一个错的行为。
   */
  check('全程在动的那段，废头判 0（判据没退回绝对阈值）',
    b.win.deadHead === 0, JSON.stringify(b.win));
  /**
   * 而窗口这边要的是另一件事：既然非切不可，**留结尾、切开头**。
   * 模型是按"这一段演完"编排节奏的，收尾才是这一镜的看点。
   */
  const bTotal = await ffmpeg.probeDuration(moving);
  check('非切不可时留住结尾（切的是开头那一截）',
    Math.abs(b.win.out - bTotal) < 0.25, `${JSON.stringify(b.win)} total=${bTotal}`);

  // 入点要真的落进成片里，不能只是算出来一个数
  const cut = path.join(DIR, 'cut.mp4');
  const raw = path.join(DIR, 'raw.mp4');
  await ffmpeg.concat([deadHead], raw, { trims: [1.5] });
  await ffmpeg.concat([deadHead], cut, { trims: [1.5], cuts: [{ in: 2.0 }] });
  const h1 = await ih.hashVideoFrame(raw, { at: 'first' });
  const h2 = await ih.hashVideoFrame(cut, { at: 'first' });
  check('入点真的落进了成片（首帧不一样）', h1 !== h2, `${h1} / ${h2}`);
  const cutSecs = await ffmpeg.probeDuration(cut);
  check(`带入点之后时长还是对的（${cutSecs?.toFixed(2)}s）`,
    cutSecs != null && Math.abs(cutSecs - 1.5) < 0.3, String(cutSecs));
}

/**
 * ── 走 studio.compose() 那一整条，不是只测 ffmpeg.concat ──
 *
 * 这一段是被一个真实故障逼出来的：用户点合成，收到
 * `✕ dir is not defined`。自动剪辑那段代码引用了 `dir` 和 `signal`，
 * 而 compose 的作用域里**两个都不存在**。
 *
 * 为什么一路溜到了用户手上：
 *   · selftest 跑在没有 FFmpeg 的环境里 → 自动剪辑整段被 if 跳过，
 *     那几行代码**一次都没有被执行过**；
 *   · realcheck 有 FFmpeg，但它只测 `ffmpeg.concat`、`autocut` 这些零件，
 *     **从来没有调用过 studio.compose()** —— 零件全好，装配的那一步没人验。
 *
 * 所以这里补的是"装配"：拿真视频，走一遍真正的那个函数。
 */
section('合成这一整步（studio.compose，不是只测零件）');
{
  const store = await import('../core/store.js');
  const studio = await import('../core/pipeline/studio.js');

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-compose-'));
  const keepData = process.env.FUTUREDREAM_DATA_DIR;
  process.env.FUTUREDREAM_DATA_DIR = sandbox;

  try {
    const p = store.create({ title: '合成走查', script: '两镜。' });
    const assets = store.assetDir(p.id);
    fs.mkdirSync(assets, { recursive: true });
    /**
     * 第一段**故意做成"冻头"**：首帧冻 1.2 秒再开始动，
     * 和模型起势那几帧是同一个形态。
     *
     * 用纯色片是不行的 —— 整段一帧不动，自动剪辑会（正确地）一帧都不剪，
     * 于是它什么也不说，这一节就变成"跑没跑到都看不出来"。
     * 要验它真的跑到了，就得给它一段真有东西可剪的素材。
     */
    const a = path.join(DIR, 'dead.mp4');
    spawnSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3',
      '-vf', 'tpad=start_mode=clone:start_duration=1.2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', a]);
    const bClip = clip('c2.mp4', 3, 'blue');
    const a2 = path.join(assets, 's1.mp4');
    const b2 = path.join(assets, 's2.mp4');
    fs.copyFileSync(a, a2);
    fs.copyFileSync(bClip, b2);
    store.update(p.id, (x) => {
      x.shots = [
        { id: 's1', index: 1, description: '一', duration: 3, transition: 'cut', videoPath: a2 },
        { id: 's2', index: 2, description: '二', duration: 3, transition: 'cut', videoPath: b2 }
      ];
      return x;
    });

    const notes = [];
    let err = null;
    // 让自动剪辑那段有活可干（默认就是这两个值，写出来是为了这一节不受外部设置影响）
    settings.patch({ autoCut: true, durationPolicy: 'trim' });
    await studio.compose(p.id, { onEvent: (ev) => { if (ev.message) notes.push(ev.message); } })
      .catch((e) => { err = e; });

    check('compose 跑完没抛异常', !err, err ? `${err.message}\n${String(err.stack).split('\n')[1] || ''}` : '');
    /**
     * 这两条单独列出来，是因为那次故障的形状正是它们：
     * 不是"合成质量不好"，是**一个引用不存在的变量的 ReferenceError**。
     * 这类错在没跑到那一行之前完全隐形。
     */
    check('没有 ReferenceError（dir / signal 那一类）',
      !err || !/is not defined/.test(err.message || ''), err?.message);
    const outFile = store.read(p.id).outputs?.video;
    check('真出片了', Boolean(outFile) && fs.existsSync(outFile), String(outFile));
    if (outFile && fs.existsSync(outFile)) {
      const secs = await ffmpeg.probeDuration(outFile);
      check(`成片时长像样（${secs?.toFixed(2)}s）`, secs != null && secs > 3 && secs < 8, String(secs));
    }
    // 自动剪辑默认开着，这台机器又有 FFmpeg —— 那段代码必须真的被执行到
    check('自动剪辑那段真的跑到了（否则这一节等于没验）',
      notes.some((m) => /自动剪辑|入点|没动|冻/.test(m || '')), notes.join(' | ').slice(0, 300));
  } finally {
    if (keepData) process.env.FUTUREDREAM_DATA_DIR = keepData;
    else delete process.env.FUTUREDREAM_DATA_DIR;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ── 收尾 ──
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${'─'.repeat(50)}`);
if (fail) {
  console.log(`\x1b[31m${fail} 项未通过\x1b[0m（通过 ${pass} 项）：${failures.join('、')}`);
  process.exit(1);
}
console.log(`\x1b[32m真 FFmpeg 全过：${pass} 项\x1b[0m`);
