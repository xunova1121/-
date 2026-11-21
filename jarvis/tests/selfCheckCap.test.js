import { describe, it, expect, vi } from 'vitest';
import { selfCheck, REVIEW_CAP_MS } from '../src/agent/selfCheck.js';

describe('“对照要求自查”不能一直转（截图：做 PPT 时一直停在这一步）', () => {
  it('模型迟迟不回：到时限就跳过，原文照常交给生成', async () => {
    vi.useFakeTimers();
    try {
      const progress = [];
      let gotSignal;
      const llm = ({ signal }) => { gotSignal = signal; return new Promise(() => {}); };
      const p = selfCheck({ format: 'pptx', content: '## 背景\n- 20户', requirements: '5页汇报', llm, onProgress: (t) => progress.push(t) });
      await vi.advanceTimersByTimeAsync(REVIEW_CAP_MS + 10);
      const r = await p;
      expect(r.checked).toBe(false);
      expect(r.content).toBe('## 背景\n- 20户');
      expect(progress.at(-1)).toMatch(/先跳过/);
      expect(gotSignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('用户自己点停止：照常停止，不当成跳过', async () => {
    const ctrl = new AbortController();
    const p = selfCheck({ format: 'pptx', content: 'x', requirements: '5页', llm: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
