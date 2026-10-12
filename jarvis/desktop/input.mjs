/**
 * 鼠标键盘控制（不依赖原生模块，三个系统各用自带的能力）：
 *   Windows  常驻一个 PowerShell 进程，调用 user32（SetCursorPos / mouse_event / keybd_event），开启 DPI 感知后按物理像素定位
 *   macOS    osascript（JavaScript for Automation）调用 CoreGraphics 发送鼠标键盘事件，坐标单位是“点”；需要在
 *            “系统设置 → 隐私与安全性 → 辅助功能”里允许贾维斯
 *   Linux    xdotool（需要 X11；Wayland 下多数桌面不允许模拟输入）
 *
 * 所有坐标都是“屏幕坐标”：Windows / Linux 为物理像素，macOS 为点（调用方负责从截图坐标换算）。
 * 输入文字统一用“剪贴板 + 粘贴”：中文、表情都不会乱码，也不受输入法影响。
 */
import { spawn, execFile } from 'node:child_process';

// ---------------------------------------------------------------- 按键名
const ALIAS = {
  control: 'ctrl', ctl: 'ctrl', cmd: 'meta', command: 'meta', win: 'meta', windows: 'meta', super: 'meta', option: 'alt', opt: 'alt',
  return: 'enter', esc: 'escape', del: 'delete', bksp: 'backspace', pgup: 'pageup', pgdn: 'pagedown', ins: 'insert',
  '回车': 'enter', '空格': 'space', '退格': 'backspace', '删除': 'delete'
};

/** “Ctrl+Shift+S” → ['ctrl','shift','s']；空格、加号分隔都可以 */
export function parseKeys(combo) {
  const parts = String(combo).trim().toLowerCase().split(/\s*\+\s*|\s+/).filter(Boolean);
  if (!parts.length) throw new Error('没有给出按键');
  return parts.map((k) => ALIAS[k] ?? k);
}
const MODS = new Set(['ctrl', 'shift', 'alt', 'meta']);

const WIN_VK = {
  ctrl: 0x11, shift: 0x10, alt: 0x12, meta: 0x5b, enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e, insert: 0x2d,
  space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  capslock: 0x14, printscreen: 0x2c, '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '`': 0xc0
};
const WIN_EXTENDED = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'meta']);
export function winVk(k) {
  if (WIN_VK[k] !== undefined) return WIN_VK[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const f = k.match(/^f([1-9]|1[0-2])$/);
  if (f) return 0x6f + Number(f[1]);
  throw new Error(`不认识的按键：${k}`);
}

const MAC_KEY = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35,
  enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, '`': 50,
  backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
};
const MAC_FLAG = { meta: 'kCGEventFlagMaskCommand', ctrl: 'kCGEventFlagMaskControl', alt: 'kCGEventFlagMaskAlternate', shift: 'kCGEventFlagMaskShift' };
export function macKey(k) {
  if (MAC_KEY[k] === undefined) throw new Error(`不认识的按键：${k}`);
  return MAC_KEY[k];
}

