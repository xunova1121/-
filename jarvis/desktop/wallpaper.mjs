/**
 * 桌面背景模式：未央的粒子体铺满桌面，待在所有窗口下面。
 *   Windows  把窗口挂到桌面图标后面那一层（WorkerW，和动态壁纸软件同样的做法）；失败时退回“置底窗口”
 *   macOS    窗口类型 desktop（桌面层级，所有桌面空间可见）
 *   Linux    窗口类型 desktop（_NET_WM_WINDOW_TYPE_DESKTOP，多数桌面环境支持）
 * 壁纸窗口只负责显示，不接收点击；和未央说话用快捷键、托盘或唤醒词。
 */
import { execFile } from 'node:child_process';

const WIN_ATTACH = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class JWall {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  public static string Attach(IntPtr hwnd) {
    IntPtr progman = FindWindow("Progman", null);
    IntPtr r;
    SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
    IntPtr worker = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) worker = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
      return true;
    }, IntPtr.Zero);
    if (worker == IntPtr.Zero) worker = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null); // Windows 11 24H2 起 WorkerW 在 Progman 里面
    if (worker != IntPtr.Zero && SetParent(hwnd, worker) != IntPtr.Zero) return "attached";
    SetWindowPos(hwnd, new IntPtr(1), 0, 0, 0, 0, 0x0013); // HWND_BOTTOM，不移动、不改大小、不激活
    return "bottom";
  }
}
'@
[Console]::Out.Write([JWall]::Attach([IntPtr]::new(__HWND__)))
`;

/** 窗口句柄 Buffer → 十进制字符串 */
export function hwndOf(buf) {
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

export function attachScript(hwnd) {
  if (!/^\d+$/.test(String(hwnd))) throw new Error('窗口句柄无效');
  return WIN_ATTACH.replace('__HWND__', String(hwnd));
}

/**
 * @param {{ BrowserWindow, screen, url: string, preload: string, icon?: string, platform?: string, onLog?: Function }} d
 */
export function createWallpaper(d) {
  const platform = d.platform ?? process.platform;
  let win = null;
  let mode = '';

  function pin() {
    if (!win) return;
    if (platform === 'win32') {
      const script = attachScript(hwndOf(win.getNativeWindowHandle()));
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 }, (err, out) => {
        mode = err ? 'normal' : String(out).trim();
        d.onLog?.(`壁纸模式：${mode}${err ? `（${err.message}）` : ''}`);
      });
    } else {
      mode = 'desktop';
      if (platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    }
  }

  return {
    get open() { return Boolean(win); },
    get mode() { return mode; },
    get window() { return win; },
    show() {
      if (win) return win;
      const b = d.screen.getPrimaryDisplay().bounds;
      win = new d.BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, focusable: false, show: false, hasShadow: false,
        backgroundColor: '#03070d', title: '未央 · 桌面',
        ...(platform !== 'win32' && { type: 'desktop' }),
        ...(d.icon && { icon: d.icon }),
        webPreferences: { preload: d.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
      });
      win.loadURL(d.url);
      win.once('ready-to-show', () => { win?.showInactive(); pin(); });
      win.on('closed', () => { win = null; mode = ''; });
      return win;
    },
    close() { win?.destroy(); win = null; mode = ''; },
    send(payload) { win?.webContents.send('jarvis:wallpaper', payload); }
  };
}
