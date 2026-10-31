import { it, expect } from 'vitest';
import { taskContract } from '../src/agent/taskContract.js';
import { missingDeliveries } from '../src/agent/finalDelivery.js';

it('方案中的接口净重和路径数字不触发代码或数值任务', () => {
  const task = '在evals/baseline-20写一份1500至2500字水产交易方案Word，电子秤记录毛重、筐重、净重，银行接口未知，覆盖断网补传';
  expect(taskContract(task)).toMatchObject({ coding: false, calculation: false, formats: ['docx'] });
  expect(taskContract('生成4页PPT介绍检查清零、记录毛重、确认净重')).toMatchObject({ coding: false, calculation: false });
  expect(taskContract('写Word方案，并提供JavaScript接口代码').coding).toBe(true);
  expect(taskContract('生成Excel，计算10公斤乘20元的货款').calculation).toBe(true);
  expect(taskContract('实现银行接口').coding).toBe(true);
  expect(taskContract('毛重10公斤筐重1公斤，净重多少').calculation).toBe(true);
});
it('最终更正也保住本轮文档链接，不冒充内容或视觉通过', () => {
  const report = { contract: { formats: ['docx'] }, artifacts: [{ path: '本轮/方案.docx', format: 'docx', readback: 'passed', errors: 0 }] };
  expect(missingDeliveries('更正：字数未核验', report)).toContain(encodeURI('本轮/方案.docx'));
  expect(missingDeliveries('见本轮/方案.docx', report)).toBe('');
  expect(missingDeliveries('', { ...report, artifacts: report.artifacts.map(item => ({ ...item, stale: true })) })).toBe('');
  expect(missingDeliveries('', { ...report, contract: { formats: [] } })).toBe('');
});

it('字数从真实Word主文档计算，不采信模型自称已校验', async () => {
  const { generate } = await import('../src/agent/docs.js');
  const { inspectDocument } = await import('../src/agent/documentQuality.js');
  const { blob } = await generate('docx', { title: '方案', content: '# 方案\n\n' + '甲'.repeat(60) });
  const failed = await inspectDocument(blob, '方案.docx', { requirements: '1500至2500字方案' });
  expect(failed.wordCount).toMatchObject({ min: 1500, max: 2500, passed: false });
  expect(failed.errors).toBeGreaterThan(0);
  const passed = await inspectDocument(blob, '方案.docx', { requirements: '300字以内' });
  expect(passed.wordCount.passed).toBe(true);
  expect(passed.wordCount.count).toBeGreaterThanOrEqual(60);
});

it('政务导航顺读同站具体指南，正文证据归属实际网址', async () => {
  const { readGovernmentGuide } = await import('../src/agent/governmentGuide.js');
  const { sourceCandidates } = await import('../src/agent/answerRequirements.js');
  const { LINK_MARKER } = await import('../src/agent/pageLinks.js');
  const requestText = '查询市政府信息公开申请渠道';
  const calls = [];
  const guide = await readGovernmentGuide({ text: '导航' + LINK_MARKER + '\n1. 申请指南 — https://www.example.gov.cn/guide', url: 'https://www.example.gov.cn/', requestText, read: async url => { calls.push(url); return '受理方式：网上申请或邮寄申请，申请材料见本指南。'; } });
  expect(calls).toEqual(['https://www.example.gov.cn/guide']);
  expect(sourceCandidates(requestText, 'fetch_url', '【网页读取回执】' + JSON.stringify({ url: guide.url }) + '\n' + guide.text, { url: 'https://www.example.gov.cn/' })).toEqual([guide.url]);
  const budget = Object.assign(new Error('额度'), { code: 'RETRIEVAL_BUDGET' });
  await expect(readGovernmentGuide({ text: '导航' + LINK_MARKER + '\n申请须知 — https://www.example.gov.cn/guide', url: 'https://www.example.gov.cn/', requestText, read: async () => { throw budget; } })).rejects.toBe(budget);
});

it('今日新闻只保留独立合规条目，不用昨日或去年同日凑数', async () => {
  const { safeNewsPartial } = await import('../src/agent/newsDelivery.js');
  const { answerConstraintIssues } = await import('../src/agent/answerRequirements.js');
  const now = Date.parse('2026-10-25T08:00:00Z');
  const request = '查询今天国内三条新闻';
  const text = '1. 当日消息\n发布时间：2026年10月25日\n详情 https://example.test/today\n2. 旧消息\n发布时间：2026年10月24日\n详情 https://example.test/yesterday';
  const partial = safeNewsPartial(request, text, now);
  expect(partial).toContain('https://example.test/today');
  expect(partial).not.toContain('yesterday');
  expect(partial).toContain('尚未完成全部原文核实');
  expect(answerConstraintIssues(request, '发布时间：2025-10-25', now)).not.toEqual([]);
  expect(safeNewsPartial(request, '新闻 https://example.test/unknown', now)).toBe('');
});

