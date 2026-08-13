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

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const VAULT_FILE = path.join(DATA_DIR, 'credentials.enc');
export const HISTORY_FILE = path.join(DATA_DIR, 'api-history.json');

/** 便携版可以把 ffmpeg.exe 丢在 desktop/bin/ 下，免装免配 PATH */
export const BUNDLED_BIN = process.env.FUTUREDREAM_BIN_DIR
  ? path.resolve(process.env.FUTUREDREAM_BIN_DIR)
  : path.join(ROOT, 'bin');

export function ensureDirs() {
  for (const d of [DATA_DIR, PROJECTS_DIR, OUTPUT_DIR, CACHE_DIR, LOG_DIR]) {
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
