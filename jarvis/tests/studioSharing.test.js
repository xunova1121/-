import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { createServerClient } from '../src/core/serverClient.js';
import { generate } from '../src/agent/docs.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
let dir, server, mode, base, a, b, ac, bc;
const ownerToken = tokenFor('fixture-studio-owner');
const api = (token, route, method = 'GET', body) =>
  fetch(base + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) })
  });
const json = async (...args) => {
  const r = await api(...args);
  expect(r.status).toBe(200);
  return r.json();
};
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-studio-http-'));
  mode = createServerMode({ dataDir: dir, password: 'fixture-studio-owner' });
  await mode.ready;
  server = createServer({ serverMode: mode });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  a = await json(ownerToken, '/api/server/users', 'POST', { name: '甲' });
  b = await json(ownerToken, '/api/server/users', 'POST', { name: '乙' });
  const al = await json('', '/api/server/login', 'POST', { password: a.accessCode });
  const bl = await json('', '/api/server/login', 'POST', { password: b.accessCode });
  ac = createServerClient({ base, token: al.token });
  bc = createServerClient({ base, token: bl.token });
});
afterAll(async () => {
  await mode?.runner.settled();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
it('真实客户端：同名文件、偏好和版本按成员隔离，异步并发不串人', async () => {
  await Promise.all([ac.upload('私密/same.txt', new Blob(['甲稿件'])), bc.upload('私密/same.txt', new Blob(['乙稿件']))]);
  await Promise.all([
    ac.studio.change({ action: 'favorite', id: 'ppt-maker', userId: b.id }),
    bc.studio.change({ action: 'brand', brand: { name: '乙单位' } })
  ]);
  expect((await ac.studio.preferences()).favorites).toEqual(['ppt-maker']);
  expect((await bc.studio.preferences()).favorites).toEqual([]);
  expect((await ac.studio.preferences()).brand.name).toBe('');
  expect((await bc.studio.preferences()).brand.name).toBe('乙单位');
  const [ca, cb] = await Promise.all([ac.studio.copy({ path: '私密/same.txt' }), bc.studio.copy({ path: '私密/same.txt' })]);
  expect(await (await ac.download(ca.path)).text()).toBe('甲稿件');
  expect(await (await bc.download(cb.path)).text()).toBe('乙稿件');
  await expect(bc.download(ca.path)).rejects.toThrow();
  expect((await bc.studio.list()).some((x) => x.path === ca.path)).toBe(false);
  expect((await bc.studio.versions('私密/same.txt')).some((x) => x.path === ca.path)).toBe(false);
});
it('共享需确认且只分享文件快照，成员仅复制，撤回不删除原件或已领取副本', async () => {
  await expect(ac.studio.share({ path: '私密/same.txt', kind: 'template' })).rejects.toThrow('确认');
  const shared = await ac.studio.share({ path: '私密/same.txt', title: '公共模板', kind: 'template', confirm: true, owner: b.id });
  await ac.upload('私密/same.txt', new Blob(['甲已改稿']));
  const rows = await bc.studio.team();
  expect(rows.find((x) => x.id === shared.id)).toMatchObject({ title: '公共模板', mine: false, permission: 'read-copy' });
  expect(JSON.stringify(rows)).not.toMatch(/私密|甲稿件|owner|sessionId/);
  await expect(bc.studio.unshare(shared.id)).rejects.toMatchObject({ status: 403 });
  const copied = await bc.studio.importShared(shared.id);
  expect(await (await bc.download(copied.path)).text()).toBe('甲稿件');
  await ac.studio.unshare(shared.id);
  await expect(bc.studio.importShared(shared.id)).rejects.toMatchObject({ status: 404 });
  expect(await (await ac.download('私密/same.txt')).text()).toBe('甲已改稿');
  expect(await (await bc.download(copied.path)).text()).toBe('甲稿件');
});
it('真实成员Word结构与修改HTTP往返不损坏二进制；预览是PDF或明确缺环境', async () => {
  const blob = (await generate('docx', { title: '文稿', content: '保留原稿内容。', toc: false })).blob;
  await ac.upload('报告.docx', blob);
  const inspection = await ac.studio.inspect('报告.docx');
  const result = await ac.studio.edit({ path: '报告.docx', sha256: inspection.sha256, replacements: [{ find: '保留原稿内容', replace: '修改后的内容' }] });
  expect(await (await openOfficePackage(await ac.download(result.path))).file('word/document.xml').async('string')).toContain('修改后的内容');
  expect(await (await openOfficePackage(await ac.download('报告.docx'))).file('word/document.xml').async('string')).toContain('保留原稿内容');
  // 无LibreOffice的开发/CI节点必须明确失败，不能返回假的PDF；有安装时核验真实文件头。
  const response = await api(ownerToken, '/api/studio/preview', 'POST', { path: '报告.docx' });
  expect(response.status).not.toBe(200); // 主人不能读取成员文件。
  const preview = await ac.studio.preview(result.path).then(
    (blob) => ({ blob }),
    (error) => ({ error })
  );
  if (preview.error) expect(preview.error.message).toContain('真实预览暂不可用');
  else expect(await preview.blob.slice(0, 5).text()).toBe('%PDF-');
}, 60000);
it('匿名和未知管理入口拒绝，路径穿越不能读取私人文件，停用发布者立即隐藏共享', async () => {
  const evaluation = await json(ownerToken, '/api/server/security/evaluations', 'POST', { name: '作品隔离夹具' });
  for (const [route, method] of [['/api/studio/team', 'GET'], ['/api/studio/team', 'POST'], ['/api/studio/preferences', 'GET'], ['/api/studio/edit', 'POST']]) {
    expect((await api(evaluation.token, route, method, method === 'POST' ? {} : undefined)).status).toBe(403);
  }
  expect((await api('', '/api/studio/team')).status).toBe(401);
  await expect(ac.studio.copy({ path: '../config.json' })).rejects.toThrow();
  await expect(ac.studio.copy({ path: '../私密/same.txt' })).rejects.toThrow();
  const share = await ac.studio.share({ path: '私密/same.txt', kind: 'work', confirm: true });
  await json(ownerToken, '/api/server/users/' + a.id, 'PATCH', { action: 'disable' });
  expect((await bc.studio.team()).some((x) => x.id === share.id)).toBe(false);
  await expect(bc.studio.importShared(share.id)).rejects.toMatchObject({ status: 404 });
});
