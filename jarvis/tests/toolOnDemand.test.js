import { describe, it, expect } from 'vitest';
import { createTools } from '../src/agent/tools.js';
import { createToolLoader, CORE } from '../src/agent/toolLoader.js';
import { taskToolCore, IMAGE_INPUT_TOOLS, MEDIA_TOOLS } from '../src/agent/taskToolProfile.js';
import { POSTER_TOOLS } from '../src/agent/posterRouting.js';
import { resolveTaskIntent } from '../src/core/taskIntent.js';

const tools = createTools({}).filter((t) => t?.name);
const names = new Set([...tools.map((t) => t.name), ...CORE]); // web_search 等配好才有的也算
const sent = (text, images = []) => {
  const loader = createToolLoader(tools, { core: taskToolCore(resolveTaskIntent(text, { history: [], images: images.length }), text, { images }) });
  return { list: loader.list().map((t) => t.name), hint: loader.hint(), chars: JSON.stringify(loader.list().map((t) => [t.name, t.description, t.input_schema])).length };
};

describe('工具按需加载：带图、生成图片不再一次带上全部常驻工具（2026-11-28）', () => {
  it('新加的两组工具名都真的存在（写错名字会悄悄少一个工具）', () => {
    for (const n of [...IMAGE_INPUT_TOOLS, ...MEDIA_TOOLS]) expect(names.has(n), n).toBe(true);
  });

  it('带图提问：给看图、认字、改图和文件工具，不带海报、架构图、写文档的长说明', () => {
    const r = sent('这张图片里写了什么', [{ data: 'x' }]);
    for (const n of ['inspect_image', 'read_image_text', 'process_image', 'read_file']) expect(r.list).toContain(n);
    for (const n of ['make_poster', 'create_diagram', 'create_document', 'create_visual_demo']) expect(r.list).not.toContain(n);
    expect(r.list.length).toBeLessThan(30);
    expect(r.chars).toBeLessThan(40000); // 原来全部常驻约 10 万字
  });

  it('带图再按文字加：用这张照片做海报 → 海报工具都在；放进 Word → 写文档的工具都在', () => {
    const poster = sent('用这张照片做一张海报', [{ data: 'x' }]).list;
    for (const n of POSTER_TOOLS) if (tools.some((t) => t.name === n)) expect(poster, n).toContain(n); // update_plan 由对话循环自己加
    const doc = sent('把这张图片里的表格做成 Word 文档', [{ data: 'x' }]).list;
    expect(doc).toContain('create_document');
    expect(doc).toContain('read_image_text');
  });

  it('生成图片、唱歌、视频：只带这几样', () => {
    for (const [text, need] of [['帮我生成图片：一只猫', 'generate_image'], ['给我唱首歌', 'sing_song'], ['做个小视频', 'generate_video']]) {
      const r = sent(text);
      if (tools.some((t) => t.name === need)) expect(r.list, text).toContain(need);
      expect(r.list, text).not.toContain('make_poster');
      expect(r.list, text).not.toContain('create_diagram');
    }
  });

  it('没带完整说明的工具仍列在系统提示里，按名字能直接调用', () => {
    const r = sent('这张图片里写了什么', [{ data: 'x' }]);
    expect(r.hint).toMatch(/make_poster/);
    const loader = createToolLoader(tools, { core: taskToolCore({}, '这张图片里写了什么', { images: [{}] }) });
    expect(loader.get('make_poster')?.name).toBe('make_poster');
    expect(loader.list().map((t) => t.name)).toContain('make_poster');
  });

  it('操作电脑、逐条核对架构仍给全部常驻工具（不变）', () => {
    expect(taskToolCore({}, '打开记事本', { computerTask: 'gui' })).toBe(CORE);
    expect(taskToolCore({}, '核对架构', { strict: true })).toBe(CORE);
  });
});
