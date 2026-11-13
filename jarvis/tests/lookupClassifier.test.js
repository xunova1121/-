import { it, expect, vi, afterEach } from 'vitest';
import { classifyLookupIntent } from '../src/agent/lookup/classify.js';
afterEach(() => vi.useRealTimers());
it('确定规则/用户偏好/非查询不调分类；未知词只接收kind，不接收工具或编造参数', async () => {
  const classify = vi.fn(async () => ({ kind: 'news', params: { city: '不采信' }, tools: ['execute'] }));
  expect((await classifyLookupIntent('体育资讯', { classify })).kind).toBe('sports_news');
  await classifyLookupIntent('开发一个新闻页面', { classify });
  expect(classify).not.toHaveBeenCalled();
  const result = await classifyLookupIntent('帮我瞧瞧外边发生了啥', { classify });
  expect(result).toMatchObject({ kind: 'news', params: {}, rule: 'cheap_classifier' });
  expect((await classifyLookupIntent('查个冷门问题', { classify: async () => 'run_shell' })).kind).toBe('general');
});
it('忽略signal的分类器最多等1秒，超时不采纳迟到结果；停止不能变成general', async () => {
  vi.useFakeTimers();
  const pending = classifyLookupIntent('冷门问题', { classify: () => new Promise(() => {}) });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).kind).toBe('general');
  const ctrl = new AbortController(); ctrl.abort(new Error('用户停止'));
  await expect(classifyLookupIntent('冷门问题', { signal: ctrl.signal })).rejects.toThrow('用户停止');
});
