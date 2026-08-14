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
  if (!fs.existsSync(file)) return null;
  try {
    const { stderr } = await run(['-i', file, '-f', 'null', '-']);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
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
      // adelay 要按声道给值，all=1 省得去数这条音频是单声道还是立体声
      return `[${i}:a]adelay=${ms}:all=1[a${i}]`;
    })
    .join(';');
  const mixIn = entries.map((_, i) => `[a${i}]`).join('');
  return `${filters};${mixIn}amix=inputs=${entries.length}:dropout_transition=0:normalize=0[out]`;
}

export async function buildVoiceTrack(entries, outputPath, { onProgress } = {}) {
  const usable = (entries || []).filter((e) => e?.path && fs.existsSync(e.path));
  if (!usable.length) return null;

  const args = ['-y'];
  for (const e of usable) args.push('-i', e.path);
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
export async function concat(segments, outputPath, { audioPath, audioTracks, audioAt, trims, onProgress } = {}) {
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
    // 按分镜时长裁剪：模型只给固定档位（5s/10s），想精确命中目标时长就得切。
    // 用 -t 而不是重新编码整段 —— 只截时长，画质不动。
    let clips = segments;
    if (trims?.length) {
      clips = [];
      for (let i = 0; i < segments.length; i++) {
        const want = trims[i];
        if (!want || want <= 0) {
          clips.push(segments[i]);
          continue;
        }
        const cut = `${outputPath}.trim${i}.mp4`;
        // 关键帧不一定落在切点上，所以这里必须重编码视频，copy 会切歪
        await run(['-y', '-i', segments[i], '-t', String(want), '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', cut], {
          onProgress
        });
        cleanup.push(cut);
        clips.push(cut);
      }
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
    if (track && fs.existsSync(track)) {
      // 视频不重编码（快），音频统一转 AAC（各家出的容器不一定一致）
      args.push('-i', track, '-c:v', 'copy', '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0', '-shortest');
    } else {
      args.push('-c', 'copy');
    }
    args.push(outputPath);

    await run(args, { onProgress });
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
