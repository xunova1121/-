/**
 * 干活时用户又发来一句话：问进度的直接答（不打扰正在干的模型），说停的停下，其余交给正在干的未央。
 */
export const STATUS_ASK = /^(好了吗|好了没|好没好|好了没有|进度|进度呢|进度如何|怎么样了|做完了吗|做好了吗|弄好了吗|还要多久|要多久|还没好吗|在吗|还在吗|搞定了吗|完成了吗)[\s？?。!！~～呀啊吧呢]*$/;
export const STOP_ASK = /^(停|停下|停止|先停|先停下|别做了|先别做了|不用做了|不要做了|不做了|取消|算了|stop)[\s。!！]*$/i;

/**
 * 干活时发来的话是不是“另一件事”（用户 2026-10-30：干活时再发信息，是补充还是打乱？）：
 * 开头明说是别的事（另外 / 还有件事 / 换个话题 / 顺便问一下 / 跟这个无关……），又没指着手上的活儿（这份 / 上面 / 也改……），
 * 就排到手上这件做完后单独做，不混进正在做的任务；其余都当补充或修改交给正在干的未央。
 */
const SEPARATE_START = /^(?:另外|另一件事|还有(?:一|个)?件?事|还有个问题|再问(?:一|个)?(?:个|下)?(?:问题|事)?|换个话题|新问题|题外话|顺便问(?:一下|下|个)?|对了[，,]?(?:问(?:一下|下|个)|帮我查)|(?:跟|和)(?:这个|这件事|刚才的?)(?:没关系|无关))/;
const REFERS_CURRENT = /这份|这个文档|这张|这页|上面|刚才那|刚才的(?:文|表|图|稿)|里面|也(?:加|改|换|要|放)|一起(?:改|加|做)/;
export const separateRequest = (text) => {
  const t = String(text || '').trim();
  return t.length >= 4 && SEPARATE_START.test(t) && !REFERS_CURRENT.test(t);
};

/** 正在干的事：用了多久、第几步、在做什么 */
export function turnStatus(turn, now = Date.now()) {
  const secs = Math.max(1, Math.round((now - turn.t0) / 1000));
  const used = secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
  return `还在做，已经 ${used}${turn.steps ? `、第 ${turn.steps} 步` : ''}${turn.status ? `，现在在${String(turn.status).replace(/…$/, '')}` : ''}`;
}
