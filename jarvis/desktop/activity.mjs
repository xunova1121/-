/**
 * 操作习惯学习的“眼睛”：每隔一会儿看一眼前台是哪个程序（只取程序名）。
 *   - 只记录程序名和时间：不读窗口标题、网址、按键、屏幕内容
 *   - 键盘鼠标空闲超过 1 分钟不记录（人不在，前台程序不代表在用）
 *   - 默认关闭，用户在设置里打开；关闭后立刻停止
 *
 *   Windows  常驻 PowerShell，GetForegroundWindow → 进程的“描述”（如 Visual Studio Code、微信）
 *   macOS    lsappinfo（系统自带，不需要额外授权）
 *   Linux    xdotool getactivewindow getwindowclassname
 */
import { spawn, execFile } from 'node:child_process';

const WIN_FG = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class JFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
while ($true) {
  $fgPid = 0
  [void][JFg]::GetWindowThreadProcessId([JFg]::GetForegroundWindow(), [ref]$fgPid)
  $name = ''
  try { $p = Get-Process -Id $fgPid -ErrorAction Stop; $name = $p.Description; if (-not $name) { $name = $p.ProcessName } } catch { }
  [Console]::Out.WriteLine($name)
  [Console]::Out.Flush()
  Start-Sleep -Seconds __SEC__
}
`;

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))));

/** 从 lsappinfo 的输出里取程序名 */
export function parseLsappinfo(out) {
  return String(out).match(/"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/)?.[1] ?? '';
}

export function winScript(sec) {
  return WIN_FG.replace('__SEC__', String(Math.max(5, Math.round(sec))));
}

/**
 * @param {{ platform?: string, powerMonitor: { getSystemIdleTime(): number }, onSample: (s: { app: string, ts: number }) => void, intervalSec?: number, idleLimitSec?: number }} o
 */
export function createActivity({ platform = process.platform, powerMonitor, onSample, intervalSec = 20, idleLimitSec = 60 }) {
  let timer = 0;
  let proc = null;
  let on = false;
  const emit = (app) => {
    app = String(app || '').trim();
    if (!on || !app) return;
    if (powerMonitor.getSystemIdleTime() >= idleLimitSec) return;
    onSample({ app, ts: Date.now() });
  };

  async function sampleOnce() {
    if (platform === 'darwin') {
      const asn = (await run('lsappinfo', ['front'])).trim();
      if (asn) emit(parseLsappinfo(await run('lsappinfo', ['info', '-only', 'name', asn])));
    } else {
      emit((await run('xdotool', ['getactivewindow', 'getwindowclassname'])).trim());
    }
  }

  return {
    get on() { return on; },
    start() {
      if (on) return;
      on = true;
      if (platform === 'win32') {
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(winScript(intervalSec), 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let buf = '';
        proc.stdout.on('data', (d) => {
          buf += d.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
        });
        proc.on('error', () => { proc = null; });
      } else {
        sampleOnce();
        timer = setInterval(sampleOnce, intervalSec * 1000);
      }
    },
    stop() {
      on = false;
      clearInterval(timer);
      timer = 0;
      try { proc?.kill(); } catch { /* 已退出 */ }
      proc = null;
    }
  };
}
