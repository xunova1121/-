/**
 * 干活时用户又发来一句话：问进度的直接答（不打扰正在干的模型），说停的停下，其余交给正在干的未央。
 */
export const STATUS_ASK = /^(好了吗|好了没|好没好|好了没有|进度|进度呢|进度如何|怎么样了|做完了吗|做好了吗|弄好了吗|还要多久|要多久|还没好吗|在吗|还在吗|搞定了吗|完成了吗)[\s？?。!！~～呀啊吧呢]*$/;
export const STOP_ASK = /^(停|停下|停止|先停|先停下|别做了|先别做了|不用做了|不要做了|不做了|取消|算了|stop)[\s。!！]*$/i;

/** 正在干的事：用了多久、第几步、在做什么 */
export function turnStatus(turn, now = Date.now()) {
  const secs = Math.max(1, Math.round((now - turn.t0) / 1000));
  const used = secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
  return `还在做，已经 ${used}${turn.steps ? `、第 ${turn.steps} 步` : ''}${turn.status ? `，现在在${String(turn.status).replace(/…$/, '')}` : ''}`;
}
