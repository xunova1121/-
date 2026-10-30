import { describe, it, expect, vi } from 'vitest';
import { createRetrievalBudget, withWebDeadline, extensiveRetrieval } from '../src/agent/retrievalBudget.js';

describe('查询预算', () => {
  it('普通查询从首次联网开始计时，45秒后停止；研究和文档保留8分钟，逐项核验至少保留3分钟', () => {
    let t = 0;
    const b = createRetrievalBudget('仙逆中姚冰云的结局', { now: () => t });
    t = 100_000; expect(b.reason).toBe(''); expect(b.begin()).toBe(true);
    t += 44_999; expect(b.reason).toBe(''); t++; expect(b.reason).toContain('时间预算');
    for (const text of ['写一份报告', '逐项核验比赛结果', '对比这几个方案', '深度调研', '保存为Word']) {
      expect(extensiveRetrieval(text)).toBe(true);
      let now = 0; const deep = createRetrievalBudget(text, { now: () => now }); deep.begin();
      now = 46_000; expect(deep.reason).toBe(''); now = 480_000; expect(deep.reason).toContain('时间预算');
    }
  });
  it('不同链接仍共享22次兜底预算；连续失败3次提前结束，成功则清零失败数', () => {
    const b = createRetrievalBudget('查结局');
    for (let i=0;i<22;i++) { expect(b.begin()).toBe(true); b.end(true); }
    expect(b.begin()).toBe(false);
    const failed = createRetrievalBudget('查结局');
    failed.begin(); failed.end(false); failed.begin(); failed.end(true);
    for (let i=0;i<3;i++) { failed.begin(); failed.end(false); }
    expect(failed.reason).toContain('连续 3 次');
  });
  it('用户补充需要报告时升级预算，不把普通文字对话算作查询', () => {
    const b = createRetrievalBudget('查结局'); b.upgrade('请写一份报告');
    for (let i=0;i<8;i++) { expect(b.begin()).toBe(true); b.end(true); }
    expect(b.reason).toBe(''); expect(b.note).toContain('可以继续读写文件');
  });
  it('超时覆盖正文读取，终止底层signal；调用方停止不再发请求', async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const p = withWebDeadline(async s => { signal=s; return new Promise(()=>{}); }, { timeoutMs: 100 });
      const assertion = expect(p).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(101); await assertion; expect(signal.aborted).toBe(true);
      const ctrl=new AbortController(); ctrl.abort(); const work=vi.fn();
      await expect(withWebDeadline(work,{signal:ctrl.signal})).rejects.toMatchObject({name:'AbortError'});
      expect(work).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('画架构图不受普通问答的预算限制', () => {
  it('“做那个项目的架构图”按长任务算：模型调用（画完自查要用）不会3次就被拦（用户 2026-10-26 遇到“模型调用预算限制”没拿到图）', () => {
    for (const text of ['做那个长江禁捕项目的架构图', '画一张业务流程图', '出个网络拓扑图', '做成精致海报']) expect(extensiveRetrieval(text), text).toBe(true);
    const b = createRetrievalBudget('做那个长江禁捕项目的架构图');
    for (let i = 0; i < 6; i++) b.consume('model');
    expect(b.reason).toBe('');
    // 普通问答照旧收紧
    expect(extensiveRetrieval('这张图片里写的什么')).toBe(false);
    const quick = createRetrievalBudget('今天天气怎么样');
    for (let i = 0; i < 3; i++) quick.consume('model');
    expect(() => quick.consume('model')).toThrow(/预算/);
  });
});
