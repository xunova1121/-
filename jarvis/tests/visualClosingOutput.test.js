/** 搜索到点后继续用已有材料排版；不重置检索或收费生图预算。 */
import { it, expect, vi } from 'vitest';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { createExecutionReview } from '../src/agent/executionReview.js';

function closedContext(tools) {
  const retrieval = createRetrievalBudget('南京今天多少度');
  retrieval.begin();
  retrieval.consume('search');
  retrieval.close('本轮联网检索已达到时间预算');
  return {
    loader: { get: name => tools.find(tool => tool.name === name) },
    emit: vi.fn(), seen: new Map(),
    review: createExecutionReview('根据已有资料制作气象大屏'),
    webTools: new Set(['web_search']), parallelSafe: new Set(),
    retrieval, checkpoint: vi.fn(), closing: true, allowWebSearch: true
  };
}

const tool = (name, run) => ({ name, input_schema: { type: 'object', properties: {} }, run });
const call = name => ({ id: name, name, args: {} });

it.each(['make_poster', 'create_visual_demo'])('%s在查询收尾后仍可执行本地排版，原检索终止原因和资源账本保留', async name => {
  const run = vi.fn(async () => JSON.stringify({ status: 'partial', files: [], notes: ['实际渲染另由专用验收覆盖'] }));
  const search = vi.fn(async () => '不应再搜索');
  const context = closedContext([tool(name, run), tool('web_search', search)]);
  expect(context.retrieval.extensive).toBe(false);
  const before = context.retrieval.resources;
  const [result] = await executeToolCalls([call(name)], context);
  expect(result.ok).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  expect(context.retrieval.extensive).toBe(true);
  expect(context.retrieval.reason).toBe('本轮联网检索已达到时间预算');
  expect(context.retrieval.resources).toEqual(before);
  expect(() => context.retrieval.consume('model')).toThrow(/预算/);
  const [web] = await executeToolCalls([call('web_search')], context);
  expect(web.ok).toBe(false);
  expect(search).not.toHaveBeenCalled();
});

it('收费生图不按本地排版放行；排版继续后也不能恢复已结束的收费预算', async () => {
  const charge = vi.fn();
  const generate = vi.fn(async (_args, { retrieval }) => {
    retrieval.consume('model');
    charge();
    return '不能产生新收费请求';
  });
  const context = closedContext([tool('generate_image', generate), tool('create_visual_demo', async () => '已保留源稿')]);
  const [before] = await executeToolCalls([call('generate_image')], context);
  expect(before.ok).toBe(false);
  expect(generate).not.toHaveBeenCalled();
  await executeToolCalls([call('create_visual_demo')], context);
  const [after] = await executeToolCalls([{ ...call('generate_image'), id: 'after-layout' }], context);
  expect(after.ok).toBe(false);
  expect(after.failure.code).toBe('RETRIEVAL_BUDGET');
  expect(charge).not.toHaveBeenCalled();
});

it('搜索收尾后本地制作仍服从用户停止，不执行迟到写入', async () => {
  const run = vi.fn(async () => '不应写文件');
  const context = closedContext([tool('create_visual_demo', run)]);
  const controller = new AbortController();
  controller.abort();
  await expect(executeToolCalls([call('create_visual_demo')], { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(run).not.toHaveBeenCalled();
});
