/**
 * FFmpeg 封装。
 *
 * Windows 上 FFmpeg 是最容易卡住新手的一环：官方不提供安装包，解压后还得配 PATH。
 * 所以这里会自己找：设置里手填的路径 → 几个 bin\ 目录 → PATH。
 * 全都不中时，不抛异常打断流程，而是把"没装 FFmpeg"作为一种状态回给界面，
 * 让用户照样能跑到"视频生成"这一步，只是最后合成那步给出明确的安装指引。
 *
 * 提示语里那句"放进 bin 目录"曾经是错的：源码里的 desktop\bin\ 在开发机上没问题，
 * 装完之后却指向 app.asar 内部 —— 一个既不存在、也没法往里放文件的虚拟路径。
 * 现在首选数据目录下的 bin\（唯一保证可写的地方），而且提示语直接把**绝对路径**
 * 印出来，不再让人猜"本应用的 bin 目录"到底是哪个。
 */
import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BIN_DIRS, USER_BIN_DIR } from './paths.js';
import * as settings from './settings.js';
import { DISSOLVE_SECONDS, FADE_SECONDS } from './transitions.js';

// 时长会被时间轴、字幕、合成三处同时用到，所以只有 transitions.js 一个出处
const TRANS = { DISSOLVE: DISSOLVE_SECONDS, FADE: FADE_SECONDS };

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

let cached = null;

export function locate({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const configured = settings.get('ffmpegPath');
  const candidates = [];
  if (configured) candidates.push(configured);
  for (const dir of BIN_DIRS) candidates.push(path.join(dir, EXE));
  candidates.push(EXE); // 交给 PATH 解析

  for (const candidate of candidates) {
    const isPath = candidate.includes(path.sep) || candidate.includes('/');
    if (isPath && !fs.existsSync(candidate)) continue;
    try {
      const probe = spawnSync(candidate, ['-version']);
      if (probe.ok) {
        cached = {
          available: true,
          path: candidate,
          version: (probe.stdout.split('\n')[0] || '').trim(),
          source: candidate === configured ? 'settings' : isPath ? 'bundled' : 'PATH',
          searched: candidates,
          dropDir: USER_BIN_DIR
        };
        return cached;
      }
    } catch {
      /* 试下一个 */
    }
  }

  cached = {
    available: false,
    path: null,
    version: null,
    source: null,
    // 找过哪些地方要说出来 —— "没检测到"最气人的地方就是不知道它去哪儿找了
    searched: candidates,
    dropDir: USER_BIN_DIR,
    hint:
      `未检测到 FFmpeg。最省事的一条：下载 Windows 构建，把 ffmpeg.exe 放进 ${USER_BIN_DIR}（这个目录已经建好了），` +
      '放完点一下「重新检测」即可，不用重启、不用配 PATH。' +
      '也可以 winget install Gyan.FFmpeg，或在下面直接填 ffmpeg.exe 的完整路径。'
  };
  return cached;
}

function spawnSync(cmd, args) {
  const r = nodeSpawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * 跑一次 FFmpeg 并把 **stdout 当二进制收回来**。
 *
 * run() 只收 stderr（进度在那儿），这条专门用来把像素数据直接读进内存：
 * 抠一帧再存成文件再读回来是三次磁盘往返，而我们只要 72 个字节。
 */
export function runCapture(args) {
  const bin = locate();
  if (!bin.available) return Promise.reject(new Error(bin.hint));
  return new Promise((resolve, reject) => {
    const child = spawn(bin.path, args, { windowsHide: true });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 40000) stderr = stderr.slice(-20000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const buf = Buffer.concat(out);
      // FFmpeg 有时会以非 0 退出但该给的数据已经给全了（管道被提前关掉）
      if (buf.length) return resolve(buf);
      reject(new Error(`FFmpeg 退出码 ${code}：${stderr.slice(-600)}`));
    });
  });
}

export function run(args, { onProgress, cwd } = {}) {
  const bin = locate();
  if (!bin.available) {
    return Promise.reject(new Error(bin.hint));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin.path, args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      // FFmpeg 的进度全在 stderr 里，形如 time=00:00:03.20
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && onProgress) {
        onProgress({ seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) });
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`FFmpeg 退出码 ${code}：${stderr.slice(-1200)}`));
    });
  });
}