const XDO_KEY = {
  ctrl: 'ctrl', shift: 'shift', alt: 'alt', meta: 'super', enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete',
  insert: 'Insert', space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash', '`': 'grave'
};
export const xdoKey = (k) => XDO_KEY[k] ?? (/^([a-z0-9]|f([1-9]|1[0-2]))$/.test(k) ? (k.startsWith('f') && k.length > 1 ? k.toUpperCase() : k) : (() => { throw new Error(`不认识的按键：${k}`); })());

/** 粘贴快捷键：macOS 是 Cmd+V，其他是 Ctrl+V */
export const pasteCombo = (platform) => (platform === 'darwin' ? 'meta+v' : 'ctrl+v');

// ---------------------------------------------------------------- Windows：常驻 PowerShell
const WIN_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class JInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
[JInput]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    foreach ($cmd in $line.Split(';')) {
      $p = $cmd.Trim().Split(' ')
      switch ($p[0]) {
        'move'  { [JInput]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
        'mouse' { [JInput]::mouse_event([uint32]$p[1], 0, 0, [int]$p[2], [UIntPtr]::Zero) }
        'key'   { [JInput]::keybd_event([byte]$p[1], 0, [uint32]$p[2], [UIntPtr]::Zero) }
        'sleep' { Start-Sleep -Milliseconds ([int]$p[1]) }
      }
    }
    [Console]::Out.WriteLine('ok')
  } catch { [Console]::Out.WriteLine('err ' + $_.Exception.Message) }
}
`;

const WIN_BTN = { left: [0x2, 0x4], right: [0x8, 0x10], middle: [0x20, 0x40] };

/** 把一个动作翻译成 Windows 助手的命令行（纯函数，便于测试） */
export function winScript(action) {
  const c = [];
  const keyDown = (k) => c.push(`key ${winVk(k)} ${WIN_EXTENDED.has(k) ? 1 : 0}`);
  const keyUp = (k) => c.push(`key ${winVk(k)} ${WIN_EXTENDED.has(k) ? 3 : 2}`);
  switch (action.type) {
    case 'move': c.push(`move ${action.x} ${action.y}`); break;
    case 'click': {
      const [down, up] = WIN_BTN[action.button || 'left'];
      c.push(`move ${action.x} ${action.y}`, 'sleep 40');
      for (let i = 0; i < (action.count || 1); i++) c.push(`mouse ${down} 0`, `mouse ${up} 0`, 'sleep 60');
      break;
    }
    case 'drag':
      c.push(`move ${action.x} ${action.y}`, 'sleep 40', 'mouse 2 0', 'sleep 80');
      for (let i = 1; i <= 8; i++) c.push(`move ${Math.round(action.x + (action.toX - action.x) * i / 8)} ${Math.round(action.y + (action.toY - action.y) * i / 8)}`, 'sleep 25');
      c.push('sleep 60', 'mouse 4 0');
      break;
    case 'scroll':
      c.push(`move ${action.x} ${action.y}`, 'sleep 30');
      for (let i = 0; i < (action.amount || 3); i++) c.push(`mouse 2048 ${action.direction === 'up' ? 120 : -120}`, 'sleep 20');
      break;
    case 'key': {
      const keys = parseKeys(action.keys);
      for (const k of keys) keyDown(k);
      for (const k of [...keys].reverse()) keyUp(k);
      break;
    }
    default: throw new Error(`未知动作：${action.type}`);
  }
  return c.join(';');
}

function windowsDriver() {
  let proc = null;
  let ready = null;
  const queue = [];
  let buf = '';
  const start = () => {
    // 脚本用 -EncodedCommand 传入，标准输入只用来逐行发送动作命令
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_HELPER, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    ready = new Promise((resolve, reject) => {
      queue.push({ resolve, reject });
      proc.on('error', (e) => { for (const q of queue.splice(0)) q.reject(e); proc = null; });
      proc.on('exit', () => { for (const q of queue.splice(0)) q.reject(new Error('输入助手已退出')); proc = null; });
    });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const q = queue.shift();
        if (!q) continue;
        if (line.startsWith('err')) q.reject(new Error(line.slice(4))); else q.resolve();
      }
    });
  };
  return {
    async run(action) {
      if (!proc) start();
      await ready;
      return new Promise((resolve, reject) => {
        queue.push({ resolve, reject });
        proc.stdin.write(`${winScript(action)}\n`);
      });
    },
    close() { try { proc?.stdin.end(); proc?.kill(); } catch { /* 已退出 */ } proc = null; }
  };
}

