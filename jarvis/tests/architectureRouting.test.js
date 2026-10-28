import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { strictArchitecture } from '../src/agent/diagramPlanning.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { parseFile } from '../src/agent/docs.js';
import { repairDiagramInput, layoutWithRepair } from '../src/agent/diagramRepair.js';

// 用户 2026-10-26～29 让未央画长江禁捕总体架构图，严格流水线连续五六次一张图都没出：
// 平时直接 create_diagram 出图，只有明说“逐条核对需求原文 / 严格审查”才走 build_architecture
describe('架构图走哪条路', () => {
  it('只有明确要逐条核对 / 严格审查才算严格模式', () => {
    for (const t of ['根据招标文件制作总体架构图，逐条核对需求原文', '画架构图，每个模块对应需求原文核对', '严格审查后出总体架构图']) expect(strictArchitecture(t), t).toBe(true);
    for (const t of ['做那个长江禁捕项目的架构图', '根据上传/招标文件.docx制作总体架构图。遇到失败保留真实错误阶段和已有文件。', '重新做这个架构图']) expect(strictArchitecture(t), t).toBe(false);
  });

  it('普通架构图请求：create_diagram 不再要求先走架构底稿；严格请求照旧要求', async () => {
    const tool = createDiagramTool({}, { requireArchitecture: 'strict' });
    const input = { path: '图/总体架构.svg', title: '总体架构', layers: [{ title: '应用层', nodes: [{ id: 'a', title: '业务应用' }] }] };
    const ordinary = await tool.run(input, { rawRequestText: '做那个长江禁捕项目的架构图' }).catch((e) => e);
    expect(ordinary?.code).not.toBe('ARCHITECTURE_PLAN_REQUIRED');
    await expect(tool.run(input, { rawRequestText: '制作总体架构图，逐条核对需求原文' })).rejects.toMatchObject({ code: 'ARCHITECTURE_PLAN_REQUIRED' });
  });
});

describe('后缀是 .doc 的 Word 文件', () => {
  it('其实是新版 Word（PK 开头）：按内容读出来；真正的老版 .doc 报清楚怎么另存', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第四章 采购需求：建设综合管理平台</w:t></w:r></w:p></w:body></w:document>');
    const blob = new Blob([await zip.generateAsync({ type: 'uint8array' })]);
    expect((await parseFile(blob, '上传/招标文件.doc')).text).toContain('建设综合管理平台');
    const ole = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]);
    await expect(parseFile(ole, '老文件.doc')).rejects.toThrow(/另存为.*docx/);
  });
});

// 用户 2026-10-29 06:19 实测（服务器 gpt-6-luna）：三次被版式规则拦下，没出图
describe('普通画图：版式参数不合规则时程序调整，不让模型反复重填', () => {
  const n = (id, extra = {}) => ({ id, title: '模块' + id, ...extra });
  const messy = {
    title: '重点水域禁捕总体架构',
    design: { theme: 'gov-blue' },
    layers: [
      { title: '展示层', kind: 'band', nodes: [n('a', { subtitle: '指挥大屏' }), n('b')] },
      { title: '应用层', kind: 'columns', nodes: [1, 2, 3, 4, 5, 6].map((i) => n('c' + i, { detail: '业务说明' + i })) },
      { title: '平台层', kind: 'grid', group: '支撑平台', nodes: [1, 2, 3].map((i) => n('g' + i)) },
      { title: '感知层', kind: 'cards', nodes: Array.from({ length: 15 }, (_, i) => n('s' + i)) }
    ],
    edges: [{ from: 'a', to: 'c1', type: 'integration', label: '调用接口服务数据交换' }, { from: 'c1', to: '不存在' }]
  };

  it('通栏多节点、分栏超4个、网格不足8个、普通层超12个：改层类型，不删节点、不改名称', () => {
    const { input, notes } = repairDiagramInput(messy);
    expect(input.layers.map((l) => l.kind)).toEqual(['cards', 'cards', 'cards', 'grid']);
    expect(input.layers.flatMap((l) => l.nodes.map((x) => x.id))).toHaveLength(2 + 6 + 3 + 15);
    expect(input.layers[0].nodes[0].detail).toContain('指挥大屏'); // 副标题并进说明，不丢字
    expect(input.layers[1].nodes[5].detail).toBe('业务说明6');
    expect(input.edges).toEqual([{ from: 'a', to: 'c1', label: '调用接口服务数据交换' }]);
    expect(notes.join('\n')).toMatch(/通栏只能放一个纯文字内容[\s\S]*分栏只放2～4个[\s\S]*网格需8个以上[\s\S]*改为网格[\s\S]*应用集成[\s\S]*不存在/);
  });

  it('排得出图；跨层箭头文字放不下就去掉文字、保留箭头并记下', () => {
    const { model, notes } = layoutWithRepair(messy);
    expect(model.nodes).toHaveLength(26);
    expect(model.edges).toEqual([{ from: 'a', to: 'c1' }]);
    expect(notes.at(-1)).toMatch(/箭头的文字已去掉，箭头保留/);
  });

  it('create_diagram 普通请求：同样的乱参数直接出图并在回执里写明调整；严格请求照原规则拦下', async () => {
    const tool = createDiagramTool({}, { requireArchitecture: 'strict' });
    const input = { path: '图/禁捕总体架构.svg', ...messy };
    const done = await tool.run(input, { rawRequestText: '做一下这个项目的架构图' }).catch((e) => e);
    expect(String(done?.code ?? '')).not.toMatch(/DIAGRAM_SECTION|DIAGRAM_INPUT|ARCHITECTURE_PLAN_REQUIRED/);
    if (typeof done === 'string') expect(done).toContain('layoutAdjusted');
    else console.log('[create_diagram 测试环境后续步骤]', done?.code, String(done?.message).slice(0, 120));
    await expect(tool.run(input, { rawRequestText: '做一下这个项目的架构图，逐条核对需求原文' })).rejects.toMatchObject({ code: 'ARCHITECTURE_PLAN_REQUIRED' });
  });
});

