import { describe, it, expect } from 'vitest';
import { answerConstraints, answerConstraintIssues, sourceCandidates } from '../src/agent/answerRequirements.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { runAgent } from '../src/agent/agent.js';

const done = text => ({ text, toolCalls: [], stop: 'end_turn' });
const context = { dynamic: '' };
const tool = (name, output) => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run: async () => output });

describe('明确输出约束，不做粗暴关键词封禁', () => {
  it('不提时间会拦住委婉时间安排，但不把不要编造截止日期当禁止所有时间', () => {
    expect(answerConstraintIssues('只保留一句，不要时间', '时间地点确定后我再告诉你')).toHaveLength(1);
    expect(answerConstraintIssues('只保留一句，不要时间', '想邀请你来交流，期待见面！')).toEqual([]);
    expect(answerConstraints('不要编造截止日期').noTime).toBe(false);
    expect(answerConstraints('解释“不要时间”这句话').noTime).toBe(false);
    expect(answerConstraintIssues('不得出现“限时优惠”', '限时优惠，欢迎咨询')).toHaveLength(1);
  });
  it('今日新闻只检查明确的发布时间，不把历史背景当日期错误', () => {
    const now = Date.parse('2026-10-25T02:00:00Z');
    expect(answerConstraintIssues('今天三条新闻', '**时间：**10月24日19:01（发布）', now)).toHaveLength(1);
    expect(answerConstraintIssues('今天三条新闻', '**时间：**10月25日；回顾10月24日的事件', now)).toEqual([]);
    expect(answerConstraintIssues('今天三条新闻', '事件时间：10月24日，发布时间：10月25日', now)).toEqual([]);
  });
  it('实际流式输出先检查，错误草稿不发出；正确时没有额外审查模型调用', async () => {
    let calls = 0;
    const events = [];
    const adapter = { async stream({ onText }) {
      const text = ++calls === 1 ? '时间地点确定后再告诉你。' : '想邀请你来交流，期待见面！';
      onText(text);
      return done(text);
    } };
    const r = await runAgent({ adapter, model: 'fixture', userText: '改成轻松一点，只保留一句，不要时间', history: [], tools: [], context, quiet: true, emit: e => events.push(e) });
    expect(calls).toBe(2);
    expect(r.text).toBe('想邀请你来交流，期待见面！');
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe(r.text);
    expect(r.review.answerIssues).toEqual([]);
  });
  it('修正次数有上限，持续违反要求也不泄露草稿或假报通过', async () => {
    let calls = 0;
    const adapter = { async stream() { calls++; return done('时间地点稍后通知'); } };
    const r = await runAgent({ adapter, model: 'fixture', userText: '不要时间，只给一句邀约', history: [], tools: [], context, quiet: true, emit() {} });
    expect(calls).toBe(2);
    expect(r.text).not.toContain('时间地点');
    expect(r.review.outcome).toBe('partial');
  });
});

describe('具体来源验收不是搜索次数验收', () => {
  const request = '查询南京市政府信息公开申请渠道，给官网原文链接';
  const url = 'https://www.nanjing.gov.cn/guide.html';
  it('导航页、搜索摘要、聚合回退及假冒gov域名不充当有效候选正文', () => {
    for (const [name, output] of [['fetch_url', url + ' 申请须知、申请表下载'], ['web_search', url + ' 网上申请'], ['fetch_url', '原网页读取失败：以下线索 ' + url + ' 网上申请'], ['fetch_url', 'https://gov.cn.evil.example/x 网上申请']]) {
      expect(sourceCandidates(request, name, output)).toEqual([]);
    }
    expect(sourceCandidates(request, 'fetch_url', url + ' 网上申请、邮寄申请')).toEqual([url]);
    expect(sourceCandidates(request, 'fetch_url', '网上申请、邮寄申请', { url })).toEqual([url]);
    expect(sourceCandidates(request, 'fetch_url', '不受理电子邮件，但可网上申请', { url })).toEqual([url]);
    expect(sourceCandidates(request, 'fetch_url', '只有导航\n【页面内链接（链接指向的内容尚未读取）】\n网上申请 ' + url, { url })).toEqual([]);
  });
  it('必须答出具体方式并引用已获取的链接，不保留网页正文', () => {
    const r = createExecutionReview(request);
    r.record({ name: 'web_search', ok: true, output: url + ' 网上申请' });
    expect(r.checkAnswer('网上申请：' + url)).not.toEqual([]);
    r.record({ name: 'fetch_url', ok: true, output: url + '\n网上申请、邮寄申请。' + '大块正文'.repeat(3000) });
    expect(r.checkAnswer('网上申请：' + url)).toEqual([]);
    expect(r.checkAnswer('网上申请：https://www.nanjing.gov.cn/invented.html')).not.toEqual([]);
    expect(JSON.stringify(r.report())).not.toContain('大块正文');
  });
  it('真实循环查到导航后会继续核对，失败则是部分交付', async () => {
    let calls = 0;
    const adapter = { async stream() {
      calls++;
      if (calls === 1) return { text: '', toolCalls: [{ id: 's', name: 'web_search', args: {} }], stop: 'tool_use' };
      if (calls === 2) return done('找到了申请须知：' + url);
      if (calls === 3) return { text: '', toolCalls: [{ id: 'f', name: 'fetch_url', args: {} }], stop: 'tool_use' };
      return done('可网上申请、邮寄申请。原文：' + url);
    } };
    const r = await runAgent({ adapter, model: 'fixture', userText: request, history: [], tools: [tool('web_search', url + ' 申请须知'), tool('fetch_url', url + ' 网上申请、邮寄申请')], context, quiet: true, emit() {} });
    expect(r.text).toContain('网上申请');
    expect(r.text).not.toContain('找到了申请须知');
    expect(r.review.sourceIssue).toBe('');
    expect(calls).toBe(4);
  });
});
