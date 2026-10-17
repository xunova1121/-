/**
 * 手机：正在做的任务记一份在本机。App 被划掉、被系统杀掉时任务会断，
 * 下次打开时据此回到那个对话、带着“已经做过哪些步骤”接着做，不从头再来。
 * 正常做完、出错、用户叫停都会清掉记录。
 */
const KEY = 'jarvis.pendingTasks.v1';
/** 超过这个时间的记录不再自动接着做（隔太久用户多半不需要了） */
export const PENDING_MAX_AGE = 2 * 3600_000;

function read(storage) {
  try { return JSON.parse(storage?.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function write(storage, all) {
  try { Object.keys(all).length ? storage?.setItem(KEY, JSON.stringify(all)) : storage?.removeItem(KEY); } catch { /* 存不了就算了 */ }
}

/** 开始或更新一条记录：{ text, title, ts, steps: ['读取文件 a.pdf', …], files: ['a.docx'] } */
export function savePending(storage, sessionId, rec) {
  if (!sessionId) return;
  const all = read(storage);
  all[sessionId] = { ...all[sessionId], ...rec, steps: (rec.steps ?? all[sessionId]?.steps ?? []).slice(-20), files: (rec.files ?? all[sessionId]?.files ?? []).slice(-12) };
  write(storage, all);
}

/** 清掉记录；给了 turnId 时只清这一轮自己的（同一个对话里新一轮已经开始的不动） */
export function clearPending(storage, sessionId, turnId) {
  const all = read(storage);
  if (!(sessionId in all) || (turnId !== undefined && all[sessionId].turnId !== turnId)) return;
  delete all[sessionId];
  write(storage, all);
}

/** 取出并清掉所有记录；返回还没过期的那条最新的（没有返回 null） */
export function takePending(storage, now = Date.now()) {
  const all = read(storage);
  write(storage, {});
  const list = Object.entries(all).map(([sessionId, r]) => ({ sessionId, ...r })).filter((r) => r.ts && now - r.ts < PENDING_MAX_AGE);
  return list.sort((a, b) => b.ts - a.ts)[0] ?? null;
}

/** 接着做时发给未央的话：说清楚是 App 被关掉打断的，已经做过什么、生成了哪些文件 */
export function resumeText(rec) {
  const done = rec.steps?.length ? `\n已经做过的步骤：${rec.steps.join('；')}` : '';
  const files = rec.files?.length ? `\n已经生成的文件：${rec.files.join('、')}（先检查这些文件在不在、内容对不对，对的就不要重做）` : '';
  return `（上次 App 被关掉，任务做到一半断了）继续把刚才的任务做完：${String(rec.text || '').slice(0, 200)}${done}${files}`;
}