/**
 * 读一个媒体文件的时长（秒）。读不出来回 null。
 *
 * 用 `-f null -` 而不是解析 `-i` 的报错输出：后者会以非 0 退出，
 * 在 run() 里变成异常，调用方还得去 catch 一个"正常情况"。
 */
export async function probeDuration(file) {
  return (await probeStreams(file))?.seconds ?? null;
}

/**
 * 时长 + 有没有音轨，一次探完。
 *
 * 「有没有音轨」是拼接时的一个硬约束：concat demuxer 要求各段的流结构一致。
 * 一段有声、一段没声混着拼，出来的片子会从某一处开始**整条音轨消失**，
 * 而 FFmpeg 一句警告都不给。加转场时要重编码，正好在那时候统一齐。
 */
export async function probeStreams(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const { stderr } = await run(['-i', file, '-f', 'null', '-']);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    return {
      seconds: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null,
      hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr)
    };
  } catch {
    return null;
  }
}

/**
 * 把若干条配音按**各自该出现的时间点**摆成一条整片音轨。
 *
 * ── 为什么不能直接首尾相接 ──
 *
 * 早先是把每镜的配音顺次拼起来当整片音轨，这在数学上就是错的：
 * 画面的长度是**分镜时长**（4 秒、5 秒），配音的长度是**这句话念多久**（2.1 秒）。
 * 两者根本不相等，于是从第二镜开始音画就错位，而且**越往后错得越多** ——
 * 第 10 镜的台词可能配在第 7 镜的画面上。
 * 表现就是"说的话和画面对不上"，但因为是渐进的，前两镜看着还挺正常。
 *
 * 正确的做法是按时间轴摆：每条配音 adelay 到它那一镜的起点，再 amix 混起来。
 * 这样音画对齐的依据和字幕完全一致（都用同一份时间轴），三者不会互相打架。
 *
 * ⚠ amix 必须写 normalize=0。默认它会把音量按输入条数均分 ——
 * 二十条配音混完，每一句都只剩二十分之一的音量，听上去像"没配音"。
 */
export function voiceFilterGraph(entries) {
  const filters = entries
    .map((e, i) => {
      const ms = Math.max(0, Math.round((Number(e.at) || 0) * 1000));
      /**
       * gain 是给**音效**用的：音效必须压在台词底下。
       *
       * 等响的话，一声关门就能把一句台词整个盖掉 —— 而台词是观众
       * 唯一的信息来源。这是混音里最基本的一条，也是自己做音频时
       * 最容易做砸的一处：素材各自听着都正常，混到一起才发现听不清人话。
       *
       * 台词不传 gain，走原音量；只有音效那几条会带上。
       */
      const g = Number(e.gain);
      const vol = Number.isFinite(g) && g > 0 && g !== 1 ? `,volume=${g.toFixed(3)}` : '';
      // adelay 要按声道给值，all=1 省得去数这条音频是单声道还是立体声
      return `[${i}:a]adelay=${ms}:all=1${vol}[a${i}]`;
    })
    .join(';');
  const mixIn = entries.map((_, i) => `[a${i}]`).join('');
  return `${filters};${mixIn}amix=inputs=${entries.length}:dropout_transition=0:normalize=0[out]`;
}

export async function buildVoiceTrack(entries, outputPath, { onProgress } = {}) {
  const usable = (entries || []).filter((e) => e?.path && fs.existsSync(e.path));
  if (!usable.length) return null;

  const args = ['-y'];
  for (const e of usable) {
    // trimTo：音效比镜头长时裁掉多出来的部分，否则它会响到下一镜上。
    // -t 放在 -i **前面**才是"只读这么长"，放后面变成"输出这么长"，那是另一回事
    if (Number(e.trimTo) > 0) args.push('-t', String(e.trimTo));
    args.push('-i', e.path);
  }
  args.push('-filter_complex', voiceFilterGraph(usable), '-map', '[out]', '-c:a', 'aac', outputPath);
  await run(args, { onProgress });
  return outputPath;
}