// ---------------------------------------------------------------- macOS：JXA + CoreGraphics
export function macScript(action) {
  const head = "ObjC.import('CoreGraphics');ObjC.import('Foundation');const P=(x,y)=>$.CGPointMake(x,y);const post=(e)=>$.CGEventPost($.kCGHIDEventTap,e);const nap=(ms)=>$.NSThread.sleepForTimeInterval(ms/1000);";
  const mouse = (type, x, y, btn = 'kCGMouseButtonLeft') => `post($.CGEventCreateMouseEvent(null,$.${type},P(${x},${y}),$.${btn}));`;
  switch (action.type) {
    case 'move': return head + mouse('kCGEventMouseMoved', action.x, action.y);
    case 'click': {
      const b = action.button || 'left';
      const [dn, up, btn] = b === 'right' ? ['kCGEventRightMouseDown', 'kCGEventRightMouseUp', 'kCGMouseButtonRight']
        : b === 'middle' ? ['kCGEventOtherMouseDown', 'kCGEventOtherMouseUp', 'kCGMouseButtonCenter'] : ['kCGEventLeftMouseDown', 'kCGEventLeftMouseUp', 'kCGMouseButtonLeft'];
      let s = head + mouse('kCGEventMouseMoved', action.x, action.y) + 'nap(40);';
      for (let i = 1; i <= (action.count || 1); i++) {
        s += `{const d=$.CGEventCreateMouseEvent(null,$.${dn},P(${action.x},${action.y}),$.${btn});$.CGEventSetIntegerValueField(d,$.kCGMouseEventClickState,${i});post(d);`
          + `const u=$.CGEventCreateMouseEvent(null,$.${up},P(${action.x},${action.y}),$.${btn});$.CGEventSetIntegerValueField(u,$.kCGMouseEventClickState,${i});post(u);nap(40);}`;
      }
      return s;
    }
    case 'drag': {
      let s = head + mouse('kCGEventMouseMoved', action.x, action.y) + 'nap(40);' + mouse('kCGEventLeftMouseDown', action.x, action.y) + 'nap(80);';
      for (let i = 1; i <= 8; i++) s += mouse('kCGEventLeftMouseDragged', Math.round(action.x + (action.toX - action.x) * i / 8), Math.round(action.y + (action.toY - action.y) * i / 8)) + 'nap(25);';
      return s + mouse('kCGEventLeftMouseUp', action.toX, action.toY);
    }
    case 'scroll': {
      const n = (action.amount || 3) * (action.direction === 'up' ? 3 : -3);
      return head + mouse('kCGEventMouseMoved', action.x, action.y) + `nap(30);post($.CGEventCreateScrollWheelEvent2(null,$.kCGScrollEventUnitLine,1,${n},0,0));`;
    }
    case 'key': {
      const keys = parseKeys(action.keys);
      const mods = keys.filter((k) => MODS.has(k));
      const main = keys.filter((k) => !MODS.has(k));
      if (main.length !== 1) throw new Error('macOS 一次只能按一个主键（可以带修饰键），如 cmd+s');
      const flags = mods.map((m) => `$.${MAC_FLAG[m]}`).join('|') || '0';
      const code = macKey(main[0]);
      return `${head}const d=$.CGEventCreateKeyboardEvent(null,${code},true);$.CGEventSetFlags(d,${flags});post(d);nap(20);const u=$.CGEventCreateKeyboardEvent(null,${code},false);$.CGEventSetFlags(u,${flags});post(u);`;
    }
    default: throw new Error(`未知动作：${action.type}`);
  }
}

// ---------------------------------------------------------------- Linux：xdotool
export function xdoArgs(action) {
  const btn = { left: 1, middle: 2, right: 3 }[action.button || 'left'];
  switch (action.type) {
    case 'move': return ['mousemove', '--sync', action.x, action.y].map(String);
    case 'click': return ['mousemove', '--sync', action.x, action.y, 'click', '--repeat', action.count || 1, '--delay', 60, btn].map(String);
    case 'drag': return ['mousemove', '--sync', action.x, action.y, 'mousedown', 1, 'mousemove', '--sync', action.toX, action.toY, 'mouseup', 1].map(String);
    case 'scroll': return ['mousemove', '--sync', action.x, action.y, 'click', '--repeat', action.amount || 3, action.direction === 'up' ? 4 : 5].map(String);
    case 'key': return ['key', '--clearmodifiers', parseKeys(action.keys).map(xdoKey).join('+')];
    default: throw new Error(`未知动作：${action.type}`);
  }
}

const execP = (cmd, args, timeout = 15000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(String(stdout))));
});

/**
 * @param {{ platform?: string, exec?: Function }} [o]
 * @returns {{ run(action): Promise<void>, close(): void }}
 */
export function createInput({ platform = process.platform, exec = execP } = {}) {
  if (platform === 'win32') return windowsDriver();
  if (platform === 'darwin') {
    return {
      async run(action) {
        try { await exec('osascript', ['-l', 'JavaScript', '-e', macScript(action)]); } catch (e) { throw new Error(`操作失败：${String(e.stderr || e.message).slice(0, 200)}`); }
      },
      close() {}
    };
  }
  return {
    async run(action) {
      try { await exec('xdotool', xdoArgs(action)); } catch (e) {
        if (e.code === 'ENOENT') throw new Error('需要安装 xdotool（如 sudo apt install xdotool），并使用 X11 桌面会话');
        throw new Error(`操作失败：${String(e.stderr || e.message).slice(0, 200)}`);
      }
    },
    close() {}
  };
}
