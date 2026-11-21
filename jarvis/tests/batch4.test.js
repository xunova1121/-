/** 第 4 批：按片段改文件、改已有 Word/PPT、用户模板、生成后自查、工具按需加载 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { IDBFactory } from 'fake-indexeddb';
import { applyEdits } from '../src/agent/textEdit.js';
import { replaceInParagraph, editOffice } from '../src/agent/officeEdit.js';
import { applyTemplate, TEMPLATE_PATH } from '../src/agent/docxWriter.js';
import { lint, layoutSummary, selfCheck } from '../src/agent/selfCheck.js';
import { createToolLoader, CORE } from '../src/agent/toolLoader.js';
import { generate, parseFile } from '../src/agent/docs.js';
import { runAgent } from '../src/agent/agent.js';

beforeAll(() => Promise.all([import('exceljs'), import('xlsx'), import('pptxgenjs'), import('docx')]), 60_000);

describe('按片段修改文本（edit_file）', () => {
  it('只改那一段；多处修改按顺序执行；Windows 换行保持不变', () => {
    const src = 'function a() {\r\n  return 1;\r\n}\r\nconst b = 2;\r\n';
    const r = applyEdits(src, [{ old_text: '  return 1;', new_text: '  return 42;' }, { old_text: 'const b = 2;', new_text: 'const b = 3;' }]);
    expect(r).toEqual({ text: 'function a() {\r\n  return 42;\r\n}\r\nconst b = 3;\r\n', count: 2 });
  });

  it('出现多次：要求更多上下文，或 replace_all', () => {
    expect(() => applyEdits('x x x', [{ old_text: 'x', new_text: 'y' }])).toThrow(/出现了 3 次/);
    expect(applyEdits('x x x', [{ old_text: 'x', new_text: 'y', replace_all: true }])).toEqual({ text: 'y y y', count: 3 });
  });

  it('找不到：提示可能是空格不一样；空的 / 没变化的修改报错', () => {
    expect(() => applyEdits('  const  a = 1;', [{ old_text: 'const a = 1;', new_text: 'b' }])).toThrow(/第 1 行内容相近/);
    expect(() => applyEdits('abc', [{ old_text: 'zzz', new_text: 'b' }])).toThrow(/没有找到/);
    expect(() => applyEdits('abc', [{ old_text: '', new_text: 'b' }])).toThrow(/不能为空/);
    expect(() => applyEdits('abc', [{ old_text: 'a', new_text: 'a' }])).toThrow(/一样/);
  });

  it('替换内容里的 $ 符号原样写入', () => {
    expect(applyEdits('price', [{ old_text: 'price', new_text: '$& $1 $$' }]).text).toBe('$& $1 $$');
  });
});

describe('改已有的 Word / PPT（保留格式）', () => {
  it('跨 run 的文字也能找到；新文字沿用开头那段的格式；转义正确', () => {
    const p = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>甲方：北京</w:t></w:r><w:r><w:t xml:space="preserve">某某公司</w:t></w:r><w:r><w:t>（盖章）</w:t></w:r></w:p>';
    const r = replaceInParagraph(p, 'w:t', '北京某某公司', '上海<新>公司 & 合伙');
    expect(r.count).toBe(1);
    expect(r.xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">甲方：上海&lt;新&gt;公司 &amp; 合伙</w:t>');
    expect(r.xml).toContain('<w:t xml:space="preserve"></w:t>');
    expect(r.xml).toContain('（盖章）');
    expect(r.xml).not.toContain('<w:tab'); // 不误伤其他标签
    expect(replaceInParagraph('<w:p><w:r><w:tab/><w:t>a</w:t></w:r></w:p>', 'w:t', 'a', 'b').xml).toContain('<w:tab/>');
  });

  it('Word：正文、表格、页脚里的都替换；末尾追加段落照抄最后一段的格式；其余格式不变', async () => {
    const src = await generate('docx', { title: 'x', content: '# 2025 年度报告\n\n## 一、概况\n\n2025 年收入 **100 万元**。\n\n| 年份 | 收入 |\n|--|--|\n| 2025 | 100 |' });
    const before = await (await JSZip.loadAsync(await src.blob.arrayBuffer())).file('word/styles.xml').async('string');
    const r = await editOffice(src.blob, 'docx', { replacements: [{ find: '2025', replace: '2026' }, { find: '不存在', replace: 'x' }], append: ['本报告由财务部编制。'] });
    expect(r.replaced).toEqual([{ find: '2025', count: 4 }, { find: '不存在', count: 0 }]); // 标题、正文、表格、页眉
    expect(r.appended).toBe(1);
    const zip = await JSZip.loadAsync(await r.blob.arrayBuffer());
    expect(await zip.file('word/styles.xml').async('string')).toBe(before);
    const doc = await zip.file('word/document.xml').async('string');
    expect(doc.indexOf('本报告由财务部编制。')).toBeLessThan(doc.lastIndexOf('<w:sectPr'));
    const { text } = await parseFile(r.blob, 'r.docx');
    expect(text).toContain('2026 年度报告');
    expect(text).not.toContain('2025');
    expect(text).toContain('本报告由财务部编制。');
  });

  it('PPT：每页和备注里替换；PPT 不支持追加段落', async () => {
    const src = await generate('pptx', { title: '方案', content: '## 背景\n- 甲公司市场扩大\n\n备注：讲甲公司\n\n## 目标\n- 甲公司增长 30%' });
    const r = await editOffice(src.blob, 'pptx', { replacements: [{ find: '甲公司', replace: '乙公司' }] });
    expect(r.replaced[0].count).toBe(3);
    const { text } = await parseFile(r.blob, 'p.pptx');
    expect(text).toContain('乙公司增长 30%');
    await expect(editOffice(src.blob, 'pptx', { append: ['x'] })).rejects.toThrow(/只支持 Word/);
  });
});

describe('用户的 Word 模板', () => {
  /** 中文版 Word 模板：标题样式 id 是“1”“2”，没有 heading 3 */
  async function chineseTemplate() {
    const base = await generate('docx', { title: 't', content: '正文' });
    const zip = await JSZip.loadAsync(await base.blob.arrayBuffer());
    zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="方正仿宋_GBK"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:rPr><w:color w:val="C00000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="公司小标题"/></w:style></w:styles>');
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('按样式名对上模板里的 id；模板没有的样式补上，id 撞了就换名', async () => {
    const tpl = await chineseTemplate();
    const { blob, info } = await generate('docx', { title: 'x', content: '# 报告\n\n## 一级\n\n正文\n\n### 二级\n\n正文\n\n#### 三级\n\n正文', template: tpl });
    expect(info.template.matched).toEqual(expect.arrayContaining(['heading 1', 'heading 2']));
    expect(info.template.added).toEqual(expect.arrayContaining(['heading 3', 'title']));
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const doc = await zip.file('word/document.xml').async('string');
    const styles = await zip.file('word/styles.xml').async('string');
    expect(doc).toContain('<w:pStyle w:val="1"/>');
    expect(doc).toContain('<w:pStyle w:val="2"/>');
    expect(doc).toContain('<w:pStyle w:val="JarvisHeading3"/>'); // 模板里 Heading3 是别的样式
    expect(doc).not.toContain('w:val="Heading1"');
    expect(styles).toContain('方正仿宋_GBK'); // 沿用模板的默认字体
    expect(styles).toContain('w:styleId="JarvisHeading3"');
    const { text } = await parseFile(blob, 'r.docx');
    expect(text).toContain('三级');
  });

  it('不是 Word 的模板给出明确错误；模板文件名规则', async () => {
    await expect(applyTemplate(new Blob(['x']), new Uint8Array([1, 2, 3]))).rejects.toThrow(/模板打不开/);
    for (const p of ['模板/公司报告.docx', 'templates/a.docx', '公司报告模板.docx', 'x/report-template.docx']) expect(TEMPLATE_PATH.test(p), p).toBe(true);
    for (const p of ['报告.docx', '模板/说明.md', 'mytemplates.txt']) expect(TEMPLATE_PATH.test(p), p).toBe(false);
  });
});

