import { refersToWorkshopNews, withWorkshopNews } from '../core/workshopNewsReference.js';

// 新闻只在用户正在看的工作台里可被指代；进入队列时冻结引用，切台、刷新和后台任务都不能改写它。
export function createWorkshopNewsChat(app) {
  let selected = null;
  let draft = null;
  const scope = () => app.messageQueue?.scope();
  const inRoom = () => !document.hidden && Boolean(app.prompt?.closest('.wb-desk:not([hidden]), #mobile-work-studio[open]'));
  const current = (item) => item && item.session === app.session && item.scope === scope() && inRoom();
  // 手机上阅读页的输入栏明确标为「追问这条新闻」，可以直接写问题。
  const readingHere = () => app.prompt?.hasAttribute?.('data-nest-news') === true;
  function clear() {
    selected = null;
    draft = null;
  }
  function select(sessionId, article) {
    if (!sessionId || sessionId !== app.session?.id || !inRoom()) return;
    if (!article?.title || !article.url || !article.source) {
      selected = null;
      return;
    }
    if (current(selected) && selected.article.url === article.url && selected.input === article) return;
    let url;
    try {
      url = new URL(article.url);
    } catch {
      selected = null;
      return;
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      selected = null;
      return;
    }
    const line = (value, length) =>
      String(value || '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, length);
    selected = {
      session: app.session,
      scope: scope(),
      input: article,
      article: {
        title: line(article.title, 240),
        source: line(article.source, 60),
        publishedAt: line(article.publishedAt, 64),
        url: url.href
      }
    };
  }
  function actionTarget(sessionId, article) {
    return current(selected) && sessionId === selected.session.id && selected.article.url === article?.url;
  }
  return {
    inRoom,
    clear,
    select,
    draftChanged(text) {
      if (!text.trim() || (!readingHere() && !refersToWorkshopNews(text))) draft = null;
      else if (!current(draft) && current(selected)) draft = selected;
    },
    bind(text, byVoice = false) {
      const item = !byVoice && current(draft) ? draft : selected;
      if (!byVoice) draft = null;
      return current(item) && (refersToWorkshopNews(text) || (!byVoice && readingHere())) ? withWorkshopNews(text, item.article) : text;
    },
    ask(sessionId, article) {
      if (!actionTarget(sessionId, article)) return;
      const existing = app.prompt.value.trim();
      if (!existing) app.prompt.value = '这条新闻';
      else if (!refersToWorkshopNews(existing)) app.prompt.value = '关于这条新闻，' + existing;
      draft = selected;
      app.autosize();
      app.prompt.focus();
      app.prompt.setSelectionRange(app.prompt.value.length, app.prompt.value.length);
    },
    brief(sessionId, article) {
      if (!actionTarget(sessionId, article)) return;
      const question = '请阅读这条新闻的原文，核实后生成一份可下载的 Word 简报（.docx），注明来源和原文链接。如果读不到原文，请说明能核实的范围。';
      return app.send(withWorkshopNews(question, selected.article), { mode: 'queue', queuedFiles: [] });
    }
  };
}
