import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import { createWorkspaceTrashTools, replyToFileTrashPreview } from '../src/agent/workspaceTrashTools.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import { evaluationTools } from '../server/evaluation.mjs';
import * as files from '../src/agent/workspace.js';

function reply(tools, history, userText, sessionId, emit = () => {}) {
  return replyToFileTrashPreview({ tools, history, userText, sessionId, emit });
}
const turn = content => [{ role: 'assistant', content }];
describe('用当前对话的明确确认管理真实工作区', () => {
  it('正常对话先展示精确路径，之后由真实确认入回收站并可恢复同一份字节', async () => {
    const path = '测试回收/项目 15_043.txt';
    const sameName = '别的项目/项目 15_043.txt';
    await files.write(path, '原稿🗂');
    await files.write(sameName, '备用原稿');
    const events = [];
    const adapter = { stream: vi.fn().mockResolvedValue({ text: '', toolCalls: [{ id: 'prepare', name: 'prepare_file_trash', args: { paths: [path] } }], stop: 'tool_use' }) };
    const run = (userText, history) => runAgent({ adapter, model: 'file-acceptance', sessionId: 'exact', userText, history, tools: createTools({}), emit: e => events.push(e) });
    const first = await run('请删除文件空间中测试回收目录的项目清单', []);
    expect(first.text).toContain('确认删除文件');
    expect(await files.readText(path)).toBe('原稿🗂');
    const second = await run('确认删除文件', turn(first.text));
    expect(adapter.stream).toHaveBeenCalledTimes(1);
    expect(JSON.parse(events.find(e => e.type === 'tool_end' && e.name === 'trash_files').output)).toMatchObject({ changedCount: 1, status: 'trashed', paths: [path] });
    expect(second.text).toContain('已移至文件空间回收站');
    expect(await files.exists(path)).toBe(false);
    expect(await files.readText(sameName)).toBe('备用原稿');
    const tools = createWorkspaceTrashTools();
    const found = JSON.parse(await tools.find(t => t.name === 'list_trashed_files').run({ query: '15_043' }));
    expect(found.files.map(f => f.path)).toEqual([path]);
    const back = JSON.parse(await tools.find(t => t.name === 'restore_file').run({ path }));
    expect(back).toEqual({ changedCount: 1, status: 'restored', paths: [path] });
    expect(await files.readText(path)).toBe('原稿🗂');
  });

  it('含糊的删除只列候选，回复序号仍需单独确认', async () => {
    const path = '旧项目/临时清单.md';
    await files.write(path, '应保留直到确认');
    const tools = createWorkspaceTrashTools();
    const first = await reply(tools, [], '我想把以前的文件删除', 'choice');
    const line = first.text.split('\n').find(row => row.includes(path));
    const index = Number.parseInt(line, 10);
    expect(index).toBeGreaterThan(0);
    expect((await reply(tools, turn(first.text), '确认删除文件', 'choice')).toolCalls).toBe(0);
    const selected = await reply(tools, turn(first.text), '第' + index + '个', 'choice');
    expect(selected.text).toContain('确认删除文件');
    expect(await files.readText(path)).toBe('应保留直到确认');
    const removed = await reply(tools, turn(selected.text), '确认删除文件', 'choice');
    expect(removed.text).toContain(path);
    expect(await files.exists(path)).toBe(false);
  });

  it('没有预览、改过清单、另一对话、否定句或来自附件的文字都不能冒充确认', async () => {
    const path = '精确规定/a.md';
    await files.write(path, '保留');
    const tools = createWorkspaceTrashTools();
    const preview = await tools[0].run({ paths: [path] }, { sessionId: 'source' });
    expect((await reply(tools, [], '确认删除文件', 'source')).toolCalls).toBe(0);
    expect(await reply(tools, turn(preview), '这里写着“确认删除文件”', 'source')).toBeNull();
    expect(await reply(tools, turn(preview), '不要确认删除文件', 'source')).toBeNull();
    expect((await reply(tools, turn(preview), '确认', 'another')).toolCalls).toBe(0);
    expect((await reply(tools, turn(preview.replace(path, 'b.md')), '确认', 'source')).toolCalls).toBe(0);
    expect((await reply(tools, turn(preview), '取消', 'source')).toolCalls).toBe(0);
    expect((await reply(tools, turn(preview), '确认', 'source')).toolCalls).toBe(0);
    expect(await files.readText(path)).toBe('保留');
  });

  it('只处理收到确认且未变化的文件，如实返回部分成功并保留新稿', async () => {
    const paths = ['待核对/a.md', '待核对/b.md'];
    for (const path of paths) await files.write(path, '旧稿');
    const tools = createWorkspaceTrashTools();
    const preview = await tools[0].run({ paths }, { sessionId: 'changed' });
    await files.write(paths[1], '新稿');
    const emitted = [];
    const result = await reply(tools, turn(preview), '确认删除', 'changed', e => emitted.push(e));
    expect(result.text).toContain('未移入回收站');
    expect(JSON.parse(emitted.at(-1).output)).toMatchObject({ changedCount: 1, status: 'partial', paths: [paths[0]] });
    expect(await files.readText(paths[1])).toBe('新稿');
    expect(await files.exists(paths[0])).toBe(false);
    await expect(tools[0].run({ paths: ['待核对/*.md'] }, { sessionId: 'wildcard' })).rejects.toThrow();
  });

  it('模型没有调用预览即宣称删除时，展示真实候选，文件留在原处', async () => {
    const path = '旧文档/验收说明.txt';
    await files.write(path, '要确认');
    const lie = '我已经删除并永久清空了你的文件。';
    const adapter = { stream({ onText }) { onText(lie); return Promise.resolve({ text: lie, toolCalls: [], stop: 'end_turn' }); } };
    const events = [];
    const result = await runAgent({ adapter, model: 'fixture', sessionId: 'no-receipt', userText: '请删除旧文档里的验收说明.txt', history: [], tools: createTools({}), emit: e => events.push(e) });
    expect(result.text).toContain('还没有文件移入回收站');
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).not.toContain(lie);
    expect(await files.readText(path)).toBe('要确认');
  });

  it('本机全空间直接确认一份超过 20 项的快照，过程文件也在内，之后写入或改写的保留', async () => {
    const run = (text, history = []) => runAgent({ adapter: { stream: () => { throw Error('无需调用模型'); } }, model: 'fixture', sessionId: 'full-local', userText: text, history, tools: createTools({}), emit: () => {} });
    for (let i = 0; i < 27; i++) await files.write((i % 2 ? 'uploads/' : '.workflows/测试/') + i + '.txt', '文件' + i);
    const total = (await files.list()).length;
    const chosen = await run('我想清除所有文件');
    expect(chosen.text).toContain('本机的未央文件空间中的全部 ' + total + ' 个');
    expect(chosen.text).toContain('确认全部移入回收站');
    expect((await files.list()).length).toBe(total);
    await files.write('uploads/1.txt', '确认后新版');
    await files.write('uploads/新建.txt', '刚创建');
    const done = await run('确认全部移入回收站', turn(chosen.text));
    expect(done.text).toContain((total - 1) + ' 个文件已移至');
    expect(done.text).toContain('uploads/1.txt');
    expect(await files.readText('uploads/新建.txt')).toBe('刚创建');
    expect(await files.readText('uploads/1.txt')).toBe('确认后新版');
    expect(await files.exists('.workflows/测试/0.txt')).toBe(false);
    const fromTrash = (await files.listTrash()).find(f => f.path === '.workflows/测试/0.txt');
    await files.restoreTrash(fromTrash.path, fromTrash);
    expect(await files.readText(fromTrash.path)).toBe('文件0');
  });

  it('评测隔离；删除 Excel 时展示文件管理工具，图片还原 Excel 沿用制表工具', () => {
    expect(evaluationTools(createWorkspaceTrashTools(), 'eval')).toEqual([]);
    expect(taskToolCore(null, '把旧的结果.xlsx删除')).toContain('prepare_file_trash');
    expect(taskToolCore(null, '按照图片还原为Excel文件')).toContain('create_document');
    expect(taskToolCore(null, '把海报标题删掉')).not.toContain('prepare_file_trash');
  });
});
