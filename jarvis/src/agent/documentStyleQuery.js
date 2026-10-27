/** 只在文档偏好问答/应用偏好时取写作偏好，不把普通兴趣爱好变成排版要求。 */
export function asksDocumentStyles(text, messages = []) {
  const query = String(text || '').slice(0, 1000);
  if (!/偏好|喜好|习惯|爱好/.test(query)) return false;
  if (/生活爱好|兴趣爱好|业余爱好|饮食|运动|旅游|做菜|唱歌/.test(query)) return false;
  if (/Word|PPT|Excel|文档|写作|排版|字体|字号|文章格式/i.test(query)) return true;
  if (!/制作(?:偏好|喜好|习惯|爱好)/.test(query)) return false;
  // 指代型“制作爱好”最多看最近8条、每条800字，只判断话题，不从聊天臆造偏好。
  return messages.slice(-8).some((message) => /Word|PPT|Excel|文档|排版|字体|字号/i.test(String(message.content || '').slice(0, 800)));
}
