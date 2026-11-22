import './workshopNewsReader.css';

// 标题索引的导语先显示。只有点开当前报道才读正文，离开新闻、换篇或关闭工作台会撤销读取。
export function createWorkshopNewsReader(ui, feed, choose) {
  const content = document.createElement('div');
  content.className = 'ws-article-content';
  content.setAttribute('aria-live', 'polite');
  ui.news.append(content);
  let item = null;
  let request;
  let expanded = false;
  let failed = false;
  // 只在本次使用期间保留阅读位置；正文复用 newsFeed 已有的缓存。
  const bookmarks = new Map();
  let bookmark;
  let frame = 0;
  let previousItems;
  let photo;
  let photoUrl;
  let photoTitle;

  function showPhoto(next) {
    if (photoUrl === next?.image && photoTitle === next?.title) return;
    photo?.remove();
    photo = null;
    photoUrl = next?.image;
    photoTitle = next?.title;
    if (!photoUrl) return;
    const img = document.createElement('img');
    img.className = 'ws-article-photo';
    img.alt = next.title + ' · ' + next.source + '配图';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.hidden = true;
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.remove(); };
    ui.news.insertBefore(img, ui.digest);
    img.src = photoUrl;
    photo = img;
  }

  function showSummary() {
    content.hidden = !item?.summary;
    content.textContent = item?.summary ? '导语 · ' + item.summary : '';
    ui.original.textContent = '阅读原文';
    ui.original.setAttribute('aria-expanded', 'false');
  }
  function rememberPosition() {
    if (bookmark && !frame && !request && ui.scroll.clientHeight) bookmark.top = ui.scroll.scrollTop;
  }
  ui.scroll.addEventListener('scroll', rememberPosition, { passive: true });
  function restorePosition() {
    if (!bookmark.top) { ui.scroll.scrollTop = 0; return; }
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (bookmark) ui.scroll.scrollTop = bookmark.top;
    });
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    request?.abort();
    request = null;
  }
  async function showArticle() {
    expanded = true;
    failed = false;
    const pending = new AbortController();
    request = pending;
    ui.original.textContent = '收起原文';
    ui.original.setAttribute('aria-expanded', 'true');
    content.hidden = false;
    content.textContent = '正在读取来源正文…';
    try {
      const article = await feed.readArticle(item, { signal: pending.signal });
      if (request !== pending) return;
      content.replaceChildren(...article.paragraphs.map(text => {
        const p = document.createElement('p');
        p.textContent = text;
        return p;
      }));
      if (article.truncated) {
        const note = document.createElement('small');
        note.textContent = '本文较长，当前展示前段原文。';
        content.append(note);
      }
      restorePosition();
    } catch {
      if (request !== pending) return;
      failed = true;
      ui.original.textContent = '重试阅读';
      content.textContent = (item.summary ? '导语 · ' + item.summary + '\n\n' : '') + '暂时未读到来源正文。';
    } finally {
      if (request === pending) request = null;
    }
  }
  ui.original.onclick = event => {
    event.preventDefault();
    if (!item) return;
    stop();
    bookmark.top = ui.scroll.scrollTop = 0;
    if (expanded && !failed) {
      bookmark.expanded = expanded = false;
      showSummary();
    } else {
      bookmark.expanded = true;
      return showArticle();
    }
  };
  function select(next, items, context) {
    const same = item?.url === next?.url && (!next || bookmark?.context === context);
    if (!same) rememberPosition();
    showPhoto(next);
    const summaryChanged = item?.summary !== next?.summary;
    if (items !== previousItems || item?.url !== next?.url || summaryChanged) {
      previousItems = items;
      const others = next && !next.summary ? (items || []).filter(row => row.url !== next.url) : [];
      ui.digest.hidden = !others.length;
      ui.headlines.replaceChildren(...others.map(row => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.title;
        button.onclick = () => {
          choose(row);
          ui.title.focus({ preventScroll: true });
        };
        return button;
      }));
    }
    if (same) {
      item = next;
      if (summaryChanged && !expanded) showSummary();
      return;
    }
    stop();
    item = next;
    bookmark = null;
    expanded = failed = false;
    if (!next) {
      ui.original.removeAttribute('href');
      showSummary();
      return;
    }
    const key = JSON.stringify([context, next.url]);
    bookmark = bookmarks.get(key) || { context, top: 0, expanded: false };
    bookmark.item = next;
    bookmarks.delete(key);
    bookmarks.set(key, bookmark);
    if (bookmarks.size > 24) bookmarks.delete(bookmarks.keys().next().value);
    ui.original.href = next.url;
    if (bookmark.expanded) void showArticle();
    else {
      showSummary();
      restorePosition();
    }
  }
  function lastArticle(context) {
    let last;
    for (const entry of bookmarks.values()) if (entry.context === context) last = entry.item;
    return last;
  }
  return { select, lastArticle };
}
