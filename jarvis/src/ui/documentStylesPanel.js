/** 与模型工作台同一配置位置；异步操作固定原位置，切换页签不删除另一端偏好。 */
export function documentStylesPanel({ workspace, node }) {
  const target = workspace.scope;
  const list = node('ul', { className: 'ml-style-list' });
  const message = node('p', { className: 'ml-muted', role: 'status' });
  const load = node('button', { type: 'button', className: 'ml-button', textContent: '查看写作偏好' });
  const paint = async () => {
    const items = await workspace.documentStyles(target);
    list.replaceChildren(...items.slice(0, 30).map(item => {
      const remove = node('button', { type: 'button', className: 'ml-link', textContent: '删除偏好' });
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await workspace.deleteDocumentStyle(item.id, target);
          await paint();
        } catch (error) {
          message.textContent = error.message;
          remove.disabled = false;
        }
      });
      return node('li', {}, node('span', { textContent: String(item.content).slice(0, 180) }), remove);
    }));
    message.textContent = items.length ? `${items.length} 条，最多30条；本次要求优先于历史偏好。` : '还没有写作偏好。可说“以后文档要简洁一些”或“以后Word使用宋体”。';
  };
  load.addEventListener('click', async () => {
    load.disabled = true;
    try {
      await paint();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      load.disabled = false;
    }
  });
  return node('details', { className: 'ml-copy' }, node('summary', { textContent: `写作偏好 · ${target === 'server' ? '云服务器' : '本机'}` }), load, message, list);
}
