import { describe, it, expect } from 'vitest';
import { classifyTask } from '../src/llm/router.js';
import { resolveTaskIntent, taskStateFromMessages } from '../src/core/taskIntent.js';
import { codeTaskPolicy } from '../server/codeTaskPolicy.mjs';
import { withLookupDeadline } from '../src/agent/lookup/turn.js';
import { runAgent } from '../src/agent/agent.js';

const animation = '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试';
const message = (content, ts = 1) => ({ role: 'user', content, ts });
describe('成本优化：原话分类和任务续做', () => {
  it.each(['print(1+1)', 'function add(a,b){return a+b;}', animation, '你在这儿文件里面做一个电商项目'])('%s 识别为编程', text => {
    expect(classifyTask(text)).toBe('code');
  });
  it.each(['为什么这个API扣费了？', 'OpenRouter API 是什么', '接口收费多少'])('%s 不误用代码模型', text => {
    expect(classifyTask(text)).toBe('chat');
  });
  it('连续重做、继续继承原任务，不继承超时提示，也不把起名续问变成代码', () => {
    const history = [message(animation), { role: 'assistant', content: '做好了', ts: 2 }, message('重新做', 3), { role: 'assistant', content: '查询超时', ts: 4 }];
    for (const text of ['重新做', '继续', '改一下']) {
      const intent = resolveTaskIntent(text, { history });
      expect(intent).toMatchObject({ category: 'code', inherited: true, modelTask: 'code' });
      expect(intent.requirementText).toContain('不需要任何测试');
      expect(codeTaskPolicy({ text, taskIntent: intent, hasRepos: true, hasWorkspaces: true }).kind).toBe('code');
    }
    const naming = resolveTaskIntent('还有那', { history: [...history, message('给我起几个男孩名字', 5)] });
    expect(naming.category).not.toBe('code');
    expect(naming.requirementText).toContain('男孩名字');
  });
  it('换话题、取消、只问进度不恢复写文件，状态不会跨会话继承', () => {
    const state = taskStateFromMessages([message(animation)]);
    expect(resolveTaskIntent('继续查天气', { state }).category).toBe('work');
    expect(resolveTaskIntent('进度', { state })).toMatchObject({ category: 'chat', statusOnly: true });
    expect(resolveTaskIntent('继续', { state, history: [message('先不做了', 2)] }).inherited).toBe(false);
    expect(resolveTaskIntent('继续').category).toBe('chat');
    expect(state.goal).toBe(animation);
  });
  it('开发和续做不进入查询硬截止，原普通查询仍受限', async () => {
    const history = [message(animation), message('重新做', 3)];
    for (const text of ['重新做', '继续', '你在这儿文件里面做一个电商项目']) {
      let options;
      await withLookupDeadline({ userText: text, history, emit: () => {} }, async o => { options = o; return { text: '已处理' }; }, { totalMs: 1 });
      expect(options.lookupDeadline).not.toBe(true);
    }
    let options;
    await withLookupDeadline({ userText: '今天新闻', history: [], emit: () => {} }, async o => { options = o; return { text: '新闻' }; });
    expect(options.lookupDeadline).toBe(true);
  });
  it('同为工作也区分新领域；保存后的继续与即时分类一致', () => {
    const history = [message('写一份项目报告'), message('继续查天气', 2)];
    expect(resolveTaskIntent('继续查天气', { history: history.slice(0, 1) })).toMatchObject({ inherited: false, goal: '继续查天气' });
    const state = taskStateFromMessages(history);
    expect(resolveTaskIntent('继续', { state })).toMatchObject({ goal: '继续查天气', inherited: true, category: 'work' });
    const codeThenNews = taskStateFromMessages([message(animation), message('继续查日本新闻', 2)]);
    expect(resolveTaskIntent('继续', { state: codeThenNews }).requirementText).not.toContain('HTML');
  });
  it('查询续接保持查询期限，同时保留本轮补充要求', async () => {
    let received;
    await withLookupDeadline({ userText: '改成只要三条', history: [message('今天新闻')] }, async options => { received = options; return { text: '测试' }; });
    expect(received.lookupDeadline).toBe(true);
    expect(received.requirementText).toContain('今天新闻');
    expect(received.requirementText).toContain('只要三条');
  });
  it('真实主循环把原目标和最后约束交给同一模型，不新增分类调用', async () => {
    let requests = 0, input;
    const adapter = { stream: async options => { requests++; input = options; return { text: '当前没有文件工具，不能声称已经重做。', toolCalls: [], stop: 'end_turn' }; } };
    await runAgent({ adapter, model: 'configured-light', history: [message(animation), message('重新做', 3)], userText: '继续', tools: [], emit: () => {}, context: { dynamic: '' } });
    expect(requests).toBe(1);
    expect(JSON.stringify(input)).toContain('不需要任何测试');
    expect(input.model).toBe('configured-light');
  });
});
