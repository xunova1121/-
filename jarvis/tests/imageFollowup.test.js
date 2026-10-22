import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { followsImage, remoteTurnImages, creativeWithoutLookup } from '../src/core/imageFollowup.js';
import { runAgent } from '../src/agent/agent.js';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { delete globalThis.indexedDB; });

describe('图片连续追问和轻量创作', () => {
  it('描述、发散、文案连续追问保留旧图，换话题后不再自动带图', () => {
    const cached = new Map([[1, [{ mime: 'image/png', data: 'old' }]]]);
    const messages = [{ role: 'user', ts: 1, content: '看这张图' }];
    for (const text of ['描述场景', '发散三个创意', '写一段文案']) {
      expect(followsImage(text, messages, cached)).toBe(true);
      messages.push({ role: 'user', ts: messages.length + 1, content: text });
    }
    messages.push({ role: 'user', ts: 10, content: '今天吃什么' });
    expect(followsImage('写一段文案', messages, cached)).toBe(false);
    expect(followsImage('再看刚才发的图片', messages, cached)).toBe(true);
    expect(followsImage('谢谢', messages, cached)).toBe(false);
  });

  it('云端图片最多4张、当前优先；保持原图片顺序与重复项，不凭缩略图补入', () => {
    const image = (data) => ({ mime: 'image/png', data });
    expect(remoteTurnImages([image('new')], [{ images: [image('old'), image('new')] }, { images: [image('last')] }]).map((item) => item.data)).toEqual(['new', 'old', 'new', 'last']);
    expect(remoteTurnImages([], [{ images: [image('first')] }, { content: '追问' }, { images: [image('second')] }]).map((item) => item.data)).toEqual(['first', 'second']);
    expect(remoteTurnImages(Array.from({ length: 10 }, (_, i) => image(String(i))))).toHaveLength(4);
    expect(remoteTurnImages([], [{ thumbs: [{ src: '缩略图' }], content: '文字' }])).toEqual([]);
  });

  it('描述和创作默认不检索，明确核实来源/型号时保留搜索，附件名不改变意图', () => {
    for (const text of ['这个图的场景描述下先发散思维', '发散三个创意', '写一段文案', '编个故事', '描述场景，不用搜索来源']) expect(creativeWithoutLookup(text), text).toBe(true);
    for (const text of ['描述图片并查一下设备型号', '发散创意，搜索最新案例', '查一下今天股价', '根据图做Word文档']) expect(creativeWithoutLookup(text), text).toBe(false);
    expect(creativeWithoutLookup('描述场景\n\n[已上传到工作区：查资料图.png]')).toBe(true);
  });

  it('实际调度不提供搜索/委派工具，原生搜索也关闭；误调用不会真的联网', async () => {
    let searches = 0;
    let step = 0;
    const events = [];
    const result = await runAgent({
      adapter: { kind: 'anthropic', async stream(options) {
        expect(options.allowWebSearch).toBe(false);
        expect(options.tools.some((tool) => ['web_search', 'fetch_url', 'delegate_task'].includes(tool.name))).toBe(false);
        expect(options.system.join('\n')).toContain('区分可见事实与创意联想');
        if (++step === 1) return { text: '', toolCalls: [{ id: 'bad', name: 'web_search', args: { query: '不应执行' } }], stop: 'tool_use' };
        options.onText('画面描述和三个创意。');
        return { text: '画面描述和三个创意。', toolCalls: [], stop: 'end_turn' };
      } }, model: 'fixture', history: [], userText: '这个图的场景描述下先发散思维',
      tools: [{ name: 'web_search', description: '搜索', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => { searches++; return '不应访问'; } }],
      context: { dynamic: '', kbHits: [] }, quiet: true, emit: (event) => events.push(event)
    });
    expect(searches).toBe(0);
    expect(events.find((event) => event.type === 'tool_end')).toMatchObject({ code: 'SEARCH_NOT_REQUESTED', ok: false });
    expect(result.text).toContain('画面描述');
    expect(result.text).not.toContain('检索已停止');
  });

  it('中途明确要求查出处后恢复搜索，不把创作模式锁死', async () => {
    const inbox = [];
    let step = 0;
    let searches = 0;
    await runAgent({
      adapter: { kind: 'openai', async stream(options) {
        if (++step === 1) {
          expect(options.allowWebSearch).toBe(false);
          inbox.push('现在查一下这张图的出处');
          options.onText('先描述场景。');
          return { text: '先描述场景。', toolCalls: [], stop: 'end_turn' };
        }
        if (step === 2) {
          expect(options.allowWebSearch).toBe(true);
          expect(options.tools.some((tool) => tool.name === 'web_search')).toBe(true);
          return { text: '', toolCalls: [{ id: 'search', name: 'web_search', args: {} }], stop: 'tool_use' };
        }
        options.onText('出处核查结果。');
        return { text: '出处核查结果。', toolCalls: [], stop: 'end_turn' };
      } }, model: 'fixture', history: [], userText: '描述这张图', inbox,
      tools: [{ name: 'web_search', description: '搜索', input_schema: { type: 'object', properties: {} }, run: async () => { searches++; return '测试结果'; } }],
      context: { dynamic: '', kbHits: [] }, quiet: true, emit() {}
    });
    expect(searches).toBe(1);
  });

  it('普通查询中改成图片创作后，解除旧60秒限制且不输出旧检索停止警告', async () => {
    vi.useFakeTimers();
    try {
      const inbox = [];
      let step = 0;
      const work = runAgent({
        adapter: { kind: 'openai', async stream(options) {
          if (++step === 1) {
            inbox.push('改成描述场景，发散三个创意，不用搜索');
            options.onText('收到原问题。');
            return { text: '收到原问题。', toolCalls: [], stop: 'end_turn' };
          }
          expect(options.allowWebSearch).toBe(false);
          await new Promise((resolve) => setTimeout(resolve, 70000));
          options.onText('完成图片创作。');
          return { text: '完成图片创作。', toolCalls: [], stop: 'end_turn' };
        } }, model: 'fixture', history: [], userText: '今天有哪些新闻', inbox, tools: [],
        context: { dynamic: '', kbHits: [] }, quiet: true, emit() {}
      });
      await vi.advanceTimersByTimeAsync(70001);
      const result = await work;
      expect(result.text).toContain('完成图片创作');
      expect(result.text).not.toMatch(/检索已停止|部分完成/);
    } finally { vi.useRealTimers(); }
  });
});
