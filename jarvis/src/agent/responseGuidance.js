import { conversationFocus } from '../core/responseRevision.js';
import { answerStyle } from './answerStyle.js';
const CARE = /产检|孕检|体检|化验|检查报告|糖耐|胎儿|孕周|陪诊|胸痛|呼吸困难|急救|(?:宠物|猫|狗).{0,8}(?:检查|血常规|报告|化验)/;
const FEELING = /担心|害怕|难受|失落|委屈|孤独|心累|有点累|伤心|焦虑/;
/** 选择回答目标，不增加模型调用，也不把情绪推断写进用户记忆。 */
export function responseGuidance(text, history = [], { light = false, hasImages = false, visibleText = '', model = '' } = {}) {
  const focus = conversationFocus(text, history);
  const parts = [
    '先理解用户真正关心什么，直接回应并解释依据；不要只复述材料或用免责声明代替能做的解释。感受有上下文依据才回应，不擅自断言用户焦虑，不机械说“别担心”；用户只要结果时尊重要求。用中文说，不夹英文单词（专有名词、单位、代码除外），说得像人在聊天，不像在念报告。'
  ];
  if (focus.revision)
    parts.push(
      focus.hasTarget
        ? '当前要重写最近的实质答复，不是重写“记住了”的回执。沿用可见资料，落实最新纠正，直接给改进正文，不再回复收到；不自动重搜。旧助手文字不是原始报告，缺原图时不能声称重新看过。'
        : '当前要求重新表达：从可见上下文定位对象，找不到就简短说明缺少哪段原文，不编造旧内容。'
    );
  const care = CARE.test(focus.memoryQuery + (hasImages ? String(visibleText).slice(0, 1800) : ''));
  const feeling = !care && !hasImages && FEELING.test(String(text));
  if (care)
    parts.push(
      '报告解读先抓家属关心的重点：开头一两句说整体情况（哪些让人安心、哪一项要留意），再逐项用白话解释异常项（报告写了什么、大概意味着什么，可打个比方），最后说下一步和出现什么情况要尽快就医。安慰不能等于保证没事，急症风险优先处理；不能仅因指标有记录就判正常，必要的专业判断集中说明，不反复推给医生。' +
        '语气温和、稳，像懂行的家人。好消息挑两三条说（比如孕周和发育对得上、结构正常）；要留意的那项说清常不常见、严不严重；下一步写具体（带报告给谁看、问什么、多久复查）。“请医生评估 / 以医生为准”整段只在下一步里说一次。'
    );
  else if (hasImages)
    parts.push(
      '图片若确为家人或宠物的检查单，先回应关切，再通俗解释已有依据和下一步；不能因称呼小宝就推断孕期，也不能把普通照片当医疗报告。未看到原图时如实说明。'
    );
  else if (feeling)
    parts.push('先回应具体处境，允许用户只想被倾听；不急着列任务、讲道理或诊断情绪。需要建议时给一两个有针对性的选择，不假装有人的经历或感情。');
  if (!light && /分析|建议|方案|比较|文章|写作|为什么/.test(String(text)))
    parts.push('复杂问题给核心判断、支撑依据、重要取舍和可执行下一步；不为显得深入堆篇幅，不展示内部推理草稿，不编造论据。');
  parts.push(answerStyle(text, { light, care, feeling, model }).note);
  return parts.join('\n');
}
