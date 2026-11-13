import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFileStore } from './fileStore.mjs';
import { currentUser } from './userScope.mjs';
import { createStudioLibrary } from '../src/agent/studioLibrary.js';
import * as ws from '../src/agent/workspace.js';
import { STUDIO_EXTENSIONS, STUDIO_LIMITS } from '../src/core/studioData.js';
import { renderOffice } from './officeRender.mjs';

const failure = (message, status = 400) => Object.assign(new Error(message), { status, code: 'STUDIO_SHARE' });
/** 共享是显式文件快照，不暴露私人路径/对话。全服务器最多100份、合计200MB；仅发布者可撤回。 */
export function createStudioRoutes({ dataDir, readJson, json, activeUser = () => true }) {
  const personal = createStudioLibrary();
  const shared = createFileStore(path.join(dataDir, 'studio-shared'));
  let queue = Promise.resolve();
  let pending = 0;
  function serial(work) {
    if (pending >= 16) throw failure('共享操作繁忙，请稍后再试', 429);
    pending++;
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next.finally(() => {
      pending--;
    });
  }
  const metadata = (row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    fileName: row.fileName,
    size: row.size,
    at: row.at,
    mine: row.owner === currentUser(),
    permission: row.owner === currentUser() ? 'owner' : 'read-copy'
  });
  async function find(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw failure('共享编号无效');
    const row = await shared.get('files', id);
    if (!row || !activeUser(row.owner)) throw failure('作品已撤回或不可访问', 404);
    return row;
  }
  async function team(req, res, suffix) {
    if (!suffix && req.method === 'GET') {
      const rows = (await shared.all('files')).filter((row) => activeUser(row.owner)).sort((a, b) => b.at - a.at);
      json(res, 200, rows.map(metadata));
    } else if (!suffix && req.method === 'POST') {
      const body = await readJson(req, 4096);
      if (body.confirm !== true) throw failure('发布前须确认本服务器成员可查看和复制此文件');
      if (!STUDIO_EXTENSIONS.test(body.path || '') || !['work', 'template'].includes(body.kind)) throw failure('共享文件或类型无效');
      const owner = currentUser();
      await serial(async () => {
        const blob = await ws.readBlob(body.path);
        if (!blob.size || blob.size > STUDIO_LIMITS.fileBytes) throw failure('共享文件须非空且不超过20MB');
        const rows = await shared.all('files');
        if (rows.length >= 100 || rows.reduce((sum, x) => sum + x.size, 0) + blob.size > 200 * 1024 * 1024)
          throw failure('团队共享空间已满，请撤回不用的作品', 409);
        const row = {
          id: randomUUID(),
          owner,
          kind: body.kind,
          title: String(body.title || '共享作品')
            .trim()
            .slice(0, 100),
          fileName: String(body.path).split('/').pop().slice(-150),
          size: blob.size,
          at: Date.now(),
          data: blob
        };
        await shared.put('files', row);
        json(res, 201, metadata(row));
      });
    } else if (suffix.endsWith('/copy') && req.method === 'POST') {
      const row = await find(suffix.slice(0, -5));
      // 新文件名由服务器生成，不能覆盖本人原稿；共享元信息不能指定别人的存储路径。
      const fileName = row.fileName.replace(/[\\/\u0000-\u001f]/g, '_');
      const result = await ws.write(`团队导入/${randomUUID()}-${fileName}`, row.data);
      json(res, 200, result);
    } else if (suffix && req.method === 'DELETE') {
      await serial(async () => {
        const row = await find(suffix);
        if (row.owner !== currentUser()) throw failure('只有发布者可以撤回共享', 403);
        await shared.delete('files', row.id);
        json(res, 200, { ok: true });
      });
    } else {
      json(res, 405, { error: '不支持此共享操作' });
    }
  }
  return async (req, res, pathname, url) => {
    if (!pathname.startsWith('/api/studio/')) return false;
    try {
      const route = pathname.slice('/api/studio/'.length);
      if (route === 'preview' && req.method === 'POST') {
        const body = await readJson(req, 2048);
        const kind = ws.ext(body.path);
        if (!['docx', 'pptx', 'xlsx'].includes(kind)) throw failure('此预览支持Word、PPT和Excel');
        const controller = new AbortController();
        const stop = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once('close', stop);
        try {
          const result = await renderOffice(await ws.readBlob(body.path), kind, { signal: controller.signal });
          if (!result.available) throw failure(result.reason, 503);
          if (!res.destroyed) {
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
            res.end(Buffer.from(await result.blob.arrayBuffer()));
          }
        } finally {
          res.removeListener('close', stop);
        }
      } else if (route === 'team' || route.startsWith('team/')) await team(req, res, route.slice(5));
      else if (route === 'preferences' && req.method === 'GET') json(res, 200, await personal.preferences());
      else if (route === 'preferences' && req.method === 'PATCH') json(res, 200, await personal.change(await readJson(req, 8192)));
      else if (route === 'works' && req.method === 'GET') json(res, 200, await personal.list());
      else if (route === 'versions' && req.method === 'GET') json(res, 200, await personal.versions(url.searchParams.get('path') || ''));
      else if (['copy', 'edit', 'inspect'].includes(route) && req.method === 'POST') {
        const body = await readJson(req, 16384);
        json(res, 200, await personal[route](route === 'inspect' ? body.path : body));
      } else json(res, 405, { error: '不支持此作品操作' });
    } catch (error) {
      json(res, error.status || 400, { error: error.message, code: error.code || 'STUDIO_OPERATION' });
    }
    return true;
  };
}