describe('生成后自查', () => {
  it('规则检查：空章节、标题跳级、表格列数、空白页、占位文字、重复标题', () => {
    const md = '# 报告\n\n## 一、背景\n\n## 二、数据\n\n#### 细节\n\n内容 XXX\n\n| a | b |\n|--|--|\n| 1 | 2 | 3 |\n\n[分页]\n\n[分页]\n\n## 二、数据\n\n正文';
    const texts = lint('docx', md).map((x) => x.text).join('\n');
    expect(texts).toContain('“一、背景”这一节没有内容');
    expect(texts).toContain('标题跳级');
    expect(texts).toContain('列数和表头不一致');
    expect(texts).toContain('空白页');
    expect(texts).toContain('占位文字');
    expect(texts).toContain('重复出现');
    expect(lint('docx', '# 好文档\n\n## 一\n\n正文\n\n### 小节\n\n正文')).toEqual([]);
  });

  it('PPT：字太多会溢出、表格太长、标题太长', () => {
    const md = `## ${'很长的标题'.repeat(8)}\n- ${'内容'.repeat(200)}\n\n## 表\n| a | b |\n|--|--|\n${Array.from({ length: 10 }, (_, i) => `| ${i} | x |`).join('\n')}`;
    const t = lint('pptx', md).map((x) => x.text).join('\n');
    expect(t).toMatch(/字太多.*溢出/);
    expect(t).toContain('一页放不下');
    expect(t).toContain('标题太长');
  });

  it('排版结构摘要：标题层级、每节字数、表格行列、图片、分页', () => {
    const s = layoutSummary('docx', '# 报告\n\n## 一\n\n正文十个字正文十个字\n\n| a | b |\n|--|--|\n| 1 | 2 |\n\n![图](a.png)\n\n[分页]');
    expect(s).toContain('## 一');
    expect(s).toContain('[表格 1 行 × 2 列]');
    expect(s).toContain('[图片：图]');
    expect(s).toContain('[分页]');
  });

  it('有原始要求时请模型对照检查：按片段替换、在标题后补内容，修完再查一次', async () => {
    let seen = '';
    const llm = async ({ prompt }) => {
      seen = prompt;
      return JSON.stringify({ problems: ['漏了预算', '有占位文字'], edits: [{ find: '负责人：XXX', replace: '负责人：待确认' }], append_after: [{ heading: '二、实施计划', markdown: '### 预算\n\n总预算约 50 万元（待确认）。' }] });
    };
    const md = '# 方案\n\n## 一、目标\n\n提升效率。负责人：XXX\n\n## 二、实施计划\n\n分三期。\n\n## 三、风险\n\n可控。';
    const r = await selfCheck({ format: 'docx', content: md, requirements: '写一份方案，要有目标、计划和预算', llm });
    expect(seen).toContain('要有目标、计划和预算');
    expect(seen).toContain('排版后的结构');
    expect(seen).toContain('占位文字');
    expect(r.checked).toBe(true);
    expect(r.changed).toBe(2);
    expect(r.content).toMatch(/分三期。\n\n### 预算\n\n总预算约 50 万元（待确认）。\n\n\n## 三、风险/);
    // 改成“待确认”是如实标注，只留一条提醒，不算错误
    expect(r.issues.filter((x) => x.level === 'error')).toEqual([]);
    expect(r.issues.map((x) => x.text).join()).toContain('待确认');
  });

  it('没有要求、也没有硬伤：不调用模型；模型出错：照常生成', async () => {
    const GOOD = '# 季度总结\n\n## 一、情况\n\n本季度完成销售目标。';
    let called = 0;
    const r = await selfCheck({ format: 'docx', content: GOOD, llm: async () => { called++; return '{}'; } });
    expect(called).toBe(0);
    expect(r.checked).toBe(false);
    const bad = await selfCheck({ format: 'docx', content: GOOD, requirements: 'x', llm: async () => { throw new Error('502'); } });
    expect(bad).toMatchObject({ checked: false, content: GOOD });
  });
});

describe('工具按需加载', () => {
  const mk = (name, description = `${name} 的说明`) => ({ name, description, input_schema: { type: 'object', properties: {} }, run: async () => `${name} 已执行` });
  const many = [...CORE].slice(0, 10).map((n) => mk(n)).concat(Array.from({ length: 20 }, (_, i) => mk(`extra_${i}`)), [mk('computer_click', '点击屏幕上的某个位置。'), mk('clipboard_read', '读取剪贴板。')]);

  it('工具不多时全部常驻（和以前一样）', () => {
    const l = createToolLoader(many.slice(0, 12));
    expect(l.deferredMode).toBe(false);
    expect(l.list()).toHaveLength(12);
    expect(l.hint()).toBe('');
  });

  it('工具多时：常用的带完整说明，其余只列名字和一句话；tool_search 按关键词 / 名字加载', async () => {
    const l = createToolLoader(many);
    expect(l.deferredMode).toBe(true);
    const names = l.list().map((t) => t.name);
    expect(names).toContain('tool_search');
    expect(names).not.toContain('computer_click');
    expect(names).toHaveLength(11);
    expect(l.hint()).toContain('- computer_click：点击屏幕上的某个位置');
    const r = await l.get('tool_search').run({ query: '点击屏幕' });
    expect(r).toContain('computer_click');
    expect(l.list().map((t) => t.name)).toContain('computer_click');
    expect(l.hint()).not.toContain('computer_click');
    await l.get('tool_search').run({ names: ['clipboard_read'] });
    expect(l.isActive('clipboard_read')).toBe(true);
    expect(await l.get('tool_search').run({ query: '完全无关的东西xyz' })).toContain('没有找到');
  });

  it('模型直接调用没加载的工具：照常执行并加载', () => {
    const l = createToolLoader(many);
    expect(l.get('extra_3')).toBeTruthy();
    expect(l.isActive('extra_3')).toBe(true);
    expect(l.get('nope')).toBeUndefined();
  });

  it('接入智能体循环：第一轮只发常用工具；模型搜到后下一轮就带上，并且能调用', async () => {
    const seenTools = [];
    let systemText = '';
    let step = 0;
    const adapter = {
      async stream({ tools, system }) {
        seenTools.push(tools.map((t) => t.name));
        systemText = system.join('\n');
        step++;
        if (step === 1) return { text: '', toolCalls: [{ id: 'a', name: 'tool_search', args: { query: '剪贴板' } }], stop: 'tool_use' };
        if (step === 2) return { text: '', toolCalls: [{ id: 'b', name: 'clipboard_read', args: {} }], stop: 'tool_use' };
        return { text: '完成', toolCalls: [], stop: 'end_turn' };
      }
    };
    const events = [];
    await runAgent({ adapter, model: 'm', history: [], userText: '读一下剪贴板', tools: many, emit: (e) => events.push(e), context: { dynamic: '' } });
    expect(seenTools[0]).not.toContain('clipboard_read');
    expect(seenTools[1]).toContain('clipboard_read');
    expect(systemText).toContain('其他可用工具');
    expect(events.find((e) => e.type === 'tool_end' && e.name === 'clipboard_read')).toMatchObject({ ok: true, output: 'clipboard_read 已执行' });
  });
});

describe('工具接入工作区', () => {
  let tools;
  let ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
    tools = (await import('../src/agent/tools.js')).createTools({ llm: async () => JSON.stringify({ problems: ['标题不对'], edits: [{ find: '旧标题内容', replace: '新标题内容' }] }) });
  });
  afterEach(() => { delete globalThis.indexedDB; });
  const run = (name, args) => tools.find((t) => t.name === name).run(args, {});

  it('edit_file 改工作区文件并留旧版本；不是文本文件时提示用 edit_office_document', async () => {
    await ws.write('site/index.html', '<h1>旧</h1>\n<p>保留</p>');
    expect(await run('edit_file', { path: 'site/index.html', edits: [{ old_text: '<h1>旧</h1>', new_text: '<h1>新</h1>' }] })).toMatch(/替换 1 处.*自动备份/);
    expect(await ws.readText('site/index.html')).toBe('<h1>新</h1>\n<p>保留</p>');
    await expect(run('edit_file', { path: 'a.docx', edits: [] })).rejects.toThrow(/edit_office_document/);
  });

  it('edit_office_document 改 Word；一个都没找到时不写文件', async () => {
    await ws.write('合同.docx', (await generate('docx', { title: 'x', content: '## 合同\n\n甲方：老公司' })).blob);
    expect(await run('edit_office_document', { path: '合同.docx', replacements: [{ find: '老公司', replace: '新公司' }] })).toMatch(/“老公司”替换了 1 处/);
    expect((await parseFile(await ws.readBlob('合同.docx'), 'a.docx')).text).toContain('新公司');
    await expect(run('edit_office_document', { path: '合同.docx', replacements: [{ find: '没有的字', replace: 'x' }] })).rejects.toThrow(/没有找到/);
  });

  it('工作区里有模板时自动沿用；传 none 不用', async () => {
    await ws.write('模板/公司模板.docx', (await generate('docx', { title: 't', content: '正文' })).blob);
    expect(await run('create_document', { format: 'docx', path: '报告', content: '## 一\n\n正文' })).toContain('自动沿用了模板 模板/公司模板.docx');
    expect(await run('create_document', { format: 'docx', path: '报告2', content: '## 一\n\n正文', template: 'none' })).not.toContain('模板');
  });

  it('create_document 带原始要求：生成前自查并改一轮，结果里写明', async () => {
    // 内容要够长：一千多字以内、规则检查没问题的短文件不再请模型自查（省十几秒）
    const filler = '\n\n' + '各单位按要求落实检查、整改和复核，逐项登记责任人和完成时间。'.repeat(45);
    const r = await run('create_document', { format: 'docx', path: '通知', content: `# 通知\n\n## 一\n\n旧标题内容${filler}`, requirements: '写一份通知' });
    expect(r).toContain('生成前对照要求自查，修正了 1 处（标题不对）');
    expect((await parseFile(await ws.readBlob('通知.docx'), 'a.docx')).text).toContain('新标题内容');
  });
});

