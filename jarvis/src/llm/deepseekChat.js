export function datedMessages(messages, at = new Date()) {
  if (messages.at(-1)?.role !== 'user') return messages;
  const format = (locale, options) => new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Shanghai', ...options }).format(at);
  const date = format('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = format('zh-CN', { weekday: 'long' });
  const platform = globalThis.Capacitor?.isNativePlatform?.() || globalThis.window?.jarvisDesktop ? 'App' : 'Web';
  return [...messages.slice(0, -1), { role: 'latest_reminder', content: [date, weekday, '', platform, '中文'].join(',') }, messages.at(-1)];
}
export function applySuggestedTitle(session, value) {
  if (!session || session.titleSet || typeof value !== 'string' || session.messages?.filter(m => m.role === 'user').length !== 1) return false;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
  if (!title) return false;
  session.title = title;
  session.titleSet = true;
  return true;
}
