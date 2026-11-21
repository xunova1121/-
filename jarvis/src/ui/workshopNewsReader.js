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
    ui.scroll.scrollTop = 0;
    content.hidden = !item?.summary;
    content.textContent = item?.summary ? '导语 · ' + item.summary : '';
    ui.original.textContent = '阅读原文';
    ui.original.setAttribute('aria-expanded', 'false');
  }
  function reset() {
    request?.abort();
    request = null;
    expanded = failed = false;
    showSummary();
  }
  ui.original.onclick = async event => {
    event.preventDefault();
    if (!item) return;
    if (expanded && !failed) { reset(); return; }
    expanded = true;
    ui.scroll.scrollTop = 0;
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
    } catch {
      if (request !== pending) return;
      failed = true;
      ui.original.textContent = '重试阅读';
      content.textContent = (item.summary ? '导语 · ' + item.summary + '\n\n' : '') + '暂时未读到来源正文。';
    } finally {
      if (request === pending) request = null;
    }
  };
  return function select(next, items) {
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
    if (item?.url === next?.url) {
      item = next;
      if (summaryChanged && !expanded) showSummary();
      return;
    }
    item = next;
    reset();
    if (next) ui.original.href = next.url;
    else ui.original.removeAttribute('href');
  };
}