/**
 * 把若干片段按顺序拼起来，可选叠一条整片音轨。
 * 用 concat demuxer 而不是 filter_complex —— 前者不重编码，快得多，
 * 代价是要求各片段编码参数一致（同一模型出的视频通常都一致）。
 *
 * 音轨有两种给法：
 *   audioAt     [{ path, at }] —— 按时间点摆，**音画对齐的正确做法**
 *   audioTracks 顺次拼接的老写法，只在没有时间轴信息时用（会错位，见上面）
 */
/**
 * 在片段之间做转场。返回一份新的片段清单，交回给 concat 照常拼。
 *
 * ── 为什么是"生成新片段"而不是"一整条 filter_complex" ──
 *
 * 用一条 xfade 链把整部片子串起来是最直观的写法，但它要求**整片重编码**：
 * 二十镜的片子要重压二十段，慢好几倍，画质还掉一档。
 * 而转场通常只有两三处 —— 为了两处效果把另外十八段无辜地重压一遍，不划算。
 *
 * 所以这里只动**接缝附近**：需要效果的那两段各重编码一次，
 * 中间再生成一小段过渡片，其余片段原样不动，继续走不重编码的快路。
 *
 * ── 失败了怎么办 ──
 *
 * 一律退回硬切，并且说出来。转场是锦上添花，
 * 让它把**整部成片**带崩是完全不成比例的 —— 片子出不来才是真的损失。
 *
 * ── probe / exec 这两个参数是干什么的 ──
 *
 * 留给自检注入用，正常调用一个都不用传。
 *
 * 本来是拿一个假的 ffmpeg 可执行文件来录参数的，那在 Linux 上很好使 ——
 * 写个 `#!/bin/sh` 脚本就行。但 Windows 上没有 shebang 这回事，
 * spawn 一个没后缀的脚本文件直接失败，于是自检在 Windows 上整个红掉。
 * 而 Windows 恰恰是这个应用**唯一的目标平台**，那儿测不了等于没测。
 *
 * 换成在这里留一个口子：假的东西从参数进来，两个平台跑的是同一段代码。
 */
