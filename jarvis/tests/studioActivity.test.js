import { describe, it, expect, vi } from 'vitest';
import { createStudioActivity } from '../src/app/studioActivity.js';
import { stationForStep } from '../src/ui/workshopMotion.js';

const turn = (id = 'local') => ({ session: { id, messages: [] }, files: new Set() });
const open = (id, name, args = {}) => ({ type: 'tool_start', id, name, args });
const close = (id, name, ok) => ({ type: 'tool_end', id, name, ok });

describe('工作室动作记录', () => {
  it('按实际工具标记取资料、制作、检验工位，读取失败和旧记录保留相同工位', () => {
    const feed = createStudioActivity(), t = turn();
    const tools = ['read_file', 'list_files', 'web_search', 'write_file', 'inspect_image', 'check_writing'];
    const stations = ['archive', 'archive', 'archive', 'bench', 'review', 'review'];
    feed.begin(t);
    tools.forEach((name, i) => {
      feed.record(t, open(name, name));
      expect(feed.snapshot(t.session).entries.at(-1).station).toBe(stations[i]);
      feed.record(t, close(name, name, i !== 0));
      expect(feed.snapshot(t.session).entries.at(-1).station).toBe(stations[i]);
    });
    feed.record(t, { type: 'server_tool', name: 'deepseek_read_url' });
    expect(feed.snapshot(t.session).entries.at(-1).station).toBe('archive');
    feed.record(t, { type: 'team_review', pass: false });
    expect(feed.snapshot(t.session).entries.at(-1)).toMatchObject({ pose: 'stomp', station: 'review' });
    const restored = feed.snapshot({ id: 'saved', messages: [{ role: 'assistant', tools, failures: [{ tool: 'read_file' }] }] });
    expect(restored.entries.slice(0, -1).map(step => step.station)).toEqual([...stations.slice(1), 'archive']);
  });

  it('普通问答只呈现思考和写回复，工具和复核回执分别提供找文件、执笔、键盘的证据', () => {
    const feed = createStudioActivity(), t = turn();
    const last = () => feed.snapshot(t.session).entries.at(-1);
    feed.begin(t);
    expect(last().operation).toBeUndefined();
    feed.record(t, { type: 'text', delta: '你好' });
    expect(last()).toMatchObject({ operation: 'write', title: '正在写回复' });
    for (const [tool, station, operation] of [
      ['read_file', 'archive', 'archive'], ['write_file', 'bench', 'write'],
      ['computer_read_file', 'review', 'type'], ['computer_click', 'review', 'type'],
      ['code_run', 'review', 'type'], ['verify_delivery', 'review', 'type']
    ]) {
      feed.record(t, open(tool, tool));
      expect(last()).toMatchObject({ station, operation, status: 'running' });
      feed.record(t, close(tool, tool, true));
      expect(last()).toMatchObject({ station, operation, status: 'done' });
    }
    feed.record(t, open('unknown', 'mcp_internal'));
    expect(last().operation).toBeUndefined();
    feed.record(t, { type: 'team_review', pass: true });
    expect(last()).toMatchObject({ station: 'review', operation: 'type', status: 'done' });
    feed.finish(t, 'done');
    expect(last().operation).toBeUndefined();
    const saved = feed.snapshot({ id: 'history', messages: [{ role: 'assistant', content: '已完成', tools: ['computer_click', 'write_file'] }] });
    expect(saved.entries.map(x => x.operation)).toEqual(['type', 'write', undefined]);
  });

  it('正常收尾、错误和停止留在当前工位，真实复核才进入检验台', () => {
    const write = { pose: 'edit', status: 'done', station: 'bench' };
    const review = { pose: 'think', status: 'done', station: 'review' };
    const finish = { pose: 'cheer', status: 'done' };
    expect(stationForStep([finish], 0)).toBe('rest');
    for (const end of [finish, { pose: 'stomp', status: 'error' }, { pose: 'stop', status: 'stopped' }]) {
      expect(stationForStep([write, end], 1)).toBe('bench');
      expect(stationForStep([write, review, end], 2)).toBe('review');
    }
  });

  it('只按实际事件切换动作，文本分片不重复刷新，恢复需要真实重试信号', () => {
    const feed = createStudioActivity(), t = turn(), changes = vi.fn();
    const unsubscribe = feed.subscribe(changes);
    expect(feed.snapshot(t.session)).toEqual({ sessionId: 'local', active: false, entries: [] });
    feed.begin(t);
    feed.record(t, { type: 'state', value: 'processing' });
    feed.record(t, open('1', 'web_search', { query: '私人搜索词' }));
    const search = feed.snapshot(t.session).entries.at(-1);
    expect(search).toMatchObject({ pose: 'run', title: '联网搜索', status: 'running' });
    feed.record(t, { ...close('1', 'web_search', false), output: '私人错误正文' });
    expect(feed.snapshot(t.session).entries.at(-1)).toMatchObject({ id: search.id, pose: 'stomp', status: 'error' });
    feed.record(t, { type: 'retry', attempt: 2 });
    feed.record(t, open('2', 'code_edit', { path: 'src/天气.js', content: '保密代码' }));
    feed.record(t, close('2', 'code_edit', true));
    feed.record(t, { type: 'text', delta: '私密回复' });
    const count = changes.mock.calls.length;
    for (let i = 0; i < 100; i++) feed.record(t, { type: 'text', delta: '私密回复' });
    expect(changes).toHaveBeenCalledTimes(count);
    feed.record(t, { type: 'file', path: 'out/天气.js' });
    t.files.add('out/天气.js');
    feed.finish(t, 'done');
    const { entries, active } = feed.snapshot(t.session);
    expect(active).toBe(false);
    expect(entries.map((e) => e.pose)).toEqual(['think', 'stomp', 'repair', 'edit', 'edit', 'edit', 'cheer']);
    expect(entries.filter((e) => e.title === '工作区文件')).toHaveLength(1);
    expect(entries.find((e) => e.title === '修改代码')).toMatchObject({ file: '天气.js', status: 'done' });
    expect(JSON.stringify(entries)).not.toMatch(/私密|私人|保密|src\//);
    unsubscribe();
    const before = changes.mock.calls.length;
    feed.changed();
    expect(changes).toHaveBeenCalledTimes(before);
  });

  it('人像修改只得到失败回执时保留错误，重新修图成功后展示成果并正常收尾', () => {
    const feed = createStudioActivity(), failed = turn();
    const attempt = (t, id, ok) => {
      feed.record(t, open(id, 'process_image', { path: '原片/人像.png' }));
      feed.record(t, close(id, 'process_image', ok));
    };
    feed.begin(failed);
    attempt(failed, 'edit-1', false);
    feed.record(failed, { type: 'text', delta: '未能生成修改后的照片' });
    feed.finish(failed, 'done');
    expect(feed.snapshot(failed.session).entries.at(-1)).toMatchObject({ pose: 'stomp', status: 'error', title: '已回复，仍有步骤未完成' });
    const fixed = turn('second');
    feed.begin(fixed);
    attempt(fixed, 'edit-1', false);
    feed.record(fixed, { type: 'retry' });
    attempt(fixed, 'edit-2', true);
    fixed.files.add('成品/人像修图.png');
    feed.finish(fixed, 'done');
    const entries = feed.snapshot(fixed.session).entries;
    expect(entries.at(-2)).toMatchObject({ file: '人像修图.png', status: 'done' });
    expect(entries.at(-1)).toMatchObject({ pose: 'cheer', status: 'done' });
  });

  it('云端回放去重，异步检索预算自然收尾，观察中断等待新回执', () => {
    const feed = createStudioActivity(), t = turn();
    t.remoteId = t.session.taskId = 'job';
    feed.begin(t, { resume: true });
    const first = { ...open('r', 'fetch_url', { url: 'https://secret' }), seq: 1 };
    feed.record(t, first);
    feed.record(t, first);
    feed.record(t, { ...close('r', 'fetch_url', false), seq: 2, code: 'RETRIEVAL_BUDGET' });
    expect(feed.snapshot(t.session).entries.map((e) => e.title)).toEqual(['接上服务器任务']);
    feed.record(t, { type: 'server_connection', state: 'reconnecting' });
    feed.finish(t, 'waiting');
    expect(feed.snapshot(t.session).entries.at(-1)).toMatchObject({ status: 'waiting', pose: 'stop' });
    const fresh = { id: 'local', taskCheckpoint: { taskId: 'job', status: 'done' }, messages: [{ role: 'assistant', content: '完毕' }] };
    expect(feed.snapshot(fresh).entries.at(-1).title).toBe('已保存回复');
  });

  it('同时进行的两段会话和同一会话的后一次请求分别归属，旧回执不能覆盖', () => {
    const feed = createStudioActivity(), a = turn('A'), b = turn('B');
    feed.begin(a);
    feed.begin(b);
    feed.record(a, open('read', 'read_file', { path: '目录/合同.docx' }));
    expect(feed.snapshot(b.session).entries).toHaveLength(1);
    const next = { ...a };
    feed.begin(next);
    feed.record(a, close('read', 'read_file', false));
    feed.finish(a, 'stopped');
    feed.finish(b, 'stopped');
    expect(feed.snapshot(next.session).active).toBe(true);
    expect(feed.snapshot(next.session).entries).toHaveLength(1);
    expect(feed.snapshot(b.session).entries.at(-1)).toMatchObject({ status: 'stopped', pose: 'stop' });
    feed.finish(next, 'error');
    feed.forget(next.session);
    expect(feed.snapshot(next.session).entries).toEqual([]);
  });

  it('隔离同一编号在不同账号下的会话，同时拒绝原账号旧对象', () => {
    const owner = {}, other = {};
    let scope = owner;
    const feed = createStudioActivity({ scope: () => scope }), a = turn();
    feed.begin(a);
    feed.record(a, open('file', 'read_file', { path: '目录/合同.docx' }));
    scope = other;
    expect(feed.snapshot(a.session).entries).toEqual([]);
    expect(feed.snapshot({ id: 'local', messages: [] }).entries).toEqual([]);
    scope = owner;
    expect(feed.snapshot(a.session).entries.at(-1).file).toBe('合同.docx');
  });

  it('历史仅恢复最近回复留下的工具/失败/文件，拦住工具入参、凭证和未完成伪报', () => {
    const feed = createStudioActivity();
    const secret = 'sk-very-PRIVATE-secret';
    const user = { role: 'user', content: secret };
    const answer = { role: 'assistant', content: secret + '（已打断）', tools: ['read_file', 'process_image', secret],
      files: ['原目录/草稿.pptx', '.env', 'credentials.txt', secret + '.txt', 'https://u:p@example.com/test.pdf'],
      failures: [{ tool: 'process_image', error: secret }] };
    const s = { id: 'old', messages: [user, answer] };
    const { entries } = feed.snapshot(s);
    expect(entries.map((e) => e.pose)).toEqual(['think', 'run', 'stomp', 'edit', 'stop']);
    expect(entries.at(-1).status).toBe('stopped');
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE|原目录|credential|\.env|https/);
    expect(feed.snapshot({ ...s, messages: [...s.messages, user] }).entries).toEqual([]);
    expect(feed.snapshot({ ...s, taskId: 'new-job' }).entries).toEqual([]);
    const t = turn();
    feed.begin(t);
    feed.record(t, open('id-' + secret, 'mcp_' + secret, { path: secret + '.js', content: secret }));
    expect(JSON.stringify(feed.snapshot(t.session))).not.toContain(secret);
  });

  it('对长任务限制记录条数，忽略已经结束的轮次，重新加载更新的回合', () => {
    const feed = createStudioActivity(), t = turn();
    feed.begin(t);
    for (let i = 0; i < 100; i++) {
      feed.record(t, open('s' + i, 'web_search'));
      feed.record(t, close('s' + i, 'web_search', true));
    }
    feed.finish(t, 'done');
    const end = feed.snapshot(t.session);
    expect(end.entries).toHaveLength(48);
    feed.record(t, { type: 'retry' });
    expect(feed.snapshot(t.session)).toEqual(end);
    const newer = { ...t.session, messages: [{ role: 'assistant', ts: Date.now() + 50, tools: ['write_file'] }] };
    expect(feed.snapshot(newer).entries[0].title).toBe('写入文件');
  });
});
