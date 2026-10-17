import { describe, it, expect } from 'vitest';
import { savePending, clearPending, takePending, resumeText, PENDING_MAX_AGE } from '../src/core/pendingTask.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

describe('手机：App 被关掉时接着做没做完的任务', () => {
  it('记下、更新步骤，取出最新一条并清空', () => {
    const s = mem();
    savePending(s, 'a', { turnId: 1, text: '做一页纸汇报', ts: 1000, steps: [], files: [] });
    savePending(s, 'a', { ts: 2000, steps: ['读取文件'], files: ['汇报.docx'] });
    savePending(s, 'b', { turnId: 2, text: '旧任务', ts: 500 });
    const r = takePending(s, 3000);
    expect(r).toMatchObject({ sessionId: 'a', text: '做一页纸汇报', steps: ['读取文件'], files: ['汇报.docx'] });
    expect(takePending(s, 3000)).toBeNull();
  });
  it('正常结束清掉；新一轮开始后旧一轮的结束不清新记录', () => {
    const s = mem();
    savePending(s, 'a', { turnId: 1, text: 'x', ts: 1 });
    savePending(s, 'a', { turnId: 2, text: 'y', ts: 2 });
    clearPending(s, 'a', 1);
    expect(takePending(s, 3)?.text).toBe('y');
    savePending(s, 'a', { turnId: 3, text: 'z', ts: 4 });
    clearPending(s, 'a', 3);
    expect(s.m.size).toBe(0);
  });
  it('太久以前的不再接着做；接着做的话带上做过的步骤和文件', () => {
    const s = mem();
    savePending(s, 'a', { turnId: 1, text: 'x', ts: 0 });
    expect(takePending(s, PENDING_MAX_AGE + 1)).toBeNull();
    const t = resumeText({ text: '生成 Word 和 Excel', steps: ['读取文件', '生成文档'], files: ['a.docx'] });
    expect(t).toContain('生成 Word 和 Excel');
    expect(t).toContain('读取文件；生成文档');
    expect(t).toContain('a.docx');
  });
});
