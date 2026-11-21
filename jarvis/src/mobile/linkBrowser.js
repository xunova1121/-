/**
 * 安卓 App：对话里点外部链接时，在 App 里打开（系统的应用内浏览页，Chrome Custom Tabs），
 * 右上角菜单可以转到其他浏览器。只管 http / https 的外部网址；App 自己的页面、下载用的 blob: 不管。
 */

/** 点到的是不是要在内置浏览器里打开的链接：是就返回网址，否则 null */
export function externalLink(target, origin) {
  const a = target?.closest?.('a[href]');
  if (!a || a.hasAttribute('download')) return null;
  let url;
  try {
    url = new URL(a.getAttribute('href'), origin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin === origin) return null;
  return url.href;
}

/** 装上点击拦截（在捕获阶段，别的处理拿到之前）；打不开时退回原来的系统浏览器 */
export function installLinkBrowser(Browser, { doc = document, origin = location.origin } = {}) {
  doc.addEventListener(
    'click',
    (e) => {
      const url = externalLink(e.target, origin);
      if (!url || e.defaultPrevented) return;
      e.preventDefault();
      Browser.open({ url, toolbarColor: '#03070d' }).catch(() => globalThis.open(url, '_blank'));
    },
    true
  );
}