describe('按需加载：用户连的 MCP 工具', () => {
  const t = (name) => ({ name, description: `${name} 的说明。` });
  const base = Array.from({ length: 30 }, (_, i) => t(`extra_tool_${i}`));
  it('MCP 工具不多时常驻，模型直接能看到', () => {
    const loader = createToolLoader([...base, t('mcp_echo__echo'), t('mcp_echo__add')]);
    expect(loader.deferredMode).toBe(true);
    const names = loader.list().map((x) => x.name);
    expect(names).toContain('mcp_echo__echo');
    expect(names).toContain('mcp_echo__add');
    expect(names).not.toContain('extra_tool_0');
  });
  it('MCP 工具太多时照常按需加载', () => {
    const mcp = Array.from({ length: 20 }, (_, i) => t(`mcp_big__tool${i}`));
    const loader = createToolLoader([...base, ...mcp]);
    expect(loader.list().some((x) => x.name.startsWith('mcp_'))).toBe(false);
    expect(loader.hint()).toMatch(/mcp_big__tool0/);
  });
});

describe('长文档：长材料不截断、按节取相关段落', async () => {
  const { skeleton, relevantMaterial } = await import('../src/agent/longDoc.js');
  const long = ['一、项目概述', '项目名称是长江禁捕执法智能化扩展。'.repeat(30), '二、必要性', '落实国务院人工智能+行动意见，国发〔2025〕11号。'.repeat(40), '三、投资估算', '总投资67万元，全部为软件开发费用。'.repeat(40)].join('\n\n').repeat(20);
  it('材料的标题结构能取出来', () => {
    expect(skeleton('一、项目概述\n正文很长很长\n（二）必要性\n1. 法律法规\n普通一句话')).toBe('一、项目概述\n（二）必要性\n1. 法律法规');
  });
  it('每节拿到和自己相关的段落，不是只拿开头', () => {
    expect(long.length).toBeGreaterThan(24000);
    const part = relevantMaterial(long, '投资估算 总投资 资金来源');
    expect(part.length).toBeLessThanOrEqual(24000);
    expect(part).toMatch(/总投资67万元/);
    const part2 = relevantMaterial(long, '必要性 国务院 人工智能');
    expect(part2).toMatch(/国发〔2025〕11号/);
  });
  it('短材料原样返回', () => {
    expect(relevantMaterial('短材料', '任意')).toBe('短材料');
  });
});
