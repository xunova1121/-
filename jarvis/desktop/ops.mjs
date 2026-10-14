/**
 * 桌面版的电脑操作（在 Electron 主进程里执行，渲染进程通过 preload 暴露的 invoke 调用）。
 * 纯 Node 部分可以单独测试；需要 Electron 的能力（打开、回收站、截屏、剪贴板、通知）通过 deps 注入。
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const MAX_READ = 30 * 1024 * 1024;
const MAX_WRITE = 50 * 1024 * 1024;
const RUN_TIMEOUT = 60_000;
const MAX_OUTPUT = 200_000;

export function userPaths(home = os.homedir()) {
  const p = (...xs) => path.join(home, ...xs);
  // Windows / macOS 的“桌面、文档、下载”文件夹名称就是英文的
  return { home, desktop: p('Desktop'), documents: p('Documents'), downloads: p('Downloads'), pictures: p('Pictures') };
}

/** “~/x”“桌面/x”“文档”“下载/x”与绝对路径 → 绝对路径；相对路径按用户目录解析 */
export function resolvePath(input, paths = userPaths()) {
  let s = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!s) throw new Error('路径为空');
  const alias = { '~': paths.home, '桌面': paths.desktop, 'Desktop': paths.desktop, '文档': paths.documents, '我的文档': paths.documents, 'Documents': paths.documents, '下载': paths.downloads, 'Downloads': paths.downloads, '图片': paths.pictures, 'Pictures': paths.pictures };
  const m = s.match(/^([^/\\]+)(?:[/\\](.*))?$/);
  if (m && alias[m[1]] && !path.isAbsolute(s)) return path.resolve(alias[m[1]], m[2] ?? '');
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(paths.home, s);
}

