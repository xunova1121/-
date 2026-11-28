import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const made = vi.hoisted(() => ({ count: 0, opts: null }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts) {
      made.count++;
      made.opts = opts;
      this.beta = { messages: { stream: () => { throw Object.assign(new Error('fixture: 不真的发请求'), { status: 400 }); } } };
    }
  }
}));

import { createAnthropicAdapter } from '../src/llm/anthropic.js';

describe('Anthropic 官方 SDK 用到才加载（网页首屏主包少约 200K，2026-11-28）', () => {
  it('源码里不静态引入 SDK（静态引入会被打进首屏主包）', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/llm/anthropic.js'), 'utf8');
    expect(src).not.toMatch(/^import[^;]*['"]@anthropic-ai\/sdk['"]/m);
    expect(src).toMatch(/import\(['"]@anthropic-ai\/sdk['"]\)/);
  });

  it('建适配器不创建客户端；第一次请求才建，之后复用同一个；参数照旧', async () => {
    const adapter = createAnthropicAdapter({ apiKey: 'k', baseURL: 'https://example.invalid', headers: { 'x-a': '1' } });
    expect(made.count).toBe(0);
    const req = { model: 'm', system: ['s', ''], messages: [{ role: 'user', content: '你好' }], tools: [], maxTransientRetries: 0 };
    await expect(adapter.stream(req)).rejects.toThrow();
    await expect(adapter.stream(req)).rejects.toThrow();
    expect(made.count).toBe(1);
    expect(made.opts).toMatchObject({ maxRetries: 0, apiKey: 'k', baseURL: 'https://example.invalid', defaultHeaders: { 'x-a': '1' }, dangerouslyAllowBrowser: true });
  });
});
