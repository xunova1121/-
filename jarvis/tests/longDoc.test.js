/** 第 2 批：长文档先大纲再逐节写、统一润色、读者测试 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { writeLongDocument, splitSections, readerTest } from '../src/agent/longDoc.js';
import { STABLE_PROMPT } from '../src/agent/agent.js';

/** 按提示词内容回答的假模型，记下每次调用 */
function fakeLlm({ readerIssues = null, reviseReply = null } = {}) {
  const calls = [];
  const llm = async ({ system, prompt }) => {
    calls.push({ system, prompt });
    if (prompt.includes('列出文档大纲')) {
      return JSON.stringify({ title: '智慧园区建设方案', sections: [
        { heading: '一、背景与目标', points: ['现状痛点', '建设目标'], words: 600 },
        { heading: '二、建设内容', points: ['平台', '设备改造'], words: 1200 },
        { heading: '三、实施计划', points: ['阶段', '负责人'], words: 800 }
      ] });
    }
    const m = prompt.match(/现在只写第 (\d+) 节「(.+?)」/);
    if (m) return `## ${m[2]}\n\n第 ${m[1]} 节正文。园区平台简称“平台”。本节写了要点。\n<<<本节摘要>>>摘要${m[1]}：写了${m[2]}`;
    if (prompt.includes('需要统一修改的地方')) return JSON.stringify({ edits: [{ find: '园区平台简称“平台”', replace: '园区运营平台（以下简称“平台”）', why: '统一叫法' }, { find: '原文里没有的句子', replace: 'x' }] });
    if (system.includes('目标读者')) return JSON.stringify({ issues: readerIssues ?? [{ type: '缺依据', section: '二、建设内容', quote: '第 2 节正文', problem: '没有说明设备数量的依据', suggestion: '补充清单' }] });
    if (prompt.includes('读者试读后')) return reviseReply ?? '## 二、建设内容\n\n第 2 节正文（已补充：改造电表 260 块，依据为 2026 年设备台账）。园区运营平台（以下简称“平台”）。';
    return '{}';
  };
  return { llm, calls };
}