async function buildTransitions({
  clips, kinds, outputPath, cleanup, onProgress, onNote,
  probe = probeStreams, exec = run
}) {
  const info = [];
  for (const c of clips) info.push((await probe(c)) || { seconds: null, hasAudio: false });
  if (info.some((i) => !i.seconds)) {
    onNote?.('读不出片段时长，这次按硬切合成（转场跳过，成片不受影响）');
    return clips;
  }

  // 音轨要么全有、要么全无。缺的补一段静音，否则拼出来会从某一处开始整条没声
  const anyAudio = info.some((i) => i.hasAudio);

  // 每段各要切掉多少：头上被前一个叠化吃掉，尾巴被后一个叠化吃掉
  const headCut = clips.map((_, i) => (i > 0 && kinds[i] === 'dissolve' ? TRANS.DISSOLVE : 0));
  const tailCut = clips.map((_, i) => (i + 1 < clips.length && kinds[i + 1] === 'dissolve' ? TRANS.DISSOLVE : 0));
  // 黑场是原地做的，不吃时长：只是把上一段的尾巴压黑、这一段的头淡入
  const fadeIn = clips.map((_, i) => i > 0 && kinds[i] === 'fade');
  const fadeOut = clips.map((_, i) => i + 1 < clips.length && kinds[i + 1] === 'fade');

  // 片段太短，切完就没了 —— 这种情况下做转场没有意义
  for (let i = 0; i < clips.length; i += 1) {
    if (info[i].seconds - headCut[i] - tailCut[i] < 0.5) {
      onNote?.(`第 ${i + 1} 段只有 ${info[i].seconds.toFixed(1)} 秒，做转场会把它切没，这次按硬切合成`);
      return clips;
    }
  }

  try {
    const out = [];
    for (let i = 0; i < clips.length; i += 1) {
      const need = headCut[i] || tailCut[i] || fadeIn[i] || fadeOut[i];
      if (!need) {
        out.push(clips[i]);
        continue;
      }
      const len = info[i].seconds - headCut[i] - tailCut[i];
      const vf = [];
      if (fadeIn[i]) vf.push(`fade=t=in:st=0:d=${TRANS.FADE}`);
      if (fadeOut[i]) vf.push(`fade=t=out:st=${Math.max(0, len - TRANS.FADE).toFixed(3)}:d=${TRANS.FADE}`);

      const piece = `${outputPath}.tr${i}.mp4`;
      const args = ['-y'];
      if (headCut[i]) args.push('-ss', headCut[i].toFixed(3));
      args.push('-i', clips[i], '-t', len.toFixed(3));
      // 没音轨的补静音，让所有片段的流结构一致
      if (anyAudio && !info[i].hasAudio) {
        args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest');
      }
      if (vf.length) args.push('-vf', vf.join(','));
      args.push('-c:v', 'libx264', '-preset', 'veryfast', ...(anyAudio ? ['-c:a', 'aac'] : ['-an']), piece);
      await exec(args, { onProgress });
      cleanup.push(piece);
      out.push(piece);

      // 叠化的过渡片：拿上一段的尾巴和这一段的开头重叠着渐变
      if (i + 1 < clips.length && kinds[i + 1] === 'dissolve') {
        const x = `${outputPath}.xf${i}.mp4`;
        const from = Math.max(0, info[i].seconds - TRANS.DISSOLVE);
        const xa = ['-y', '-ss', from.toFixed(3), '-t', String(TRANS.DISSOLVE), '-i', clips[i],
          '-t', String(TRANS.DISSOLVE), '-i', clips[i + 1]];
        /**
         * ⚠ 这里的静音必须**给定长度**，而且输出还要再 `-t` 卡一次。
         *
         * 原来写的是无限长的 anullsrc + `-shortest`，想当然以为
         * `-shortest` 会按最短的那条（0.5 秒的画面）收尾。**它没有** ——
         * 真跑出来这一小段是 1.0 秒，整整多了一倍。
         *
         * 后果不是"多半秒"这么简单：叠化本该让全片**变短** 0.5 秒，
         * 而这个 bug 让它反而**变长** 0.5 秒。时间轴（timelineOf）按变短算，
         * 于是从这处叠化往后，配音和字幕全体错位 1 秒。
         *
         * 而这个错单元测试一个都抓不到 —— 参数拼得完全"正确"，
         * 只有真的跑一遍 FFmpeg 再去量出来的时长，才看得见。
         */
        if (anyAudio) {
          xa.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:d=${TRANS.DISSOLVE}`);
        }
        xa.push(
          '-filter_complex',
          `[0:v][1:v]xfade=transition=fade:duration=${TRANS.DISSOLVE}:offset=0[v]`,
          '-map', '[v]',
          ...(anyAudio ? ['-map', '2:a', '-c:a', 'aac'] : ['-an']),
          // 输出侧再钉一次长度。不靠 -shortest：它在"输出来自滤镜图"时不可靠
          '-t', String(TRANS.DISSOLVE),
          '-c:v', 'libx264', '-preset', 'veryfast', x
        );
        await exec(xa, { onProgress });
        cleanup.push(x);
        out.push(x);
      }
    }
    return out;
  } catch (err) {
    onNote?.(`转场没做成（${err.message}），这次按硬切合成 —— 成片照常出，只是接缝处没有淡入淡出`);
    return clips;
  }
}

export async function concat(
  segments,
  outputPath,
  // __probe / __exec 只给自检注入用，正常调用一个都不用传（理由见 buildTransitions 上面那段）
  { audioPath, audioTracks, audioAt, trims, cuts, transitions, onNote, onProgress, __probe, __exec } = {}
) {
  if (!segments.length) throw new Error('没有可合成的片段');

  const cleanup = [];
  const writeList = (files, suffix) => {
    const listFile = `${outputPath}.${suffix}.txt`;
    // concat demuxer 的路径里单引号要转义，Windows 反斜杠也统一换成正斜杠
    const lines = files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    cleanup.push(listFile);
    return listFile;
  };

  try {
    /**
     * 按分镜时长对齐 —— **长了要切，短了要补**。
     *
     * ── 短了会怎样，为什么以前看不出来 ──
     *
     * 原来这里只有 `-t want`，而 `-t` 只截不补：一段 3.2 秒的片子配上
     * `-t 5`，出来还是 3.2 秒。于是成片比时间轴短了 1.8 秒。
     *
     * 而配音和字幕是按**绝对时间**摆的（timelineOf 那一份），它们仍然
     * 以为这一镜占满 5 秒。结果是**从这一镜之后，每一句台词都早出来 1.8 秒**，
     * 而且缺几镜就累加几次 —— 到片尾能错出好几秒。
     *
     * 表现和"配音顺次拼"那个老 bug 一模一样：前两镜看着挺正常，越往后越离谱。
     * 而且它**没有任何报错** —— 厂商给的片子短一点是很常见的事
     *（档位对不齐、模型提前收尾、下载被截断），任务全都是"成功"。
     *
     * ── 怎么补 ──
     *
     * 定格最后一帧（tpad=stop_mode=clone），不是补黑场。
     * 补黑场等于在片子中间闪一下，比短一点还难看；定格是剪辑里
     * 处理这种情况的常规做法，观众读作"停顿"，不违和。
     *
     * 补多少要说出来：补太多说明这一镜的分镜时长定得不合理，
     * 那是导演该知道的事，不该被悄悄抹平。
     */
    let clips = segments;
    const padded = [];
    if (trims?.length) {
      clips = [];
      for (let i = 0; i < segments.length; i++) {
        const want = trims[i];
        if (!want || want <= 0) {
          clips.push(segments[i]);
          continue;
        }
        const info = await (__probe || probeStreams)(segments[i]);
        // ⚠ 从入点往后**还剩多少**才是可用长度。拿整段长度去算的话，
        // 跳掉开头之后其实已经不够了，而补帧那一步会以为够，于是少补一截
        const real = info?.seconds ? info.seconds - (Number(cuts?.[i]?.in) || 0) : null;
        // 0.15 秒以内不管：那点差在观感上不存在，为它重编码一遍不划算
        const gap = real ? want - real : 0;
        const needPad = gap > 0.15;

        const cut = `${outputPath}.trim${i}.mp4`;
        /**
         * 入点。`-ss` 必须放在 `-i` **前面**：放前面是快速定位（先跳再解码），
         * 放后面是解码到那儿再丢弃 —— 结果一样，但后者要把前面整段解一遍。
         *
         * 没有入点时一个参数都不加，保持和以前完全一样的行为。
         */
        const startAt = Number(cuts?.[i]?.in) || 0;
        const args = ['-y'];
        if (startAt > 0) args.push('-ss', startAt.toFixed(3));
        args.push('-i', segments[i]);
        if (needPad) {
          args.push('-vf', `tpad=stop_mode=clone:stop_duration=${gap.toFixed(3)}`);
          // 有音轨的话也要跟着补静音，否则补出来的那一段没有音轨，
          // 拼接时流结构对不上（concat demuxer 对这个很敏感）
          if (info?.hasAudio) args.push('-af', `apad=pad_dur=${gap.toFixed(3)}`);
          padded.push({ index: i + 1, gap, real, want });
        }
        // 关键帧不一定落在切点上，所以这里必须重编码视频，copy 会切歪
        args.push('-t', String(want), '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', cut);
        await (__exec || run)(args, { onProgress });
        cleanup.push(cut);
        clips.push(cut);
      }
    }

    if (padded.length) {
      const worst = padded.slice().sort((a, b) => b.gap - a.gap)[0];
      onNote?.(
        `有 ${padded.length} 段比分镜时长短，已用定格最后一帧补齐（合计 ${
          padded.reduce((n, x) => n + x.gap, 0).toFixed(1)
        } 秒）—— 不补的话，从那一镜之后每一句配音和字幕都会提前，而且缺几段就累加几次。` +
        `其中第 ${worst.index} 段差得最多：厂商给了 ${worst.real.toFixed(1)} 秒，分镜要 ${worst.want} 秒。` +
        (worst.gap > 1.5 ? '差一秒半以上说明这一镜的时长定得不合理，去分镜页把它改短一点更自然。' : '')
      );
    }

    /**
     * 转场在裁剪**之后**做。
     *
     * 顺序不能反：裁剪是把厂商多给的那一两秒切掉，转场是在切完之后的
     * 真实边界上做效果。反过来的话，淡出会做在一段马上要被切掉的画面上 ——
     * 成片里看到的是"突然黑一下然后硬切"，比不做还难看。
     */
    let recode = false;
    if (transitions?.some((k) => k && k !== 'cut')) {
      const before = clips;
      clips = await buildTransitions({
        clips, kinds: transitions, outputPath, cleanup, onProgress, onNote,
        ...(__probe ? { probe: __probe } : {}),
        ...(__exec ? { exec: __exec } : {})
      });
      recode = clips !== before;
    }

    // 多条配音先合成一条整片音轨，再和视频合流
    let track = audioPath;
    if (!track && audioAt?.length) {
      track = `${outputPath}.voice.m4a`;
      const built = await buildVoiceTrack(audioAt, track, { onProgress });
      if (built) cleanup.push(track);
      else track = null;
    }
    const tracks = (audioTracks || []).filter((f) => f && fs.existsSync(f));
    if (!track && tracks.length) {
      track = `${outputPath}.voice.m4a`;
      await run(['-y', '-f', 'concat', '-safe', '0', '-i', writeList(tracks, 'audio'), '-c:a', 'aac', track], {
        onProgress
      });
      cleanup.push(track);
    }

    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', writeList(clips, 'concat')];
    /**
     * 做过转场就必须重编码。
     *
     * concat demuxer 不重编码的前提是**各段编码参数完全一致**。
     * 转场那几段是我们自己重压的（libx264 veryfast），和厂商原始片段
     * 在 profile、GOP、色彩范围上不一定对得上。硬 copy 拼出来的片子
     * 多数播放器能放，但会在接缝处花屏或者卡一下 —— 而这**只在成片里出现**，
     * 每一段单独播都是好的，最难查的那一类。
     */
    const vcodec = recode ? ['-c:v', 'libx264', '-preset', 'veryfast'] : ['-c:v', 'copy'];
    if (track && fs.existsSync(track)) {
      /**
       * ⚠ `-shortest` 会**按最短的那条流收尾**，而音轨常常比画面短 ——
       * 最后一句台词往往在片子结束前就念完了。
       *
       * 结果是**成片被砍掉结尾**：一部 11.5 秒的片子，配音只到第 7 秒，
       * 出来的成片就只有 7 秒。后面四秒半的画面凭空消失，
       * 而合成这一步是"成功"的，没有任何报错。
       *
       * 这个坑在真跑一遍之前完全看不出来 —— 参数看着天经地义。
       *
       * apad 把音轨用静音补到无限长，`-shortest` 于是按**画面**收尾，
       * 这才是这两个参数该有的配合方式。
       */
      args.push('-i', track, ...vcodec, '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0',
        '-af', 'apad', '-shortest');
    } else if (recode) {
      args.push(...vcodec, '-c:a', 'aac');
    } else {
      args.push('-c', 'copy');
    }
    args.push(outputPath);

    await (__exec || run)(args, { onProgress });
  } finally {
    for (const f of cleanup) fs.rmSync(f, { force: true });
  }
  return outputPath;
}

/**
 * 从一段视频里抠一帧出来。
 *
 * 用途是末帧复核：视频的人设漂移几乎都发生在**后半段** ——
 * 首帧是我们自己给的，当然像；模型往后推五到十秒，脸才开始飘。
 * 只看首帧等于没看，所以默认抠的是最后一帧。
 *
 * `-sseof -0.2` 是从**结尾往回**定位，比先探时长再 seek 少一次调用，
 * 而且对时长元数据不准的文件也管用（模型出的 mp4 时长经常和档位差一点）。
 */
/**
 * 按固定间隔把整段视频采成一串小图。
 *
 * ── 为什么一次调用取全部，而不是每帧调一次 ──
 *
 * 一段 5 秒的片子按 0.2 秒采就是 25 帧。每帧起一次 FFmpeg 进程的话，
 * 二十镜就是五百次进程启动 —— 光是启动开销就比解码本身贵得多，
 * 而且在 Windows 上尤其慢。一次调用输出一整个序列，二十镜只有二十次。
 *
 * 缩到 64 像素宽：后面只拿它算感知哈希，再大都是白解码。
 */
export async function sampleFrames(videoPath, outDir, { step = 0.2 } = {}) {
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在：${videoPath}`);
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'f%04d.png');
  await run([
    '-y', '-i', videoPath,
    '-vf', `fps=${(1 / step).toFixed(4)},scale=64:-1`,
    '-q:v', '4',
    pattern
  ]);
  return fs.readdirSync(outDir)
    .filter((n) => /^f\d+\.png$/.test(n))
    .sort()
    .map((n) => path.join(outDir, n));
}

export async function grabFrame(videoPath, outPath, { at = 'end' } = {}) {
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在：${videoPath}`);
  const args =
    at === 'end'
      ? ['-y', '-sseof', '-0.2', '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-update', '1', outPath]
      : ['-y', '-ss', String(Number(at) || 0), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-update', '1', outPath];
  await run(args);
  if (!fs.existsSync(outPath)) throw new Error('FFmpeg 没有抠出帧');
  return outPath;
}

/**
 * 把一张图缩小、转成 JPEG —— 专门给"内联发给厂商的参考图"用。
 *
 * ════════ 它补的是哪个洞 ════════
 *
 * 没配对象存储时，参考图只能以 base64 内联进请求体。而我们出的分镜图
 * 是 1080p 甚至 2K 的 PNG，一张一两 MB，base64 再胀三分之一 ——
 * 五张就是八九 MB，直接顶穿厂商的请求体上限。
 *
 * 表现是这样一串（用户的真实日志）：
 *   ※ 5 张加起来 8.4MB 太大，这次只发前 4 张
 *   ※ 服务端拒了这 4 张图（合计 6.6MB）…先改成 2 张重试
 * 最后要么整镜失败，要么参考图被砍到只剩一张 —— 一致性跟着塌。
 *
 * 而这件事**根本不需要那么大的图**：参考图的作用是"这个人长什么样、
 * 这个场景什么调子"，768px 的 JPEG 完全够用，体积只有原来的十分之一。
 * 发过去的分辨率高低不影响出片分辨率 —— 那由 resolution 参数决定。
 *
 * ⚠ 只用来做**参考图**。首帧图不走这里：那张是要按像素接上的，缩了就废了。
 */
export async function shrinkImage(srcPath, outPath, { maxSide = 768, quality = 4 } = {}) {
  if (!fs.existsSync(srcPath)) throw new Error(`图片不存在：${srcPath}`);
  /**
   * `scale` 里那个 `min(iw,768)` 是为了**不放大** —— 本来就小的图放大
   * 只会变糊，体积还涨。`-2` 让另一边按比例走并保证是偶数。
   */
  const vf = `scale='min(iw,${maxSide})':-2:force_original_aspect_ratio=decrease`;
  await run(['-y', '-i', srcPath, '-vf', vf, '-q:v', String(quality), '-update', '1', outPath]);
  if (!fs.existsSync(outPath)) throw new Error('FFmpeg 没有输出缩图');
  return outPath;
}

/**
 * 把 SRT 烧进画面。
 *
 * 默认不做，因为它有两个很容易翻车的前提：这份 FFmpeg 编进了 libass，
 * 以及系统里有一个能显示中文的字体。缺哪个都会失败 ——
 * 所以调用方必须把它当成"可能失败"的一步，失败只丢字幕、不丢成片。
 *
 * 路径要转义：Windows 的反斜杠和盘符冒号在 filter 表达式里都是特殊字符，
 * 直接拼进去必挂。
 */
export async function burnSubtitles(videoPath, srtPath, outPath, { onProgress, fontName = '' } = {}) {
  const esc = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const style = fontName ? `:force_style='FontName=${fontName}'` : '';
  await run(
    ['-y', '-i', videoPath, '-vf', `subtitles='${esc}'${style}`, '-c:a', 'copy', outPath],
    { onProgress }
  );
  if (!fs.existsSync(outPath)) throw new Error('FFmpeg 没有输出带字幕的文件');
  return outPath;
}

export function status() {
  return locate({ refresh: true });
}