/** 系统目录：不允许写入 / 移动 / 删除（防止误操作把系统弄坏） */
export function isProtected(p, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const n = P.resolve(p).replace(/\\/g, '/').toLowerCase();
  const roots = platform === 'win32'
    ? ['c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata']
    : ['/system', '/usr', '/bin', '/sbin', '/etc', '/var', '/library', '/applications', '/private', '/boot', '/dev', '/proc', '/lib', '/opt'];
  if (platform !== 'win32' && n.split('/').filter(Boolean).length <= 1) return true; // 根目录及一级目录
  if (platform === 'win32' && /^[a-z]:\/?$/.test(n)) return true; // 盘符根目录
  return roots.some((r) => n === r || n.startsWith(`${r}/`));
}
function guardWrite(p) {
  if (isProtected(p)) throw new Error(`为了安全，不允许修改系统目录：${p}`);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * @param {object} deps
 * @param {{ openPath(p): Promise<string>, openExternal(u): Promise<void>, trashItem(p): Promise<void> }} [deps.shell]
 * @param {{ readText(): string, writeText(t: string): void }} [deps.clipboard]
 * @param {() => Promise<{ base64: string, width: number, height: number }>} [deps.screenshot]
 * @param {(title: string, body?: string) => void} [deps.notify]
 * @param {string} [deps.platform]
 * @param {ReturnType<import('./backups.mjs').createBackups>} [deps.backups]  改文件前自动备份（见 backups.mjs）；不传就不备份
 */
export function createOps(deps = {}) {
  const paths = userPaths();
  const platform = deps.platform ?? process.platform;
  const R = (p) => resolvePath(p, paths);
  const bk = deps.backups ?? null;
  /** 这次有没有留备份：saved 已备份旧内容 / recorded 记下了改动（新建、移动、复制）/ too-big 太大没备份 */
  const note = (e) => (!e ? null : e.op === 'create' || e.op === 'move' || e.op === 'copy' ? 'recorded' : e.stored ? 'saved' : 'too-big');

  return {
    paths: async () => paths,

    async listDir({ path: p }) {
      const dir = R(p);
      const names = await fs.readdir(dir, { withFileTypes: true });
      const entries = [];
      for (const d of names.slice(0, 300)) {
        if (d.name.startsWith('.') && d.name !== '.env') continue;
        let st = null;
        try { st = await fs.stat(path.join(dir, d.name)); } catch { /* 无权限 */ }
        entries.push({ name: d.name, dir: d.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
      }
      entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
      return { path: dir, entries, truncated: names.length > 300 };
    },

    async search({ dir, keyword, limit = 50 }) {
      const root = R(dir);
      const kw = String(keyword).toLowerCase();
      const hits = [];
      const skip = /^(node_modules|\.git|\.cache|AppData|Library|\$Recycle\.Bin|System Volume Information)$/i;
      const queue = [[root, 0]];
      let visited = 0;
      while (queue.length && hits.length < limit && visited < 20000) {
        const [d, depth] = queue.shift();
        let items;
        try { items = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const it of items) {
          visited++;
          if (it.name.startsWith('.')) continue;
          const full = path.join(d, it.name);
          if (it.name.toLowerCase().includes(kw)) hits.push(it.isDirectory() ? `${full}${path.sep}` : full);
          if (hits.length >= limit) break;
          if (it.isDirectory() && depth < 6 && !skip.test(it.name)) queue.push([full, depth + 1]);
        }
      }
      return { dir: root, hits, truncated: hits.length >= limit };
    },

    async stat({ path: p }) {
      const f = R(p);
      const st = await fs.stat(f);
      return { path: f, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    },

    async readFile({ path: p }) {
      const f = R(p);
      const st = await fs.stat(f);
      if (st.isDirectory()) throw new Error(`${f} 是文件夹，请用 computer_list_dir`);
      if (st.size > MAX_READ) throw new Error(`文件太大（${Math.round(st.size / 1048576)} MB），最多读取 30 MB`);
      return { path: f, size: st.size, base64: (await fs.readFile(f)).toString('base64') };
    },

    async writeFile({ path: p, text, base64 }) {
      const f = R(p);
      guardWrite(f);
      const data = base64 != null ? Buffer.from(base64, 'base64') : Buffer.from(String(text ?? ''), 'utf8');
      if (data.length > MAX_WRITE) throw new Error('内容太大');
      // 先备份旧文件；备份失败（比如磁盘满了）就不写，免得旧内容找不回来
      let e = null;
      if (bk) {
        try { e = await bk.beforeWrite(f); } catch (err) { throw new Error(`备份旧文件失败，没有写入：${err.message}`); }
      }
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, data);
      if (e) await bk.afterWrite(e, f).catch(() => {});
      return { path: f, size: data.length, backup: note(e) };
    },

    async mkdir({ path: p }) {
      const f = R(p);
      guardWrite(f);
      await fs.mkdir(f, { recursive: true });
      return { path: f };
    },

    async move({ from, to }) {
      const a = R(from);
      const b = R(to);
      guardWrite(a); guardWrite(b);
      if (await exists(b)) throw new Error(`目标已存在：${b}（为避免覆盖，请换个名字）`);
      await fs.mkdir(path.dirname(b), { recursive: true });
      try { await fs.rename(a, b); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fs.cp(a, b, { recursive: true });
        await fs.rm(a, { recursive: true });
      }
      const e = await bk?.recordMove(a, b).catch(() => null);
      return { path: b, backup: note(e) };
    },

    async copy({ from, to }) {
      const a = R(from);
      const b = R(to);
      guardWrite(b);
      if (await exists(b)) throw new Error(`目标已存在：${b}（为避免覆盖，请换个名字）`);
      await fs.mkdir(path.dirname(b), { recursive: true });
      await fs.cp(a, b, { recursive: true, errorOnExist: true });
      const e = await bk?.recordCopy(b).catch(() => null);
      return { path: b, backup: note(e) };
    },

    async trash({ path: p }) {
      const f = R(p);
      guardWrite(f);
      if (!(await exists(f))) throw new Error(`不存在：${f}`);
      let e = null;
      if (bk) {
        try { e = await bk.beforeTrash(f); } catch (err) { throw new Error(`备份失败，没有删除：${err.message}`); }
      }
      await deps.shell.trashItem(f);
      return { path: f, backup: note(e) };
    },

    async open({ target }) {
      const t = String(target).trim();
      if (/^(https?|mailto):/i.test(t)) { await deps.shell.openExternal(t); return { message: `已在浏览器打开 ${t}` }; }
      let f = null;
      try { f = R(t); } catch { /* 不是路径 */ }
      if (f && fss.existsSync(f)) {
        const err = await deps.shell.openPath(f);
        if (err) throw new Error(err);
        return { message: `已打开 ${f}` };
      }
      // 不是文件：当作程序名启动
      const r = await launchApp(t, platform);
      return { message: r };
    },

    async run({ command, cwd }) {
      const dir = cwd ? R(cwd) : paths.home;
      return runShell(String(command), dir, platform);
    },

    async screenshot() { return deps.screenshot(); },
    async clipboardRead() { return { text: deps.clipboard.readText() }; },
    async clipboardWrite({ text }) { deps.clipboard.writeText(String(text ?? '')); return { ok: true }; },
    async notify({ title, body }) { deps.notify(String(title ?? '贾维斯'), String(body ?? '')); return { ok: true }; },

    // 改动记录（工作区面板）：列出、恢复前检查、恢复
    async backupList() { return bk ? bk.list() : []; },
    async backupCheck({ id }) { if (!bk) throw new Error('没有开启备份'); return bk.check({ id }); },
    async backupRestore({ id }) { if (!bk) throw new Error('没有开启备份'); return bk.restore({ id }); }
  };
}

/** 运行一条命令：Windows 用 PowerShell，其他系统用登录 shell；超时终止，输出截断 */
export function runShell(command, cwd, platform = process.platform, timeoutMs = RUN_TIMEOUT) {
  return new Promise((resolve) => {
    const [cmd, args] = platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`]]
      : [process.env.SHELL || '/bin/bash', ['-lc', command]];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, env: process.env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    const cap = (s, d) => (s.length < MAX_OUTPUT ? s + d : s);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

/** 常见中文程序名 → 系统里的名称 */
const APP_ALIASES = {
  win32: { 记事本: 'notepad', 计算器: 'calc', 画图: 'mspaint', 资源管理器: 'explorer', 文件管理器: 'explorer', 命令提示符: 'cmd', 终端: 'wt', 任务管理器: 'taskmgr', 设置: 'ms-settings:', 浏览器: 'msedge', 微信: 'WeChat', 'vs code': 'code', vscode: 'code', 'visual studio code': 'code', word: 'winword', excel: 'excel', powerpoint: 'powerpnt', ppt: 'powerpnt' },
  darwin: { 记事本: 'TextEdit', 文本编辑: 'TextEdit', 计算器: 'Calculator', 访达: 'Finder', 文件管理器: 'Finder', 终端: 'Terminal', 设置: 'System Settings', 系统设置: 'System Settings', 浏览器: 'Safari', 微信: 'WeChat', 'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', word: 'Microsoft Word', excel: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint', ppt: 'Microsoft PowerPoint' }
};

export async function launchApp(name, platform = process.platform) {
  const key = name.toLowerCase();
  const real = APP_ALIASES[platform]?.[key] ?? APP_ALIASES[platform]?.[name] ?? name;
  const quoted = real.replace(/'/g, "''");
  const r = platform === 'win32'
    ? await runShell(`Start-Process '${quoted}'`, os.homedir(), platform, 15000)
    : platform === 'darwin'
      ? await runShell(`open -a ${JSON.stringify(real)}`, os.homedir(), platform, 15000)
      : await runShell(`nohup ${JSON.stringify(real)} >/dev/null 2>&1 &`, os.homedir(), platform, 15000);
  if (r.code !== 0) throw new Error(`没能打开「${name}」：${(r.stderr || r.stdout).split('\n')[0] || '找不到这个程序'}`);
  return `已打开 ${name}`;
}