describe('长文档分步写作', () => {
  it('先大纲，再逐节写：每节都带完整大纲和前面各节的摘要，只写这一节', async () => {
    const { llm, calls } = fakeLlm({ readerIssues: [] });
    const r = await writeLongDocument({ task: '写一份智慧园区建设方案，给公司领导审批', words: 2600, llm });
    expect(r.outline.map((s) => s.heading)).toEqual(['一、背景与目标', '二、建设内容', '三、实施计划']);
    const sec = calls.filter((c) => c.prompt.includes('现在只写第'));
    expect(sec).toHaveLength(3);
    for (const c of sec) expect(c.prompt).toContain('3. 三、实施计划'); // 每节都带完整大纲
    expect(sec[0].prompt).toContain('（这是第一节）');
    expect(sec[2].prompt).toContain('摘要1：写了一、背景与目标');
    expect(sec[2].prompt).toContain('摘要2：写了二、建设内容');
    expect(r.markdown).toMatch(/^# 智慧园区建设方案\n\n## 一、背景与目标/);
    expect(r.markdown).not.toContain('<<<本节摘要>>>'); // 摘要不进文档
  });

  it('统一润色：只按原文片段替换，找不到的片段忽略', async () => {
    const { llm } = fakeLlm({ readerIssues: [] });
    const r = await writeLongDocument({ task: '方案', llm });
    expect(r.edits).toBe(1);
    expect(r.markdown).toContain('园区运营平台（以下简称“平台”）');
  });

  it('读者测试：只拿成品、不带写作过程；有问题的节按意见改一轮', async () => {
    const { llm, calls } = fakeLlm();
    const r = await writeLongDocument({ task: '方案', material: '设备台账：电表 260 块', llm });
    const reader = calls.find((c) => c.system.includes('目标读者'));
    expect(reader.prompt).toContain('第 1 节正文');
    expect(reader.prompt).not.toContain('完整大纲');
    expect(reader.prompt).not.toContain('<<<本节摘要>>>');
    expect(reader.prompt).not.toContain('设备台账'); // 写作材料不给读者
    expect(r.review.issues).toHaveLength(1);
    expect(r.review.revised).toEqual(['二、建设内容']);
    expect(r.markdown).toContain('依据为 2026 年设备台账');
    expect(r.markdown).toContain('第 1 节正文'); // 其他节不动
    expect(calls.filter((c) => c.prompt.includes('读者试读后'))).toHaveLength(1); // 只改一轮
  });

  it('改坏了（丢了标题、太短）就保留原文', async () => {
    const { llm } = fakeLlm({ reviseReply: '好的' });
    const r = await writeLongDocument({ task: '方案', llm });
    expect(r.review.revised).toEqual([]);
    expect(r.markdown).toContain('第 2 节正文。');
  });

  it('只出大纲：不写正文；带着确认过的大纲再写：跳过列大纲', async () => {
    const a = fakeLlm();
    const o = await writeLongDocument({ task: '方案', outlineOnly: true, llm: a.llm });
    expect(o.markdown).toBeUndefined();
    expect(a.calls).toHaveLength(1);
    const b = fakeLlm({ readerIssues: [] });
    const r = await writeLongDocument({ task: '方案', title: '定稿方案', outline: [{ heading: '## 一、概述', points: ['目标'] }, { heading: '二、预算' }], llm: b.llm });
    expect(b.calls.some((c) => c.prompt.includes('列出文档大纲'))).toBe(false);
    expect(r.outline.map((s) => s.heading)).toEqual(['一、概述', '二、预算']);
    expect(r.markdown).toContain('# 定稿方案');
  });

  it('不做读者测试时不调用读者；没配模型时说明原因', async () => {
    const { llm, calls } = fakeLlm();
    const r = await writeLongDocument({ task: '方案', review: false, llm });
    expect(r.review).toBeNull();
    expect(calls.some((c) => c.system.includes('目标读者'))).toBe(false);
    await expect(writeLongDocument({ task: '方案', llm: null })).rejects.toThrow(/需要配置大模型/);
  });

  it('读者模型出错：不影响成稿，标明没完成', async () => {
    const r = await readerTest({ title: 't', body: 'x', task: 'y', llm: async () => { throw new Error('502'); } });
    expect(r).toMatchObject({ issues: [], failed: true });
  });

  it('按“## ”切节', () => {
    expect(splitSections('## 一\n\na\n\n## 二\n\nb').map((s) => s.heading)).toEqual(['一', '二']);
  });
});

describe('write_long_document 工具', () => {
  let tools;
  let ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
    const { llm } = fakeLlm();
    tools = (await import('../src/agent/tools.js')).createTools({ llm });
  });
  afterEach(() => { delete globalThis.indexedDB; });
  const tool = () => tools.find((t) => t.name === 'write_long_document');

  it('生成 Word，结果里有节数、字数、读者发现的问题；进度一步步报出来', async () => {
    const progress = [];
    const r = await tool().run({ task: '方案', path: '方案/园区', cover: true }, { progress: (t) => progress.push(t) });
    expect(r).toMatch(/已生成 方案\/园区\.docx/);
    expect(r).toContain('3 节');
    expect(r).toContain('【缺依据】二、建设内容：没有说明设备数量的依据');
    expect(await ws.exists('方案/园区.docx')).toBe(true);
    expect(progress).toEqual(expect.arrayContaining(['列大纲…', '写第 2/3 节：二、建设内容', '请一位“读者”通读挑问题…']));
  });

  it('参考文件由程序读全文交给写作，不靠模型转述', async () => {
    const { llm, calls } = fakeLlm();
    tools = (await import('../src/agent/tools.js')).createTools({ llm });
    await ws.write('资料/原方案.md', '# 原方案\n\n独有细节：雷达覆盖半径 12 公里，国发〔2025〕11号。');
    const r = await tool().run({ task: '在原方案基础上补充', path: '方案/补充版', material_files: ['资料/原方案.md'] });
    expect(r).toMatch(/已生成/);
    expect(calls.some((c) => c.prompt.includes('列出文档大纲') && c.prompt.includes('雷达覆盖半径 12 公里'))).toBe(true);
    expect(calls.filter((c) => c.prompt.includes('现在只写第')).every((c) => c.prompt.includes('国发〔2025〕11号'))).toBe(true);
    await expect(tool().run({ task: 'x', path: 'y', material_files: ['没有这个.docx'] })).rejects.toThrow(/读不到参考文件/);
  });

  it('先看大纲：只返回大纲，提示确认后带 outline 再调用', async () => {
    const r = await tool().run({ task: '方案', path: 'x', outline_only: true });
    expect(r).toContain('## 二、建设内容');
    expect(r).toContain('outline 参数');
    expect(await ws.exists('x.docx')).toBe(false);
  });
});

describe('说明书', () => {
  it('长文档用 write_long_document；“先看大纲”才停下', () => {
    expect(STABLE_PROMPT).toContain('write_long_document');
    expect(STABLE_PROMPT).toMatch(/先看大纲.*outline_only/);
  });
});

describe('写作规范', async () => {
  const { detectGenre, METHOD, CHECKLIST } = await import('../src/agent/writingGuide.js');
  it('按任务判断文种', () => {
    expect(detectGenre('写一份长江禁捕执法智能化项目建议书')?.id).toBe('proposal');
    expect(detectGenre('关于召开年度安全会议的通知')?.id).toBe('official');
    expect(detectGenre('写一份新能源市场调研报告')?.id).toBe('research');
    expect(detectGenre('2026 年第三季度工作总结')?.id).toBe('summary');
    expect(detectGenre('智慧园区建设方案（征求意见稿）')?.id).toBe('plan');
    expect(detectGenre('随便写点东西')).toBe(null);
  });
  it('列大纲带上文种结构，逐节写带上写法，读者带上检查清单', async () => {
    const { llm, calls } = fakeLlm();
    const { writeLongDocument } = await import('../src/agent/longDoc.js');
    await writeLongDocument({ task: '写一份项目建议书', llm });
    expect(calls.find((c) => c.prompt.includes('列出文档大纲')).prompt).toContain('项目建议书 / 可行性研究报告');
    expect(calls.find((c) => c.prompt.includes('现在只写第')).prompt).toContain(METHOD.slice(0, 20));
    expect(calls.find((c) => c.system.includes('目标读者')).prompt).toContain(CHECKLIST.slice(0, 10));
  });
});
