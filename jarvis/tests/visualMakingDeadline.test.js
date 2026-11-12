import { afterEach, describe, it, expect, vi } from 'vitest';
import { isQuickLookup, withLookupDeadline } from '../src/agent/lookupDeadline.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
afterEach(() => vi.useRealTimers());

describe('视觉制作工具沿用实际制作解除查询时限', () => {
  it.each(['make_poster', 'create_visual_demo'])('%s已开始制作后不被普通60秒查询时限截断', async toolName => {
    vi.useFakeTimers();
    const userText = '给已有海报补Demo';
    expect(isQuickLookup(userText)).toBe(true);
    let runOptions;
    const task = withLookupDeadline({ userText, emit() {} }, async options => {
      runOptions = options;
      await delay(10_000);
      options.emit({ type: 'tool_start', name: toolName });
      await delay(150_000);
      return { text: '制作文件已返回，视觉尚未验收' };
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runOptions.lookupControl.released()).toBe(true);
    await vi.advanceTimersByTimeAsync(150_000);
    await expect(task).resolves.toMatchObject({ text: '制作文件已返回，视觉尚未验收' });
    expect(runOptions.signal.aborted).toBe(false);
  });

  it('查询工具仍受原时限约束，视觉制作解除后仍可用户停止', async () => {
    vi.useFakeTimers();
    const query = withLookupDeadline({ userText: '南京天气', emit() {} }, async options => {
      options.emit({ type: 'tool_start', name: 'web_search' });
      await delay(100_000);
      return '迟到';
    });
    const failed = query.catch(error => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await failed).toMatchObject({ code: 'LOOKUP_TIMEOUT' });

    const ctrl = new AbortController();
    let child;
    const making = withLookupDeadline({ userText: '给已有海报补Demo', signal: ctrl.signal, emit() {} }, async options => {
      child = options;
      options.emit({ type: 'tool_start', name: 'create_visual_demo' });
      await delay(150_000);
      return '停止后不应交付';
    });
    const stopped = making.catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.lookupControl.released()).toBe(true);
    ctrl.abort();
    expect(await stopped).toMatchObject({ name: 'AbortError' });
    expect(child.signal.aborted).toBe(true);
  });
});
