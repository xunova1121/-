import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvaluationAccess, evaluationAdapter, chargeSearchRequest } from '../server/evaluationAccess.mjs';
import { createAccessSecurity } from '../server/accessSecurity.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { createServer } from '../server/server.mjs';
import { useBackend } from '../src/agent/store.js';
import { evaluationTools } from '../server/evaluation.mjs';
import { evidence } from '../src/agent/evidenceStore.js';

const directories = [];
afterEach(() => { useBackend(null); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const folder = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-evaluation-access-')); directories.push(directory); return directory; };
const localRequest = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

describe('评测授权的存储与费用隔离', () => {
  it('同名对话证据缓存也分范围，评测刷盘不会带走正常查询的待存正文', async () => {
    const dataDir = folder(), security = createAccessSecurity({ dataDir, password: 'fixture-six' });
    const base = createFileStore(path.join(dataDir, 'store'));
    const access = createEvaluationAccess({ store: base, dataDir, security });
    useBackend(access.store);
    const sources = [{ url: 'https://example.com/user-evidence', title: '用户来源', text: '用户私有查询正文' }];
    const ids = await evidence.put('same-session', { sources });
    const task = { evaluationId: 'ev_fixture_isolated_evidence', evaluationAuthorization: { id: 'not-used-for-model' } };
    await access.run(task, async () => {
      expect(await evidence.get('same-session', ids[0])).toBeNull();
      await evidence.put('same-session', { sources: [{ url: 'https://example.com/eval-evidence', text: '隔离评测正文' }] });
      await evidence.flush();
      expect(JSON.stringify(await access.store.get('kv', 'evidence:same-session'))).not.toContain('用户私有查询正文');
    });
    await evidence.flush();
    expect(JSON.stringify(await base.get('kv', 'evidence:same-session'))).toContain('用户私有查询正文');
    expect(JSON.stringify(await base.get('kv', 'evidence:same-session'))).not.toContain('隔离评测正文');
  });
  it('异步交错时用户文件、kv和技能不泄露，评测会话仍由原列表规则隐藏', async () => {
    const dataDir = folder(), password = 'fixture-six';
    const security = createAccessSecurity({ dataDir, password });
    const session = security.login(localRequest, password);
    const principal = security.authenticate({ ...localRequest, url: '/', headers: { authorization: 'Bearer ' + session.token } });
    const evaluation = security.issueEvaluation(principal);
    const base = createFileStore(path.join(dataDir, 'store'));
    const access = createEvaluationAccess({ store: base, dataDir, security });
    await base.put('files', { id: 'user.txt', value: '用户原文件' });
    await base.put('kv', { id: 'preference', value: '用户偏好' });
    await base.put('packs', { id: 'private-pack', builtin: false, value: '用户技能' });
    await base.put('packs', { id: 'builtin-pack', builtin: true });
    const task = { evaluationId: 'ev_fixture_case1', evaluationAuthorization: { id: evaluation.id } };
    await Promise.all([
      access.run(task, async () => {
        await Promise.resolve();
        expect(await access.store.get('files', 'user.txt')).toBeUndefined();
        expect(await access.store.get('kv', 'preference')).toBeUndefined();
        expect(await access.store.get('packs', 'private-pack')).toBeUndefined();
        expect(await access.store.all('packs')).toEqual([{ id: 'builtin-pack', builtin: true }]);
        await access.store.put('files', { id: 'eval.txt', value: '私有评测结果' });
        await access.store.put('kv', { id: 'preference', value: '评测临时偏好' });
        await expect(access.store.put('packs', { id: 'private-pack', value: '覆盖' })).rejects.toMatchObject({ status: 403 });
        await expect(access.store.clear('sessions')).rejects.toMatchObject({ status: 403 });
      }),
      access.run({}, async () => {
        await Promise.resolve();
        expect(await access.store.get('files', 'user.txt')).toMatchObject({ value: '用户原文件' });
        expect(await access.store.get('files', 'eval.txt')).toBeUndefined();
      })
    ]);
    expect(await base.get('files', 'eval.txt')).toBeUndefined();
    expect(await base.get('kv', 'preference')).toMatchObject({ value: '用户偏好' });
    await access.run(task, async () => expect(await access.store.get('files', 'eval.txt')).toMatchObject({ value: '私有评测结果' }));
    await access.run({ ...task, evaluationId: 'ev_fixture_case2' }, async () => expect(await access.store.get('files', 'eval.txt')).toBeUndefined());
  });
  it('模型、重试和搜索请求均在执行前扣额度，超额不调用上游', async () => {
    const dataDir = folder(), security = createAccessSecurity({ dataDir, password: 'fixture-six' });
    const session = security.login(localRequest, 'fixture-six');
    const principal = security.authenticate({ ...localRequest, url: '/', headers: { authorization: 'Bearer ' + session.token } });
    const evaluation = security.issueEvaluation(principal, { dailyLimit: 3 });
    const access = createEvaluationAccess({ store: createFileStore(path.join(dataDir, 'store')), dataDir, security });
    let upstream = 0;
    const adapter = evaluationAdapter({ stream: async options => { upstream++; options.onRetry?.({ attempt: 1 }); return { text: '夹具回答' }; } });
    await access.run({ evaluationId: 'ev_fixture_case', evaluationAuthorization: { id: evaluation.id } }, async () => {
      await adapter.stream({}); // 本次模型+一次内部重试=2。
      chargeSearchRequest('https://qianfan.baidubce.com/v2/ai_search/web_search');
      await expect(adapter.stream({})).rejects.toMatchObject({ status: 429, code: 'EVAL_QUOTA' });
      expect(() => chargeSearchRequest('https://www.baidu.com/s?wd=fixture')).toThrow(/今日/);
    });
    expect(upstream).toBe(1);
    expect(security.overview(principal).evaluations[0].today).toBe(3);
  });
  it('受限评测移除定时、持仓与技能安装工具；主人原评测保持兼容', () => {
    const names = ['web_search', 'create_document', 'read_file', 'schedule_task', 'list_schedules', 'update_schedule', 'cancel_schedule', 'install_skill', 'add_holding', 'list_holdings'];
    const tools = names.map(name => ({ name }));
    expect(evaluationTools(tools, 'fixture', true).map(tool => tool.name)).toEqual(['web_search', 'create_document', 'read_file']);
    expect(evaluationTools(tools, 'fixture').map(tool => tool.name)).toEqual(names);
  });
});

describe('真实HTTP的评测令牌权限', () => {
  it('每种管理资源403、强制评测编号、跨令牌/正式会话403且不污染用户列表', async () => {
    const dataDir = folder(), tasks = new Map();
    let mode;
    const runner = {
      running: 0, list: () => [...tasks.values()], get: id => tasks.get(id),
      start: async value => {
        const id = 'task_' + tasks.size, sessionId = value.sessionId || 'session_' + tasks.size;
        const task = { id, sessionId, evaluationId: value.evaluationId, status: 'done' };
        await mode.store.put('sessions', { id: sessionId, messages: [{ role: 'user', content: value.text }], evaluationId: value.evaluationId });
        tasks.set(id, task);
        return task;
      },
      events: () => [{ type: 'task_state', status: 'done', seq: 1 }],
      stop: () => true
    };
    mode = createServerMode({ dataDir, password: 'fixture-six', runner });
    await mode.ready;
    const server = createServer({ serverMode: mode, ollama: null });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (url, token, method = 'GET', body) => fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
    try {
      const ownerToken = (await (await api('/api/server/login', '', 'POST', { password: 'fixture-six' })).json()).token;
      expect((await api('/api/health?token=' + ownerToken, '')).status).toBe(401);
      expect((await api('/api/server/login?token=' + ownerToken, '', 'POST', { password: 'fixture-six' })).status).toBe(401);
      await api('/api/files/raw?path=private.txt', ownerToken, 'PUT', { fixture: true });
      const resource = '/api/files/raw?path=private.txt';
      const ticket = await (await api('/api/server/security/tickets', ownerToken, 'POST', { resource })).json();
      expect((await api(resource + '&ticket=' + ticket.ticket, '')).status).toBe(200);
      expect((await api(resource + '&ticket=' + ticket.ticket, '')).status).toBe(401);
      const issue = async () => (await api('/api/server/security/evaluations', ownerToken, 'POST', { name: '仅测试夹具' })).json();
      const a = await issue(), b = await issue();
      for (const [url, method] of [
        ['/api/server/config', 'GET'], ['/api/server/config', 'PUT'], ['/api/server/security', 'GET'],
        ['/api/server/memory-status', 'GET'], ['/api/server/document-styles', 'GET'],
        ['/api/files', 'GET'], ['/api/files/raw?path=user.txt', 'GET'], ['/api/files/raw?path=user.txt', 'PUT'],
        ['/api/server/code-repos', 'GET'], ['/api/server/code-projects?session=normal', 'GET'],
        ['/api/server/update', 'GET'], ['/api/server/update', 'POST'],
        ['/api/server/security/evaluations', 'POST'], ['/api/server/security/tickets', 'POST'],
        ['/api/server/schedules', 'GET'], ['/api/server/schedules', 'POST'],
        ['/api/llm/openai/chat/completions', 'POST'], ['/api/server/pc-model', 'POST'],
        ['/api/server/status', 'GET'], ['/api/server/search-test', 'POST']
      ]) expect((await api(url, a.token, method)).status, url + ' ' + method).toBe(403);
      const task = await (await api('/api/tasks', a.token, 'POST', { text: '夹具任务', evaluationId: 'client_scope' })).json();
      expect(task.evaluationId).toMatch(new RegExp('^ev_' + a.id + '_'));
      expect(task.evaluationId).not.toBe('client_scope');
      const continued = await (await api('/api/tasks', a.token, 'POST', { text: '继续', sessionId: task.sessionId })).json();
      expect(continued.evaluationId).toBe(task.evaluationId);
      expect((await api('/api/tasks/' + task.id, a.token)).status).toBe(200);
      expect((await api('/api/tasks/' + task.id + '/events', a.token)).status).toBe(200);
      expect((await api('/api/tasks/' + task.id, b.token)).status).toBe(403);
      expect((await api('/api/sessions/' + task.sessionId, b.token)).status).toBe(403);
      await mode.store.put('sessions', { id: 'normal', messages: [{ role: 'user', content: '私人对话' }] });
      expect((await api('/api/sessions/normal', a.token)).status).toBe(403);
      expect((await api('/api/tasks', a.token, 'POST', { sessionId: 'normal', text: '非法接入' })).status).toBe(403);
      const visible = await (await api('/api/sessions', ownerToken)).json();
      expect(visible.map(row => row.id)).toEqual(['normal']);
      expect((await (await api('/api/sessions', a.token)).json()).map(row => row.id)).toEqual([task.sessionId]);
      expect((await api('/api/sessions?token=' + ownerToken, '')).status).toBe(401);
      await api('/api/server/security/evaluations/' + a.id, ownerToken, 'DELETE');
      expect((await api('/api/tasks/' + task.id, a.token)).status).toBe(401);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