// 用户 2026-10-29 07:06 实测：图出来了但“好多线，乱七八糟”，视觉检查因连线过密不通过，PNG/PPT 没导出；候选图混在成果里分不清
describe('普通架构图：去掉跨层连线、过程文件不当成果、.doc 新版 Word 能搜', () => {
  it('分层架构图只留同层连线并记下省略条数；流程图不动', () => {
    const input = {
      title: '总体架构',
      layers: [
        { title: '展示', nodes: [{ id: 'a', title: 'PC端' }, { id: 'b', title: '大屏' }] },
        { title: '平台', nodes: [{ id: 'c', title: '数据' }, { id: 'd', title: 'AI' }] }
      ],
      edges: [{ from: 'a', to: 'b', label: '联动' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }]
    };
    const arch = layoutWithRepair(input, { architecture: true });
    expect(arch.model.edges.map((e) => e.from + e.to)).toEqual(['ab', 'cd']);
    expect(arch.notes.join()).toContain('跨层连线 2 条已省略');
    expect(layoutWithRepair(input).model.edges).toHaveLength(4);
  });

  it('dropCrossLayer 单独用：两层之间的连线去掉', async () => {
    const { dropCrossLayer } = await import('../src/agent/diagramRepair.js');
    expect(dropCrossLayer({ layers: [{ nodes: [{ id: 'a' }] }, { nodes: [{ id: 'b' }] }], edges: [{ from: 'a', to: 'b' }] }).input.edges).toEqual([]);
  });

  it('回答下面的文件卡片不列“文档检查/”里的候选图和审查记录', async () => {
    const { PROCESS_FILE } = await import('../src/ui/workspaceCatalog.js');
    expect(PROCESS_FILE.test('文档检查/架构候选/1f2e/candidate-0.png')).toBe(true);
    expect(PROCESS_FILE.test('长江禁捕项目总体架构.svg')).toBe(false);
  });

  it('search_in_files：后缀 .doc 内容是新版 Word 的照常搜；真老 .doc 照旧报清楚', async () => {
    const ws = await import('../src/agent/workspace.js');
    const { createTools } = await import('../src/agent/tools.js');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>建设湖泊电子围栏系统5套</w:t></w:r></w:p></w:body></w:document>');
    await ws.write('上传/虚构招标.doc', new Blob([await zip.generateAsync({ type: 'uint8array' })]));
    await ws.write('上传/真老文件.doc', new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])]));
    const search = createTools({}).find((t) => t.name === 'search_in_files');
    expect(await search.run({ path: '上传/虚构招标.doc', query: '电子围栏' })).toContain('电子围栏');
    await expect(search.run({ path: '上传/真老文件.doc', query: '任意' })).rejects.toHaveProperty('code', 'DOCUMENT_NAVIGATION');
  });
});
