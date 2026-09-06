/**
 * 运行时目录解析。
 *
 * Windows 上一切用户数据都落在 %APPDATA%\FutureDream 下，绝不写进安装目录 ——
 * Program Files 默认对普通用户只读，往那里写是 Windows 应用最常见的翻车点。
 * macOS / Linux 走各自的惯例，方便开发机上调试。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'FutureDream';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 应用自身的代码根目录（desktop/） */
export const ROOT = path.resolve(here, '..');
export const UI_DIR = path.join(ROOT, 'ui');

function baseDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

/** 允许测试 / 便携版通过环境变量整体搬家 */
export const DATA_DIR = process.env.FUTUREDREAM_DATA_DIR
  ? path.resolve(process.env.FUTUREDREAM_DATA_DIR)
  : path.join(baseDir(), APP_NAME);

export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const OUTPUT_DIR = path.join(DATA_DIR, 'output');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
/** 画风预览图：用用户自己的模型出的，出一次就一直用 */
export const STYLE_DIR = path.join(DATA_DIR, 'style-previews');

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const VAULT_FILE = path.join(DATA_DIR, 'credentials.enc');
export const HISTORY_FILE = path.join(DATA_DIR, 'api-history.json');

/**
 * 放 ffmpeg.exe 的地方。**首选是数据目录下的 bin\**。
 *
 * 这里踩过一个只在打包后才出现的坑：源码里确实有 desktop\bin\，
 * 于是"把 ffmpeg.exe 放进本应用的 bin 目录"在开发机上是对的。
 * 但装完之后完全不是那么回事 ——
 *
 *   · core\ 被打进 app.asar，所以 ROOT 变成 ...\resources\app.asar，
 *     ROOT\bin 是个 **asar 包内的虚拟路径**，既不存在也没法往里放文件；
 *   · 真正随包发出去的 bin（extraResources）落在 ...\resources\bin，
 *     和代码找的地方差着一层；
 *   · 就算找对了，那也在安装目录里 —— 装到 Program Files 时普通用户写不进去。
 *
 * 所以顺序改成：数据目录 > 随包目录 > 源码目录。
 * 第一条是唯一**任何情况下都可写**的位置，也是提示语里该告诉用户的那一个。
 */
export const USER_BIN_DIR = path.join(DATA_DIR, 'bin');

/** 随安装包发出来的 bin（electron-builder 的 extraResources 落点） */
const PACKAGED_BIN = process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null;

/** 源码目录下的 bin —— 开发机和"解压即用"的免安装版走这条 */
const SOURCE_BIN = path.join(ROOT, 'bin');

/** 按优先级排好的候选目录，去重 */
export const BIN_DIRS = [
  process.env.FUTUREDREAM_BIN_DIR ? path.resolve(process.env.FUTUREDREAM_BIN_DIR) : null,
  USER_BIN_DIR,
  PACKAGED_BIN,
  SOURCE_BIN
].filter((d, i, all) => d && all.indexOf(d) === i);

/** 兼容旧名字：仍指第一顺位 */
export const BUNDLED_BIN = BIN_DIRS[0];

export function ensureDirs() {
  // USER_BIN_DIR 也建出来：提示语里让人"把 ffmpeg.exe 放到这里"，
  // 那这个目录就得真的存在 —— 让人自己先手动建一个目录是很糟的第一步
  for (const d of [DATA_DIR, PROJECTS_DIR, OUTPUT_DIR, CACHE_DIR, LOG_DIR, STYLE_DIR, USER_BIN_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return DATA_DIR;
}

/**
 * 把任意标题变成安全的文件名。Windows 的保留字符比 POSIX 多一大截，
 * 而且 CON/PRN/AUX/NUL/COM1..9/LPT1..9 这些设备名整个不能用作文件名，
 * 结尾的点和空格也会被资源管理器悄悄吃掉，一并处理。
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_CHARS = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');

export function safeFileName(input, fallback = 'untitled') {
  let name = String(input ?? '')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!name) name = fallback;
  if (WIN_RESERVED.test(name)) name = `_${name}`;
  return name.slice(0, 120);
}
