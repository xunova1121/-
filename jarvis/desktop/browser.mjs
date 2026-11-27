/**
 * 内置浏览器：对话里点链接时在未央自己的窗口里看，右上角一键转到系统浏览器。
 *
 *   - 一个窗口两层：上面是工具栏（browserBar.html，只有后退 / 前进 / 刷新 / 网址 / 用系统浏览器打开），
 *     下面是网页本身
 *   - 网页和未央完全隔开：单独的登录存储（persist:jarvis-browser），没有 preload，拿不到未央的任何接口
 *   - 只在里面打开 http / https；mailto、tel 等交给系统，其他协议（file、javascript……）一律不开
 *   - 网页里再点“新窗口”的链接：就在当前窗口打开，不弹一堆窗口
 */
import path from 'node:path';

const BAR = 44;

/** 地址栏输入 → 网址：像网址的补上 https://，否则当搜索词（国内用必应） */
export function addressToUrl(input) {
  const t = String(input ?? '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return safeUrl(t);
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) return safeUrl(`https://${t}`);
  return `https://cn.bing.com/search?q=${encodeURIComponent(t)}`;
}

/** 能在内置浏览器里打开的网址：只要 http / https，其余返回 null */
export function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** 交给系统处理的链接（发邮件、打电话） */
const SYSTEM_SCHEME = /^(mailto|tel|sms):/i;

/**
 * @param {{ BaseWindow, WebContentsView, ipcMain, shell, session, here: string, icon?: string }} deps
 * @returns {{ open: (url: string) => boolean }}
 */
export function createBrowser({ BaseWindow, WebContentsView, ipcMain, shell, session, here, icon }) {
  let win = null;
  let bar = null;
  let page = null;

  const external = (url) => {
    if (safeUrl(url) || SYSTEM_SCHEME.test(String(url))) shell.openExternal(String(url));
  };
  const state = () => {
    if (!bar || !page) return;
    const wc = page.webContents;
    const nav = wc.navigationHistory;
    bar.webContents.send('jarvis-browser:state', {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      back: nav.canGoBack(),
      forward: nav.canGoForward()
    });
  };
  const layout = () => {
    const [w, h] = win.getContentSize();
    bar.setBounds({ x: 0, y: 0, width: w, height: BAR });
    page.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) });
  };

  function create() {
    win = new BaseWindow({ width: 1180, height: 820, minWidth: 480, minHeight: 360, title: '未央浏览器', icon, backgroundColor: '#03070d' });
    bar = new WebContentsView({
      webPreferences: { preload: path.join(here, 'browserPreload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    // 网页层：不给 preload，单独的存储，和未央本体互不相通
    page = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, session: session.fromPartition('persist:jarvis-browser') }
    });
    win.contentView.addChildView(page);
    win.contentView.addChildView(bar);
    bar.webContents.loadFile(path.join(here, 'browserBar.html'));
    layout();
    win.on('resize', layout);
    win.on('closed', () => {
      win = bar = page = null;
    });
    const wc = page.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (safeUrl(url)) wc.loadURL(url);
      else external(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (safeUrl(url)) return;
      e.preventDefault();
      external(url);
    });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev, state);
    wc.on('page-title-updated', (_e, title) => win?.setTitle(`${title} - 未央浏览器`));
    bar.webContents.on('did-finish-load', state);
  }

  // 工具栏的按钮：只认工具栏自己发来的
  const fromBar = (e) => bar && e.sender === bar.webContents;
  ipcMain.on('jarvis-browser:do', (e, action, value) => {
    if (!fromBar(e) || !page) return;
    const wc = page.webContents;
    const nav = wc.navigationHistory;
    if (action === 'back' && nav.canGoBack()) nav.goBack();
    else if (action === 'forward' && nav.canGoForward()) nav.goForward();
    else if (action === 'reload') wc.isLoading() ? wc.stop() : wc.reload();
    else if (action === 'go') {
      const url = addressToUrl(value);
      if (url) wc.loadURL(url);
    } else if (action === 'external') external(wc.getURL());
  });

  return {
    /** 在内置浏览器里打开（不是 http / https 的不开，返回 false） */
    open(url) {
      const target = safeUrl(url);
      if (!target) return false;
      if (!win) create();
      page.webContents.loadURL(target);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return true;
    }
  };
}
