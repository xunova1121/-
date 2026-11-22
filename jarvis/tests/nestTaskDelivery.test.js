import { describe, expect, it } from 'vitest';
import { lastTaskReceipt, sameTaskReceipt, verifiedTaskFiles } from '../src/app/nestTaskDelivery.js';
import { noteTaskFile, taskFileDelivery } from '../src/agent/taskFileReceipts.js';
import * as workspace from '../src/agent/workspace.js';

const place = 'local:virtual';
const row = (path, mtime = 150, size = 20) => ({ path, mtime, size });
const answer = (files, ts = 200) => ({ role: 'assistant', ts, files });
const session = (id, message, files = []) => ({ id, messages: [{ role: 'user', ts: 100, files }, message] });
const receipt = (s, scope = 'alice') => lastTaskReceipt(s, scope, place);
const result = (s, files) => verifiedTaskFiles(receipt(s), files).map(f => f.path);

describe('书桌本轮交付', () => {
  it('按会话的完整路径区分同名文件，上传、过程、空文件、回收站与口头提到的路径不计入', () => {
    const paths = ['甲/简报.docx', '乙/简报.docx', '上传/原件.docx', '导入/原件.docx', '.workflows/posters/internal.json', '空.txt', '回收.txt'];
    const files = [...paths.map(p => row(p)), row('只写在正文.docx')];
    files.at(-3).size = 0;
    files.at(-2).inTrash = true;
    const a = session('a', { ...answer(paths.filter(p => p !== paths[1])), content: '见只写在正文.docx' }, [{ path: paths[3] }]);
    const b = session('b', answer([paths[1]]));
    expect(result(a, files)).toEqual([paths[0]]);
    expect(result(b, files)).toEqual([paths[1]]);
    expect(sameTaskReceipt(receipt(a), receipt(b))).toBe(false);
    expect(sameTaskReceipt(receipt(a), receipt(a, 'bob'))).toBe(false);
  });
  it('工作区同一路径被覆盖时验证实际写入版本，两次同大小写入也能区分', async () => {
    const path = '复验/同名.docx';
    const a = { fileScope: place }, b = { fileScope: place };
    await workspace.write(path, 'a');
    noteTaskFile(a, workspace.lastFileWrite(path));
    const first = session('first', { ...answer([path]), ...taskFileDelivery(a) });
    expect(result(first, await workspace.list())).toEqual([path]);
    await workspace.write(path, 'b');
    noteTaskFile(b, workspace.lastFileWrite(path));
    const second = session('second', { ...answer([path]), ...taskFileDelivery(b) });
    expect(result(first, await workspace.list())).toEqual([]);
    expect(result(second, await workspace.list())).toEqual([path]);
    expect(lastTaskReceipt(second, 'server', 'server')).toBeNull();
    expect(lastTaskReceipt(second, 'directory', 'local:folder:another')).toBeNull();
  });
  it('兼容旧消息时只接受本轮时间内的实际写入，新的用户发言、恢复中或中断回复清空上轮结果', () => {
    const s = session('a', answer(['旧文件', '本轮', '后来覆盖']));
    expect(result(s, [row('旧文件', 99), row('本轮'), row('后来覆盖', 201)])).toEqual(['本轮']);
    expect(lastTaskReceipt(s, 'folder', 'local:folder:old')).toBeNull();
    expect(receipt({ ...s, taskId: 'pending' })).toBeNull();
    expect(receipt(session('a', { ...answer(['本轮']), draftOf: 'pending' }))).toBeNull();
    expect(receipt(session('a', { ...answer(['本轮']), content: '部分输出\n（已打断）' }))).toBeNull();
    s.messages.push({ role: 'user', ts: 201, content: '新问题' });
    expect(receipt(s)).toBeNull();
  });
  it('没有当前版本回执的新版任务不能把其他任务的同名成品充作交付', () => {
    const turn = { fileScope: place };
    const s = session('a', { ...answer(['计划.docx']), ...taskFileDelivery(turn) });
    expect(result(s, [row('计划.docx')])).toEqual([]);
  });
});
