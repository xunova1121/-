import { beforeEach, expect, it, vi } from 'vitest';
import { conversationFocus, isResponseRevision } from '../src/core/responseRevision.js';
import { responseGuidance } from '../src/agent/responseGuidance.js';
import { isQuickLookup, withLookupDeadline } from '../src/agent/lookupDeadline.js';
import { effortFor } from '../src/llm/router.js';
import { buildContext, runAgent } from '../src/agent/agent.js';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { communicationScope, communicationPreferenceSupported } from '../src/agent/communicationPreferences.js';
const directive = '请记住：以后解读体检和宠物化验单时，先照顾家属感受，用通俗的话解释，不要冷冰冰罗列指标。';
const history = [
  { role: 'user', content: '帮我解读这份体检报告' },
  { role: 'assistant', content: '这份检查报告有一项需要复查，具体含义要结合原始报告判断。', ts: 1 },
  { role: 'user', content: directive },
  { role: 'assistant', content: '记住了，以后会通俗解释。', ts: 2 }
];
beforeEach(async () => {
  for (const name of ['memories', 'lessons', 'skills', 'episodes']) await collection(name).clear();
  memory.configureMemory({});
});
it('重写定位实质回答而非记忆确认；新任务不继承旧医学话题', () => {
  expect(conversationFocus('重新说', history)).toMatchObject({ revision: true, targetTs: 1, hasTarget: true });
  expect(conversationFocus('一公斤等于多少克', history).memoryQuery).not.toContain('体检');
  expect(conversationFocus('你好', history).memoryQuery).toBe('你好');
  expect(conversationFocus('那推荐个股票板块', history).memoryQuery).not.toContain('体检');
  expect(conversationFocus('重新说', []).hasTarget).toBe(false);
  expect(isResponseRevision('重新说一下')).toBe(true);
  expect(isResponseRevision('重新说，不要再搜索')).toBe(true);
  expect(isResponseRevision('重新说，并生成Word文件')).toBe(false);
  expect(isResponseRevision('重新说，并查一下最新政策')).toBe(false);
});
it('重述不套一分钟查询时限，实际查最新仍受原规则', async () => {
  vi.useFakeTimers();
  try {
    expect(isQuickLookup('重新说')).toBe(false);
    expect(isQuickLookup('现在北京天气')).toBe(true);
    const task = withLookupDeadline({ userText: '重新说', history }, async (o) => {
      expect(o.lookupDeadline).toBeUndefined();
      await new Promise((r) => setTimeout(r, 90_000));
      return '重写完成';
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await task).toBe('重写完成');
  } finally {
    vi.useRealTimers();
  }
});
it('医疗短问与重写不自动降为low，寒暄保留提速且不固定任何模型', () => {
  for (const text of ['糖耐后面是什么', '体检怎么看', '重新说']) expect(effortFor('chat', text, {})).toBeUndefined();
  expect(effortFor('chat', '你好', {})).toBe('low');
});
it('明确表达偏好可确认，咨询、引用或医疗事实不能变成偏好', async () => {
  expect(communicationScope(directive)).toBe('care');
  expect(communicationPreferenceSupported('用户希望体检采用贴心陪诊模式', '请记住：以后体检不需要贴心陪诊，通俗说事实。')).toBe(false);
  expect(communicationPreferenceSupported('用户希望体检先安抚感受', '请记住：以后体检不要安抚，直接通俗解释。')).toBe(false);
  expect(communicationPreferenceSupported('用户希望体检时先照顾感受并通俗解释', directive)).toBe(true);
  expect(communicationPreferenceSupported('用户确诊某种疾病', directive)).toBe(false);
  expect(communicationScope('引用示例：' + directive)).toBeNull();
  const remember = createTools({}).find((t) => t.name === 'remember');
  await remember.run({ content: '用户希望体检时先照顾感受并通俗解释', category: 'preference' }, { requestText: directive });
  expect((await memory.listAll()).memories[0].pending).toBe(false);
  expect((await memory.contextFor('体检')).memories.some((m) => m.content.includes('照顾感受'))).toBe(true);
});
it('真实remember教训回执后短追问/light仍取用；换话题、删除不误用', async () => {
  const tool = createTools({}).find((t) => t.name === 'remember');
  await tool.run({ content: '以后体检解读先照顾感受、通俗解释', category: 'lesson' }, { requestText: directive });
  for (const light of [false, true]) expect((await buildContext('重新说', { history, light })).dynamic).toContain('以后体检解读先照顾感受');
  expect((await memory.contextFor('股票买卖')).lessons).toEqual([]);
  await collection('lessons').clear();
  expect((await buildContext('重新说', { history, light: true })).dynamic).not.toContain('以后体检解读先照顾感受');
});
it('同范围最新纠正优先，旧偏好不复活', async () => {
  const old = await memory.addLesson('以后体检解读先安抚感受', directive);
  await collection('lessons').put({ ...old, ts: 1 });
  const recent = await memory.addLesson('以后体检只通俗说明，不要安慰', '请记住：以后体检只通俗解释，不要安慰。');
  await collection('lessons').put({ ...recent, ts: 2 });
  const ctx = await memory.contextFor('体检');
  expect(ctx.lessons.map((l) => l.id)).toEqual([recent.id]);
});
it('真实主循环重述不带联网工具、不额外审查调用，保留原可见报告', async () => {
  let calls = 0;
  const adapter = {
    async stream(o) {
      calls++;
      expect(o.allowWebSearch).toBe(false);
      expect(o.tools.some((t) => t.name === 'web_search')).toBe(false);
      expect(o.system.join('\n')).toContain('不是重写“记住了”的回执');
      expect(o.messages.some((m) => m.content?.includes('需要复查'))).toBe(true);
      o.onText('我先把重点讲清楚。');
      return { text: '我先把重点讲清楚。', toolCalls: [], stop: 'end_turn' };
    }
  };
  const result = await runAgent({
    adapter,
    model: 'configured-model',
    history,
    userText: '重新说',
    tools: [
      {
        name: 'web_search',
        description: '查资料',
        input_schema: { type: 'object' },
        run: async () => {
          throw new Error('不该检索');
        }
      }
    ],
    context: { dynamic: '当前资料', kbHits: [] },
    emit: () => {},
    quiet: true
  });
  expect(result.text).toBe('我先把重点讲清楚。');
  expect(calls).toBe(1);
});
it('共情引导有边界，不提供未核实医学保证；闲聊不套方案目录', () => {
  expect(responseGuidance('糖耐后面是什么', history)).toContain('不能仅因指标有记录就判正常');
  expect(responseGuidance('我有点累', [])).toContain('允许用户只想被倾听');
  expect(responseGuidance('你好', [], { light: true })).not.toContain('核心判断');
  expect(responseGuidance('重新说', [])).toContain('找不到就简短说明');
});
it('只说看下小宝的图片请求也能有条件取用偏好，不凭称呼推断孕期', async () => {
  await memory.addLesson('以后体检通俗解释，不要安慰', '请记住：以后体检通俗解释，不要安慰。');
  let calls = 0;
  const adapter = {
    async stream(o) {
      calls++;
      expect(o.system.join('\n')).toContain('不能因称呼小宝就推断孕期');
      expect(o.system.join('\n')).toContain('[仅家人/宠物检查报告]');
      expect(o.system.join('\n')).toContain('不要安慰');
      o.onText('我先看看图里能确定的信息。');
      return { text: '我先看看图里能确定的信息。', toolCalls: [], stop: 'end_turn' };
    }
  };
  await runAgent({
    adapter,
    model: 'gpt-4o',
    userText: '看下小宝',
    images: [{ mime: 'image/png', data: 'AA==' }],
    history: [],
    context: { dynamic: '当前资料', kbHits: [] },
    tools: [],
    emit: () => {},
    quiet: true
  });
  expect(calls).toBe(1);
});
it('跨偏好和教训只使用最新表达要求，身份名字不能被当表达指令', async () => {
  const old = await memory.remember('用户希望体检先安抚感受', 'preference', { source: '用户明确指令经工具记录', evidence: directive });
  await collection('memories').put({ ...old, updatedAt: 1, ts: 1 });
  const recent = await memory.addLesson('以后体检通俗解释，不要安慰', '请记住：以后体检通俗解释，不要安慰。');
  await collection('lessons').put({ ...recent, ts: 2 });
  const result = await memory.contextFor('体检');
  expect(result.memories.some((m) => m.id === old.id)).toBe(false);
  expect(result.lessons.map((l) => l.id)).toContain(recent.id);
  await memory.remember('用户叫温柔', 'profile', { source: '用户明确指令经工具记录', evidence: '请记住我的名字叫温柔' });
  expect(await memory.communicationImageContext()).not.toContain('用户叫温柔');
  await memory.deleteItem('lessons', recent.id);
  expect((await memory.listAll()).lessons.some((l) => l.id === recent.id)).toBe(false);
});
it('表达：说中文白话、限制只说一次；宠物化验单也按陪诊结构解读', async () => {
  const { STABLE_PROMPT } = await import('../src/agent/agent.js');
  const { dialoguePolicy } = await import('../src/agent/dialoguePolicy.js');
  expect(STABLE_PROMPT).toContain('像靠谱的熟人说话');
  expect(STABLE_PROMPT).toContain('不写成公文腔');
  expect(responseGuidance('你好', [], { light: true })).toContain('不夹英文单词');
  for (const text of ['帮我看下这份产检报告', '我家猫的血常规报告怎么看', '狗狗化验单']) expect(responseGuidance(text, [])).toContain('开头一两句说整体情况');
  expect(responseGuidance('今天天气怎么样', [])).not.toContain('开头一两句说整体情况');
  expect(dialoguePolicy('产检报告怎么看')).toContain('集中说一次');
});
