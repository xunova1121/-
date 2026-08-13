/**
 * Electron 主进程。
 *
 * 本地服务跑在主进程里（不另起子进程）：省一个进程、省一次端口协商，
 * 关窗口时服务跟着走，不会留下孤儿进程占着 5178 端口 ——
 * 这是本地工具类应用最常见的投诉之一。
 *
 * 另一个作用是把 Windows DPAPI（safeStorage）接进保险箱：
 * 在桌面应用里，密钥的加密密钥由操作系统托管并绑定当前用户账户，
 * 比裸 Node 模式下自管一个 key 文件安全一档。
 */
import { app, BrowserWindow, Menu, shell, dialog, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverInfo = null;

// 同一时间只允许一个实例：两个实例会抢同一份项目文件，写坏了很难查
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

async function startServer() {
  const vault = await import(path.join(here, '../core/vault.js'));
  vault.attachSafeStorage(safeStorage);

  const { listen } = await import(path.join(here, '../core/server.js'));
  serverInfo = await listen();
  return serverInfo;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: async () => {
            const { DATA_DIR } = await import(path.join(here, '../core/paths.js'));
            shell.openPath(DATA_DIR);
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于未来创梦',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '未来创梦',
              detail:
                `AI 短剧工作台\n\n` +
                `本地服务：${serverInfo?.url || '未启动'}\n` +
                `Electron ${process.versions.electron} · Node ${process.versions.node}\n\n` +
                `所有数据留在本机，密钥由 Windows DPAPI 加密保存。`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#16130F', // 和界面底色一致，避免启动时闪一下白屏
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      // 预加载脚本必须是 CJS：package.json 里 type=module，同名 .js 会被当 ESM 解析
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 站外链接一律交给系统浏览器，不在应用里开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverInfo.url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await mainWindow.loadURL(serverInfo.url);
  mainWindow.on('closed', () => (mainWindow = null));
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('启动失败', `本地服务没能起来：\n\n${err.message}`);
    app.quit();
    return;
  }
  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  serverInfo?.server?.close();
  if (process.platform !== 'darwin') app.quit();
});
