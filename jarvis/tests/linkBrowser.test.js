/** 内置浏览器：哪些链接在 App 里打开、地址栏输入怎么变成网址 */
import { describe, it, expect, vi } from 'vitest';
import { externalLink, installLinkBrowser } from '../src/mobile/linkBrowser.js';
import { addressToUrl, safeUrl } from '../desktop/browser.mjs';

const ORIGIN = 'https://localhost';
/** 假的 <a>：只要 closest / getAttribute / hasAttribute */
const link = (href, attrs = {}) => {
  const a = { getAttribute: (k) => (k === 'href' ? href : attrs[k] ?? null), hasAttribute: (k) => k in attrs };
  a.closest = () => a;
  return a;
};

describe('安卓：哪些链接在 App 里打开', () => {
  it('外部 http / https 链接：在 App 里打开', () => {
    expect(externalLink(link('https://www.baidu.com/s?wd=1'), ORIGIN)).toBe('https://www.baidu.com/s?wd=1');
    expect(externalLink(link('http://news.cn/a'), ORIGIN)).toBe('http://news.cn/a');
  });
  it('App 自己的页面、blob 下载、带 download 的、mailto、javascript：不管', () => {
    expect(externalLink(link('/workspace'), ORIGIN)).toBeNull();
    expect(externalLink(link('blob:https://localhost/1'), ORIGIN)).toBeNull();
    expect(externalLink(link('https://a.com/x.pdf', { download: '' }), ORIGIN)).toBeNull();
    expect(externalLink(link('mailto:a@b.com'), ORIGIN)).toBeNull();
    expect(externalLink(link('javascript:alert(1)'), ORIGIN)).toBeNull();
    expect(externalLink({ closest: () => null }, ORIGIN)).toBeNull();
  });
  it('点击被拦下交给插件；插件打不开时退回系统浏览器', async () => {
    let handler;
    const doc = { addEventListener: (_t, fn, capture) => { handler = fn; expect(capture).toBe(true); } };
    const Browser = { open: vi.fn(async () => { throw new Error('没有 Custom Tabs'); }) };
    const open = vi.fn();
    vi.stubGlobal('open', open); // 测试环境没有 window.open
    installLinkBrowser(Browser, { doc, origin: ORIGIN });
    const e = { target: link('https://www.gov.cn/'), defaultPrevented: false, preventDefault: vi.fn() };
    handler(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(Browser.open).toHaveBeenCalledWith({ url: 'https://www.gov.cn/', toolbarColor: '#03070d' });
    await new Promise((r) => setTimeout(r, 0));
    expect(open).toHaveBeenCalledWith('https://www.gov.cn/', '_blank');
    vi.unstubAllGlobals();
  });
});

describe('电脑版：地址栏', () => {
  it('像网址的补上 https，其余当搜索词', () => {
    expect(addressToUrl('example.com')).toBe('https://example.com/');
    expect(addressToUrl('127.0.0.1:8080/b')).toBe('https://127.0.0.1:8080/b');
    expect(addressToUrl('http://a.com/x')).toBe('http://a.com/x');
    expect(addressToUrl('南京 天气')).toBe('https://cn.bing.com/search?q=%E5%8D%97%E4%BA%AC%20%E5%A4%A9%E6%B0%94');
    expect(addressToUrl('  ')).toBeNull();
  });
  it('只放行 http / https', () => {
    expect(safeUrl('https://a.com')).toBe('https://a.com/');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', '不是网址']) expect(safeUrl(bad)).toBeNull();
  });
});
