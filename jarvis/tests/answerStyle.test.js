import { describe, it, expect } from 'vitest';
import { answerStyle, LIGHT_MODEL } from '../src/agent/answerStyle.js';
import { responseGuidance } from '../src/agent/responseGuidance.js';
import { failedStep, recentFailures, FAILED_STEP_CHARS } from '../src/agent/failedSteps.js';
import { answerConstraintIssues, deferralCount } from '../src/agent/answerRequirements.js';
import { buildContext, runAgent } from '../src/agent/agent.js';
import * as sessions from '../src/agent/sessions.js';

// 用户 2026-10-29：“先说什么、中间说什么、最后说什么”“不同问题和场景下的语气”
describe('按场景定语气和先后顺序', () => {
  it('失败追问、纠正、出主意、钱和法律、交文件、查资料、闲聊各用各的', () => {
    expect(answerStyle('你咋失败了').scene).toBe('failure');
    expect(answerStyle('为啥做不下去').note).toMatch(/先一句话说失败原因.*报错原话/);
    expect(answerStyle('不对，你算错了').scene).toBe('correction');
    expect(answerStyle('这两款手机哪个好').note).toMatch(/先说你推荐什么/);
    expect(answerStyle('我的持仓现在盈亏多少').scene).toBe('money');
    expect(answerStyle('帮我写一份周报').note).toMatch(/先说做好了没有、文件在哪/);
    expect(answerStyle('今天南京天气').note).toMatch(/先直接给答案/);
    expect(answerStyle('你好', { light: true }).note).toMatch(/轻松、简短/);
    expect(answerStyle('随便聊聊').note).toMatch(/先说用户最想知道的那句话/);
  });

  it('健康报告、情绪安慰不套这里的顺序（陪诊和倾听各有规则）；健康报告“找医生”只说一次', () => {
    expect(answerStyle('看下产检报告', { care: true }).scene).toBe('care');
    expect(answerStyle('我好累', { feeling: true }).note).not.toMatch(/回答顺序/);
    const care = responseGuidance('帮我看看这份产检报告', []);
    expect(care).toContain('开头一两句说整体情况');
    expect(care).toContain('只在下一步里说一次');
    expect(care).not.toMatch(/回答顺序：先说用户最想知道/);
  });

  it('轻量模型：复杂任务做不好时主动说；主力模型不加这句', () => {
    expect(LIGHT_MODEL.test('gpt-6-luna')).toBe(true);
    expect(responseGuidance('画架构图', [], { model: 'gpt-6-luna' })).toContain('是轻量模型');
    expect(responseGuidance('画架构图', [], { model: 'gpt-6.1-sol' })).not.toContain('轻量模型');
  });
});

describe('失败的步骤随回答保存，下一轮问“为啥失败”时看得到', () => {
  it('记工具名和报错原话（截短），只取最近一条带失败的回答', () => {
    const step = failedStep({ name: 'create_diagram', output: '分栏层需2～4个节点'.repeat(30) });
    expect(step.tool).toBe('create_diagram');
    expect(step.error.length).toBe(FAILED_STEP_CHARS);
    const history = [
      { role: 'user', content: '做个架构图' },
      { role: 'assistant', content: '没做成', failures: [{ tool: 'create_diagram', error: '通栏只支持内容标题和说明' }] },
      { role: 'user', content: '你咋失败了' }
    ];
    expect(recentFailures(history)).toMatch(/上一轮失败的步骤[\s\S]*create_diagram：通栏只支持内容标题和说明/);
    expect(recentFailures([...history, { role: 'assistant', content: '好' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }])).toBe('');
  });

  it('buildContext 从会话记录里带出上一轮的报错', async () => {
    const s = sessions.create();
    s.messages.push({ role: 'user', content: '做个架构图', ts: 1 }, { role: 'assistant', content: '没做成', ts: 2, failures: [{ tool: 'create_diagram', error: '应用集成须通过已审架构底稿投影' }] });
    await sessions.save(s);
    const ctx = await buildContext('你咋失败了', { sessionId: s.id, turns: 2 });
    expect(ctx.dynamic).toContain('create_diagram：应用集成须通过已审架构底稿投影');
  });
});

describe('健康回答里“找医生”说太多遍：自动重写一次', () => {
  const repetitive = '这份报告显示心脏结构未见明显异常，提示三尖瓣轻度反流。建议把报告交给产科医生评估是否需要复查。三尖瓣位于右心房和右心室之间，请让产科医生结合完整影像判断。具体随访安排以医生评估为准。';
  const good = '先别太担心，整体是让人放心的：宝宝大小和孕周对得上，心脏结构正常。唯一要留意的是三尖瓣轻度反流，像一扇小门关上时漏了一点点。下一步：产检时把报告给产科医生看，问要不要复查心超。';
  it('数得出转介话术；三次及以上才算问题，示范写法不算', () => {
    expect(deferralCount(repetitive)).toBe(3);
    expect(answerConstraintIssues('帮我看看这份产检报告', repetitive).join()).toMatch(/出现了3次/);
    expect(answerConstraintIssues('帮我看看这份产检报告', good)).toEqual([]);
    expect(answerConstraintIssues('今天天气', '建议问医生。请医生看。以医生为准。')).toEqual([]);
  });

  it('runAgent：第一稿重复三遍被拦下重写，用户只看到重写后的', async () => {
    let calls = 0;
    const shown = [];
    const adapter = { async stream({ onText }) { calls++; const text = calls === 1 ? repetitive : good; onText?.(text); return { text, toolCalls: [], stop: 'end_turn' }; } };
    const r = await runAgent({ adapter, model: 'x', history: [], userText: '帮我看看这份产检报告，三尖瓣轻度反流要紧吗', context: { dynamic: '' }, tools: [], emit: (e) => e.type === 'text' && shown.push(e.delta) });
    expect(calls).toBe(2);
    expect(r.text).toContain('先别太担心');
    expect(shown.join('')).not.toContain('以医生评估为准');
  });
});

describe('替用户在外面办事：先说清办不了（第一轮 30 题：“帮我订高铁票”直接问出发地）', () => {
  it('“帮我订 / 给我付 / 订一张”算这一类；问信息的不算', async () => {
    const { answerStyle } = await import('../src/agent/answerStyle.js');
    expect(answerStyle('帮我订明天上午去上海的高铁票。').scene).toBe('boundary');
    expect(answerStyle('帮我付一下电费').scene).toBe('boundary');
    expect(answerStyle('订一张明天去北京的机票').scene).toBe('boundary');
    expect(answerStyle('买票去哪买').scene).not.toBe('boundary');
    expect(answerStyle('帮我写个方案。').scene).not.toBe('boundary');
    expect(answerStyle('帮我订明天上午去上海的高铁票。').note).toMatch(/第一句就说清/);
  });
});
