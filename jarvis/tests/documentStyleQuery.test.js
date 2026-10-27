import { beforeEach, describe, expect, it } from 'vitest';
import { asksDocumentStyles } from '../src/agent/documentStyleQuery.js';
import { buildContext } from '../src/agent/agent.js';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';

beforeEach(async () => {
  for (const name of ['memories', 'episodes', 'lessons', 'skills', 'events', 'sessions', 'kv']) await collection(name).clear();
  memory.configureMemory({});
});

describe('文档偏好问答按需读取', () => {
  it('明确文档偏好不依赖旧话题，制作爱好须有近期文档上下文', () => {
    expect(asksDocumentStyles('我的Word排版偏好是什么')).toBe(true);
    expect(asksDocumentStyles('根据我的偏好排版')).toBe(true);
    expect(asksDocumentStyles('我的制作爱好是什么')).toBe(false);
    expect(asksDocumentStyles('我的制作爱好是什么', [{ content: '刚才完成Word排版' }])).toBe(true);
    expect(asksDocumentStyles('我的兴趣爱好是什么', [{ content: 'Word' }])).toBe(false);
    expect(asksDocumentStyles('我做菜有什么制作爱好', [{ content: 'Word' }])).toBe(false);
  });

  it('指代话题扫描有上限，不拿很久以前的文档推断兴趣', () => {
    expect(asksDocumentStyles('我的制作爱好是什么', [{ content: 'Word' }, ...Array.from({ length: 8 }, () => ({ content: '其他话题' }))])).toBe(false);
    expect(asksDocumentStyles('我的制作爱好是什么', [{ content: '字'.repeat(800) + 'Word' }])).toBe(false);
  });

  it('真实上下文能读到doc_style，普通闲聊不带；当前明确要求优先', async () => {
    await memory.reflect([{ role: 'user', content: '以后Word用宋体，不要封面' }], { episode: false, session: { id: 'style-test' } });
    const result = await buildContext('我的制作爱好是什么', { light: true, history: [{ role: 'user', content: '帮我把方案做成Word' }] });
    expect(result.dynamic).toContain('docx · 用宋体');
    expect(result.dynamic).toContain('不要封面');
    expect(result.dynamic).toContain('当前任务的明确要求优先');
    expect((await buildContext('你好', { light: true })).dynamic).not.toContain('docx · 用宋体');
  });

  it('偏好更正和删除立即反映在上下文，不留旧快照', async () => {
    await memory.reflect([{ role: 'user', content: '以后Word用宋体' }], { episode: false, session: { id: 'style-test' } });
    await memory.reflect([{ role: 'user', content: '以后Word用黑体' }], { episode: false, session: { id: 'style-test' } });
    const changed = await buildContext('我的Word排版偏好', { light: true });
    expect(changed.dynamic).toContain('docx · 用黑体');
    expect(changed.dynamic).not.toContain('docx · 用宋体');
    for (const style of await memory.listDocumentStyles()) await memory.deleteDocumentStyle(style.id);
    expect((await buildContext('我的Word排版偏好', { light: true })).dynamic).not.toContain('docx · 用黑体');
  });

  it('可见历史压缩后仍以本轮任务会话判别文档话题，不使用别的会话', async () => {
    await memory.reflect([{ role: 'user', content: '以后Word用宋体' }], { episode: false, session: { id: 'style-test' } });
    const session = sessions.create({
      messages: [
        { role: 'user', content: '把刚才的方案做成Word' },
        { role: 'assistant', content: '文档已生成' }
      ]
    });
    await sessions.save(session);
    const visible = [{ role: 'user', content: '继续' }];
    expect((await buildContext('我的制作爱好是什么', { light: true, sessionId: session.id, history: visible })).dynamic).toContain('docx · 用宋体');
    expect((await buildContext('我的制作爱好是什么', { light: true, sessionId: '其他会话', history: visible })).dynamic).not.toContain('docx · 用宋体');
  });
});
