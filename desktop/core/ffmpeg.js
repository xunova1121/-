/**
 * FFmpeg 封装。
 *
 * Windows 上 FFmpeg 是最容易卡住新手的一环：官方不提供安装包，解压后还得配 PATH。
 * 所以这里的探测顺序是：设置里手填的路径 → 应用自带的 bin\ffmpeg.exe → PATH。
 * 三条都不中时，不抛异常打断流程，而是把"没装 FFmpeg"作为一种状态回给界面，
 * 让用户照样能跑到"视频生成"这一步，只是最后合成那步给出明确的安装指引。
 */
import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_BIN } from './paths.js';
import * as settings from './settings.js';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

let cached = null;

export function locate({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const candidates = [];
  const configured = settings.get('ffmpegPath');
  if (configured) candidates.push(configured);
  candidates.push(path.join(BUNDLED_BIN, EXE));
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
          source: candidate === configured ? 'settings' : isPath ? 'bundled' : 'PATH'
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
    hint:
      '未检测到 FFmpeg。三选一：① 到 ffmpeg.org 下载 Windows 构建，把 ffmpeg.exe 放进本应用的 bin\\ 目录；' +
      '② winget install Gyan.FFmpeg；③ 在「设置」里直接填 ffmpeg.exe 的完整路径。'
  };
  return cached;
}

function spawnSync(cmd, args) {
  const r = nodeSpawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
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
 * 把若干片段按顺序拼起来，可选叠一条整片音轨。
 * 用 concat demuxer 而不是 filter_complex —— 前者不重编码，快得多，
 * 代价是要求各片段编码参数一致（同一模型出的视频通常都一致）。
 */
export async function concat(segments, outputPath, { audioPath, audioTracks, onProgress } = {}) {
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
    // 多条配音先拼成一条整片音轨，再和视频合流
    let track = audioPath;
    const tracks = (audioTracks || []).filter((f) => f && fs.existsSync(f));
    if (!track && tracks.length) {
      track = `${outputPath}.voice.m4a`;
      await run(['-y', '-f', 'concat', '-safe', '0', '-i', writeList(tracks, 'audio'), '-c:a', 'aac', track], {
        onProgress
      });
      cleanup.push(track);
    }

    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', writeList(segments, 'concat')];
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

export function status() {
  return locate({ refresh: true });
}
