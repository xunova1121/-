import { createAgentRegistry } from '../src/agent/agentProfiles.js';
import { MAX_PROFILE_BYTES } from '../src/agent/agentProfileValidation.js';

/** 仅在serverMode鉴权并进入成员存储范围后调用；不接受客户端指定归属身份。 */
export function createAgentProfileRoutes({ readJson, json }) {
  const profiles = createAgentRegistry();
  return async (req, res, pathname, url) => {
    if (pathname !== '/api/agent-profiles' && !pathname.startsWith('/api/agent-profiles/')) return false;
    try {
      if (pathname === '/api/agent-profiles') {
        if (req.method === 'GET') json(res, 200, await profiles.listAgents({ category: url.searchParams.get('category') || undefined, query: url.searchParams.get('query') || '' }));
        else if (req.method === 'POST') json(res, 201, await profiles.createAgent(await readJson(req, MAX_PROFILE_BYTES * 2)));
        else json(res, 405, { error: '此接口支持GET和POST' });
        return true;
      }
      const id = pathname.slice('/api/agent-profiles/'.length);
      if (req.method === 'GET') {
        const profile = await profiles.getAgent(id);
        json(res, profile ? 200 : 404, profile || { error: '没有找到此智能体', code: 'AGENT_PROFILE_NOT_FOUND' });
      } else if (req.method === 'PUT') json(res, 200, await profiles.updateAgent(id, await readJson(req, MAX_PROFILE_BYTES * 2)));
      else if (req.method === 'DELETE') json(res, 200, await profiles.removeAgent(id));
      else json(res, 405, { error: '此接口支持GET、PUT和DELETE' });
    } catch (error) {
      if (error.name !== 'ValidationError') throw error;
      json(res, error.status || 400, { error: error.message, code: error.code, field: error.field });
    }
    return true;
  };
}
