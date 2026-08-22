/**
 * 正在跑的活儿 —— 谁在跑、跑到哪了、能不能叫停。
 *
 * ════════ 为什么需要它 ════════
 *
 * 以前没有任何地方记着"这个项目正在跑"，于是有两件事做不到：
 *
 * ① **停不下来。** 点了「全跑」之后就只能等。二十镜的片子跑到第三镜
 *    发现分镜写错了，剩下十七镜照样会一镜一镜烧下去。
 *    关掉页面也没用 —— 流断了，后台那个循环还在跑（这一点尤其反直觉）。
 *
 * ② **能同时跑两遍。** 连点两下「全跑」就是两条流水线，
 *    抢同一批文件、抢同一个项目文件，谁后写谁赢。表现是"有几镜莫名其妙
 *    变回了旧的"，而这种错几乎不可能靠看日志查出来。
 *
 * 一个登记表同时解决这两件。
 *
 * ════════ "取消"到底取消什么 ════════
 *
 * 这是这个模块唯一需要想清楚的事，而它关系到**钱**。
 *
 * 一次出图/出视频的调用一旦发出去，厂商那边就开始算钱了。所以：
 *
 *   · 已经发出去的那一镜  —— **让它跑完并存下来**。钱已经花了，
 *                            半路掐掉只会让你既花了钱又什么都没拿到。
 *   · 还没开始的那些      —— 一个都不发。这才是取消真正省下来的部分。
 *   · 正在轮询的视频任务  —— 停止轮询，但把 task_id 记进「待认领」。
 *                            那个任务在厂商那边照样会跑完，
 *                            回头能把片子收回来 —— 别让花掉的钱打水漂。
 *
 * 所以取消是"**停在下一个安全点**"，不是"立刻掐断"。
 * 界面上必须这么说，不能只写一个「取消」就完事 ——
 * 用户点完发现还在跑一镜，会以为按钮坏了。
 */

/** projectId -> job */
const RUNNING = new Map();

function now() {
  return Date.now();
}

/**
 * 开一份活儿。同一个项目已经在跑就直接拒绝 ——
 * 让它排队更糟：用户点了两下，看到的是"跑完了又跑一遍"，
 * 而他要的显然只是跑一遍。
 */
export function start(projectId, stage) {
  const existing = RUNNING.get(projectId);
  if (existing) {
    const secs = Math.round((now() - existing.startedAt) / 1000);
    const err = new Error(
      `这个项目已经在跑「${existing.stageLabel || existing.stage}」了（${secs} 秒前开始）。` +
        '要么等它跑完，要么先点「停下来」。' +
        '同时跑两遍会让两条流水线抢同一批文件，结果是有几镜莫名其妙变回旧的。'
    );
    err.code = 'BUSY';
    throw err;
  }

  const controller = new AbortController();
  const job = {
    projectId,
    stage,
    stageLabel: STAGE_LABELS[stage] || stage,
    startedAt: now(),
    cancelledAt: null,
    controller,
    signal: controller.signal,
    // 最近一条进度，给"刷新页面之后还能看到它在干嘛"用
    note: '',
    /**
     * 手上正在跑的是**哪一镜**。
     *
     * 光有 note 是不够的：手机切屏回来一刷新，流早就断了，
     * 页面上只剩一句"运行中"，而人真正想知道的是"跑到第几镜了、卡住没有"。
     * 有了它，分镜页能把那一镜点亮，流水线上能写"第 5 / 12 镜"。
     */
    shotIndex: null,
    shotId: null
  };
  RUNNING.set(projectId, job);
  return job;
}

/** 收工。只收自己那一份 —— 拿别人的 job 来收会误删掉后开的那一份 */
export function finish(job) {
  if (job && RUNNING.get(job.projectId) === job) RUNNING.delete(job.projectId);
}

export function current(projectId) {
  return RUNNING.get(projectId) || null;
}

/**
 * 叫停。回一句人话说明接下来会发生什么 ——
 * 只回 `{ok:true}` 的话，用户看着它又跑了一镜会以为没生效。
 */
export function cancel(projectId) {
  const job = RUNNING.get(projectId);
  if (!job) return { cancelled: false, message: '这个项目现在没有在跑的任务' };
  if (job.cancelledAt) {
    return { cancelled: true, message: '已经在停了 —— 手上这一镜跑完就停，别再点了' };
  }
  job.cancelledAt = now();
  job.controller.abort();
  return {
    cancelled: true,
    message:
      '收到，正在停：**手上这一镜会跑完并存下来**（钱已经花了，半路掐掉等于白花），' +
      '后面还没开始的一镜都不发。' +
      '要是正卡在视频轮询上，任务号会记进「待认领」，片子回头能收回来。'
  };
}

/** 界面上要显示的那一份（AbortController 不能 JSON 化，挑着回） */
export function describe(projectId) {
  const job = RUNNING.get(projectId);
  if (!job) return { running: false };
  return {
    running: true,
    stage: job.stage,
    stageLabel: job.stageLabel,
    startedAt: job.startedAt,
    elapsedMs: now() - job.startedAt,
    cancelling: Boolean(job.cancelledAt),
    note: job.note,
    shotIndex: job.shotIndex,
    shotId: job.shotId
  };
}

/**
 * 到安全点了 —— 该停就停。
 *
 * 每个循环在**开始下一个单位之前**调它。抛出去而不是回 false，
 * 是因为回 false 要求每个调用点都记得判断，而漏掉一处的后果
 * （取消了却还在烧钱）比多写一个 try 严重得多。
 */
export function checkpoint(signal, what = '') {
  if (!signal?.aborted) return;
  const err = new Error(`已按你的要求停下${what ? `（${what}没有开始，不计费）` : ''}`);
  err.code = 'CANCELLED';
  throw err;
}

export function isCancel(err) {
  return err?.code === 'CANCELLED';
}

/** 只给自检用 */
export function __reset() {
  RUNNING.clear();
}

const STAGE_LABELS = {
  bible: '设定集',
  script: '拆分镜',
  assets: '出图',
  video: '出视频',
  voice: '配音',
  compose: '合成',
  all: '全流程'
};
