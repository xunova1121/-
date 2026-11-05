/** 共用服务器客户端的登录、超时和网络错误处理；不新存凭据，不缓存个人配置。 */
export function createAgentProfileClient(request) {
  const root = '/api/agent-profiles';
  const target = id => root + '/' + encodeURIComponent(id);
  return {
    listAgents({ category, query } = {}) {
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      if (query) params.set('query', query);
      return request(root + (params.size ? '?' + params : ''));
    },
    getAgent: id => request(target(id)).catch(error => { if (error.status === 404 && error.code === 'AGENT_PROFILE_NOT_FOUND') return null; throw error; }),
    createAgent: value => request(root, { method: 'POST', body: value }),
    updateAgent: (id, value) => request(target(id), { method: 'PUT', body: value }),
    removeAgent: id => request(target(id), { method: 'DELETE' })
  };
}
