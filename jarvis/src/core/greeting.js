/**
 * 你回到电脑前时，未央主动打招呼。
 * 内容来自本机已有的信息：时间、你的称呼（核心记忆）、今天还没到点的定时任务、上次说好以后再做的事、你的使用习惯。
 * 接了大模型时让模型把这些揉成一两句自然的话；没有时用模板。
 */
export const GREET_GAP_MS = 40 * 60_000;

export function timeGreeting(h) {
  return h < 5 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';
}

/** 从核心记忆里找称呼（“用户叫小王”“称呼他为王总”“名字是 Alex”） */
export function nameFrom(coreHuman = '') {
  const m = String(coreHuman).match(/(?:称呼(?:他|她|用户)?为|叫|名字是|姓名[:：]?)\s*[“"「]?([一-龥A-Za-z]{1,8}?)[”"」]?(?=[，。,.;；\s]|$)/);
  return m ? m[1] : '';
}

const fmtAway = (ms) => (ms >= 86400000 ? `${Math.round(ms / 86400000)} 天` : ms >= 3600000 ? `${Math.round(ms / 3600000)} 小时` : `${Math.max(1, Math.round(ms / 60000))} 分钟`);

/**
 * @param {object} o
 * @param {Date} [o.now]
 * @param {number} o.awayMs
 * @param {string} [o.coreHuman]
 * @param {Array<{ title: string, nextRun: number }>} [o.schedules]  今天还要运行的定时任务
 * @param {Array<{ text: string }>} [o.openItems]
 * @param {string[]} [o.habits]  习惯提示（如“这个时间你通常会打开 VS Code”）
 * @param {((p: { system: string, prompt: string }) => Promise<string>) | null} [o.llm]
 * @returns {Promise<{ text: string, facts: string[] }>}
 */
export async function composeGreeting({ now = new Date(), awayMs, coreHuman = '', schedules = [], openItems = [], habits = [], llm = null }) {
  const hello = timeGreeting(now.getHours());
  const name = nameFrom(coreHuman);
  const facts = [];
  const todo = schedules.filter((s) => s.nextRun && new Date(s.nextRun).toDateString() === now.toDateString()).sort((a, b) => a.nextRun - b.nextRun);
  if (todo.length) facts.push(`今天还有 ${todo.length} 个定时任务，下一个是 ${new Date(todo[0].nextRun).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 的「${todo[0].title}」`);
  if (openItems.length) facts.push(`上次说好以后再做：${openItems[0].text}`);
  if (habits.length) facts.push(habits[0]);

  if (llm) {
    try {
      const text = String(await llm({
        system: '你是“未央”，用户电脑上的私人管家式智能体。用户刚回到电脑前。用中文说一到两句话打招呼：自然、简短、像熟悉的管家，可以顺带提一件最值得提的事并主动提出帮忙。不要编造下面没给出的信息。不要输出任何标签或引号。',
        prompt: `现在：${now.toLocaleString('zh-CN', { hour12: false })}（${hello}）\n用户离开了约 ${fmtAway(awayMs)}\n关于用户：${coreHuman || '（未知）'}\n可以提的事：\n${facts.map((f) => `- ${f}`).join('\n') || '（没有）'}`
      })).replace(/<[^>]+>/g, '').replace(/^["“「]|["”」]$/g, '').trim();
      if (text && text.length <= 160) return { text, facts };
    } catch { /* 模型不可用：用模板 */ }
  }
  let text = `${hello}${name ? `，${name}` : ''}。${awayMs >= 3 * 3600000 ? '欢迎回来。' : ''}`;
  if (openItems.length) text += `上次说好的「${openItems[0].text.slice(0, 24)}」，要现在接着做吗？`;
  else if (todo.length) text += `${facts[0]}。`;
  else if (habits.length) text += `${habits[0]}`;
  else text += '有什么需要我做的，随时说。';
  return { text, facts };
}