it('实际主循环只留下更正文字时，最终事件和返回均带真实文件链接', async () => {
  const { runAgent } = await import('../src/agent/agent.js');
  let calls = 0;
  const shown = [];
  const adapter = { async stream({ onText }) {
    if (++calls === 1) return { text: '', toolCalls: [{ id: 'doc', name: 'create_document', args: { path: '交付/方案.docx' } }], stop: 'tool_use' };
    onText('更正：没有进行人工视觉验收。');
    return { text: '更正：没有进行人工视觉验收。', toolCalls: [], stop: 'end_turn' };
  } };
  const tool = { name: 'create_document', input_schema: { type: 'object', properties: {} }, run: async (_, execution) => {
    await execution.checkpoint({ type: 'artifact_validation', path: '交付/方案.docx', validation: { format: 'docx', readback: 'passed', structure: 'passed', errors: 0 } });
    return '交付/方案.docx 已生成';
  } };
  const result = await runAgent({ adapter, model: 'fixture', userText: '生成一份Word方案', history: [], context: { dynamic: '' }, tools: [tool], quiet: true, emit: event => { if (event.type === 'text') shown.push(event.delta); } });
  expect(result.text).toContain(encodeURI('交付/方案.docx'));
  expect(shown.join('')).toContain(encodeURI('交付/方案.docx'));
  expect(calls).toBe(2);
});

it('新闻核实失败也保留候选链接，明确不是已核实新闻，不保留摘要或凭据URL', async () => {
  const { createExecutionReview } = await import('../src/agent/executionReview.js');
  const { newsCandidateLinks } = await import('../src/agent/newsDelivery.js');
  const review = createExecutionReview('查询今天三条新闻');
  review.record({ name: 'web_search', ok: true, output: '- 候选新闻\n https://example.test/a\n 不应保存的摘要\n- 凭据\nhttps://example.test/a?token=hidden' });
  const text = newsCandidateLinks('查询今天三条新闻', review.newsCandidates());
  expect(text).toContain('https://example.test/a');
  expect(text).toContain('尚未完成原文核实');
  expect(text).not.toContain('hidden');
  expect(JSON.stringify(review.newsCandidates())).not.toContain('不应保存的摘要');
  review.revise('改成写故事');
  expect(review.newsCandidates()).toEqual([]);
});

it('生成失败后补救成功，只展示最终交付结论，不串入失效失败答复', async () => {
  const { runAgent } = await import('../src/agent/agent.js');
  let requests = 0, writes = 0;
  const shown = [];
  const adapter = { async stream({ onText }) {
    requests++;
    if (requests === 1 || requests === 3) return { text: '', toolCalls: [{ id: 'doc' + requests, name: 'create_document', args: { path: '交付/补救.docx' } }], stop: 'tool_use' };
    const text = requests === 2 ? '未能生成Word，路径回写失败。' : '已生成：[Word](交付/补救.docx)。';
    onText(text);
    return { text, toolCalls: [], stop: 'end_turn' };
  } };
  const tool = { name: 'create_document', input_schema: { type: 'object', properties: {} }, run: async (_, execution) => {
    if (++writes === 1) throw Object.assign(Error('路径回写失败'), { code: 'DOCUMENT_INPUT' });
    await execution.checkpoint({ type: 'artifact_validation', path: '交付/补救.docx', validation: { format: 'docx', readback: 'passed', structure: 'passed', errors: 0 } });
    return '已生成';
  } };
  const result = await runAgent({ adapter, model: 'fixture', userText: '写一份Word周报', history: [], context: { dynamic: '' }, tools: [tool], quiet: true, emit: e => { if (e.type === 'text') shown.push(e.delta); } });
  expect(result.text).toContain('已生成');
  expect(result.text).not.toContain('未能生成');
  expect(shown.join('')).not.toContain('未能生成');
  expect(requests).toBe(4);
});
it('明确不要比分赛程时，不用胜负标题补足资讯条数', async () => {
  const { newsMatchesRequest } = await import('../src/agent/newsDelivery.js');
  const request = '3条体育资讯，不要比分赛程';
  expect(newsMatchesRequest({ title: 'CBA常规赛：广州队主场不敌山西队' }, request)).toBe(false);
  expect(newsMatchesRequest({ title: '俱乐部宣布新的青训计划' }, request)).toBe(true);
  expect(newsMatchesRequest({ title: '广州队主场不敌山西队' }, '看看比赛结果')).toBe(true);
});
it('方案选择先给推荐并说明反向选择条件，不以计算工具过程开头', async () => {
  const { responseGuidance } = await import('../src/agent/responseGuidance.js');
  expect(responseGuidance('A方案投入20万，B方案不用投入，选哪个')).toContain('什么条件变化会改选另一项');
});
