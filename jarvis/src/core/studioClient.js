/** 共用已有鉴权客户端；不增加凭据、不保存共享文件到浏览器缓存。 */
export function createStudioClient(request) {
  const root = '/api/studio/';
  return {
    preferences: () => request(root + 'preferences'),
    change: (body) => request(root + 'preferences', { method: 'PATCH', body }),
    list: () => request(root + 'works'),
    versions: (path) => request(root + 'versions?path=' + encodeURIComponent(path)),
    inspect: (path) => request(root + 'inspect', { method: 'POST', body: { path }, timeout: 60000 }),
    async preview(path, signal) {
      const response = await request(root + 'preview', { method: 'POST', body: { path }, timeout: 60000, raw: true, binary: true, signal });
      if (!response.ok) throw new Error('真实预览暂不可用，请检查服务器Office渲染能力或下载原件查看');
      return response.blob();
    },
    copy: (body) => request(root + 'copy', { method: 'POST', body, timeout: 60000 }),
    edit: (body) => request(root + 'edit', { method: 'POST', body, timeout: 60000 }),
    team: () => request(root + 'team'),
    share: (body) => request(root + 'team', { method: 'POST', body, timeout: 60000 }),
    importShared: (id) => request(root + 'team/' + encodeURIComponent(id) + '/copy', { method: 'POST', body: {}, timeout: 60000 }),
    unshare: (id) => request(root + 'team/' + encodeURIComponent(id), { method: 'DELETE' })
  };
}
