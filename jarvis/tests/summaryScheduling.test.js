import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ summarize: null }));
vi.mock('../src/llm/helper.js', () => ({ createHelperLlm: () => input => state.summarize(input) }));
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';

const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('调度条件未完成');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

describe('后台摘要不阻塞前台写入', () => {
  it('新问题中止在途摘要、无需等待上游；迟到结果不能覆盖新对话', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-summary-'));
    useBackend(createFileStore(dir));
    let release, calls = 0, firstSignal;
    state.summarize = input => {
      if (!String(input.system).includes('前情提要')) return '';
      calls++;
      if (calls > 1) return '当前有效摘要';
      firstSignal = input.signal;
      return new Promise(resolve => { release = resolve; });
    };
    const cfg = { provider: 'openai', models: { openai: 'fixture' }, keys: { openai: 'fixture-not-a-key' }, autoMemory: false };
    const runner = createTaskRunner({ getConfig: async () => cfg, afterIdleMs: 5, makeTools: () => [], makeAdapter: () => ({ model: 'fixture', adapter: { stream: async () => ({ text: '已收到。', toolCalls: [], stop: 'end_turn' }) } }) });
    try {
      const session = sessions.create();
      session.messages = Array.from({ length: 34 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '旧消息' + i, ts: i + 1 }));
      await sessions.save(session);
      await runner.start({ sessionId: session.id, text: '你好' });
      await until(() => firstSignal);
      const next = await runner.start({ sessionId: session.id, text: '谢谢' });
      await until(() => runner.get(next.id).status === 'done');
      expect(firstSignal.aborted).toBe(true);
      expect(release).toBeTypeOf('function');
      release('不应写入的迟到摘要');
      await runner.settled();
      const saved = await sessions.get(session.id);
      expect(saved.messages.some(message => message.content === '谢谢')).toBe(true);
      expect(saved.summary.text).not.toContain('迟到摘要');
      expect(calls).toBe(2);
    } finally {
      release?.('清理');
      for (const task of runner.list()) runner.stop(task.id);
      await runner.settled();
      useBackend(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
