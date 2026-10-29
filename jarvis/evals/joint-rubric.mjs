/**
 * 30 题联合复测的评分标准、自动评审提示和结果解析。
 * 4 个维度各 1～5 分，每个分数有“长什么样”的样例，评审员和用户按同一把尺子打分，免得每轮标准漂移。
 * 自动评审只看题目、检查点、回答原文和程序读回的文件事实；不给评审员看工具内部日志、密钥或用户其他对话。
 */
export const rubricVersion = 'joint-rubric-v1';

export const DIMENSIONS = {
  onPoint: {
    label: '答到点子上',
    anchors: {
      5: '第一句就回答了用户最想知道的；没问但需要知道的补一句；该问清时先问',
      3: '答了，但要读到中间才找到结论，或绕了弯、夹带无关内容',
      1: '答非所问、只说“我来做”没有结果，或把用户的问题理解错'
    }
  },
  factual: {
    label: '事实对',
    anchors: {
      5: '数字、日期、来源都对得上，没核实的照实标出',
      3: '主体对，个别细节含糊或来源不够原始',
      1: '有错误数字/日期/结论，或编造来源、编造“已完成”'
    }
  },
  natural: {
    label: '表达自然',
    anchors: {
      5: '像靠谱的熟人说话；同一个提醒只说一次；长度合适；语气贴合场景（安慰、决策、交付各不同）',
      3: '能看懂，但有官腔、重复的免责声明或明显偏长',
      1: '机械、说教、反复道歉或复盘，或者中英混杂、乱码'
    }
  },
  deliverable: {
    label: '交付物能用',
    anchors: {
      5: '文件/提醒/代码真的做出来了，读回事实和要求一致，回答里说的和实际一致',
      3: '做出来了，但有一项要求没满足（页数、字号、格式等）且回答照实说了',
      1: '没做出来却说做了，或文件打不开/和要求明显不符；没有交付物的题按回答本身是否可直接用来评'
    }
  }
};

/** 失败主因（每道没过的题标一个）：下一步该修什么一目了然 */
export const FAILURE_REASONS = {
  misunderstood: '没理解需求',
  factual: '事实或计算错',
  tool_failed: '工具失败（搜索、生成、仓库等）',
  timeout: '超时或太慢',
  format: '格式、页数、字号等不符合',
  tone: '语气、结构、重复',
  overclaim: '说做到却没做到',
  environment: '环境未就绪（没连仓库、没配镜像等），不计分'
};

/** 给自动评审员的提示：只评不改，按 JSON 输出 */
export function judgePrompt(item, run) {
  const dims = Object.entries(DIMENSIONS)
    .map(([key, d]) => `- ${key}（${d.label}）：5分=${d.anchors[5]}；3分=${d.anchors[3]}；1分=${d.anchors[1]}`)
    .join('\n');
  const turns = run.turns.map((t, i) => `【第${i + 1}轮用户】${t.prompt}\n【第${i + 1}轮回答】${String(t.answer || '（无回答）').slice(0, 6000)}`).join('\n\n');
  const facts = run.fileFacts ? `\n【程序读回的文件事实（以此为准，回答说的和它不一致就是说做到没做到）】\n${JSON.stringify(run.fileFacts).slice(0, 3000)}` : '';
  const mech = run.mechanical?.failures?.length ? `\n【程序检查发现的问题】${run.mechanical.failures.join('；')}` : '';
  return {
    system: `你是严格、公正的中文评审员。只根据下面给出的题目、检查点、回答原文和程序读回的事实打分，不要脑补没给出的内容。实时信息（天气、新闻、股价、汇率）你无法联网核实时，只看回答是否给了今天的日期、原文链接和自洽的数字，不要因为你不知道今天的数据就判错。
评分维度（每项1～5分，整数，可以给2和4）：
${dims}
失败主因只能从这些里选一个：${Object.keys(FAILURE_REASONS).join(' / ')}。
“overclaim”= 回答声称做了/核实了/加大了，但读回事实或回答本身显示没做到。
只输出一个 JSON 对象，不要任何其他文字：
{"scores":{"onPoint":n,"factual":n,"natural":n,"deliverable":n},"checkpoints":[{"passed":true/false,"evidence":"引用回答原文或读回事实，8到200字"}],"overclaim":true/false,"pass":true/false,"failureReason":"…或null","comment":"一句话总评"}
checkpoints 的数量和顺序必须和题目检查点一一对应。pass 为 true 的前提：所有检查点都过，且四项都不低于3分。`,
    prompt: `【题号】${item.id}（${item.group}）\n【检查点】\n${item.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n${turns}${facts}${mech}`
  };
}

const clampScore = (n) => (Number.isInteger(n) && n >= 1 && n <= 5 ? n : null);
/** 解析评审员输出；格式不对就返回 error，不猜分 */
export function parseJudgement(text, item) {
  const raw = String(text || '').match(/\{[\s\S]*\}/)?.[0];
  let data;
  try { data = JSON.parse(raw); } catch { return { error: '评审输出不是合法 JSON' }; }
  const scores = Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, clampScore(data?.scores?.[k])]));
  if (Object.values(scores).some((v) => v === null)) return { error: '评分缺项或超出1～5' };
  const checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
  if (checkpoints.length !== item.rubric.length || !checkpoints.every((c) => typeof c?.passed === 'boolean' && typeof c?.evidence === 'string' && c.evidence.trim().length >= 4))
    return { error: '检查点数量或格式不对' };
  const failureReason = data.failureReason && FAILURE_REASONS[data.failureReason] ? data.failureReason : null;
  const allPassed = checkpoints.every((c) => c.passed) && Object.values(scores).every((v) => v >= 3);
  return {
    scores,
    total: Object.values(scores).reduce((a, b) => a + b, 0),
    checkpoints: checkpoints.map((c) => ({ passed: c.passed, evidence: c.evidence.slice(0, 400) })),
    overclaim: data.overclaim === true,
    // 评审员说通过但检查点没全过 / 有分数低于 3：以规则为准
    pass: data.pass === true && allPassed,
    failureReason: data.pass === true && allPassed ? null : failureReason || (data.overclaim ? 'overclaim' : null),
    comment: String(data.comment || '').slice(0, 300)
  };
}
