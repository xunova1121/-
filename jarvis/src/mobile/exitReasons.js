/**
 * 系统记下的未央退出原因（安卓 11+，见原生 ExitReasons.mainSince）→ 说人话。
 * 华为等手机的后台管理会把在后台的未央关掉，系统记成“用户关闭”，说明里带 iAware / SystemManager：
 * 这不是闪退，下次打开时接回刚才的对话（见 boot.js、app/recovery.js）。
 */
const SYSTEM = /iAware|SystemManager|powergenie|hwPfw|freeze/i;

/** @returns {{ kind: 'system'|'memory'|'crash'|'update'|'user'|'other', text: string }} */
export function classifyExit({ reason, description = '' } = {}) {
  const why = String(description || '');
  if (/installPackage|replaced|update/i.test(why)) return { kind: 'update', text: '安装新版本（正常）' };
  if (SYSTEM.test(why)) return { kind: 'system', text: '手机系统的后台管理把未央关了（不是闪退）' };
  if (reason === 3) return { kind: 'memory', text: '手机内存不够，系统回收了未央（不是闪退）' };
  if (reason === 4 || reason === 5) return { kind: 'crash', text: '程序崩溃' };
  if (reason === 6) return { kind: 'crash', text: '程序没有响应' };
  if (reason === 10 || reason === 11 || reason === 2) return { kind: 'user', text: '正常关闭' };
  return { kind: 'other', text: `其他原因（代码 ${reason}）` };
}

const fmt = (t) => {
  const d = new Date(Number(t) + 8 * 3600_000); // 北京时间
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

/**
 * @param {Array<{time:number, reason:number, description?:string, pssMB?:number}>} exits
 * @returns {{ lines: string[], killed: boolean }}
 *   lines：值得记下的（正常关闭、安装更新不记）；killed：最近一次是被系统关掉的（6 小时内），该接回刚才的对话
 */
export function summarizeExits(exits = [], now = Date.now()) {
  const rows = [...exits].filter((e) => e && Number(e.time) > 0).sort((a, b) => a.time - b.time);
  const lines = [];
  for (const e of rows) {
    const { kind, text } = classifyExit(e);
    if (kind === 'user' || kind === 'update') continue;
    lines.push(`${fmt(e.time)} ${text}${e.pssMB ? `（当时占内存 ${e.pssMB}MB）` : ''}`);
  }
  const latest = rows.at(-1);
  const kind = latest && classifyExit(latest).kind;
  return { lines, killed: Boolean(latest) && (kind === 'system' || kind === 'memory') && now - latest.time < 6 * 3600_000 };
}

/** 旧版把“系统内存压力”提醒也写进了异常记录：那只是提醒，不是闪退，显示时去掉 */
export const dropMemoryNotes = (text = '') => String(text).split('\n').filter((line) => !/系统内存压力/.test(line)).join('\n').trim();

export const KILLED_TIP = '手机系统在后台把未央关了（不是闪退），已接回刚才的对话。想少被关：手机设置 → 应用和服务 → 应用启动管理 → 未央，关掉“自动管理”，打开允许自启动、关联启动、后台活动。';
