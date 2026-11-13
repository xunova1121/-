/** 只展示固定阶段和HTTP状态，不把地址、任务编号、查询或请求正文带进诊断。 */
export function serverRequestLabel(path) {
  const value = String(path || '').split('?')[0];
  const names = {
    '/api/health': '连接检查',
    '/api/server/status': '服务器状态',
    '/api/server/config': '模型设置',
    '/api/server/update': '服务器更新',
    '/api/server/pc-model': '电脑模型连接',
    '/api/server/auth/migrate': '登录换发',
    '/api/tasks': '提交任务',
    '/api/sessions': '对话列表',
    '/api/files/raw': '传输文件',
    '/api/agent-profiles': '智能体列表'
  };
  if (names[value]) return names[value];
  if (/^\/api\/tasks\/[^/]+\/events$/.test(value)) return '接收回答';
  if (/^\/api\/tasks\/[^/]+$/.test(value)) return '任务状态';
  if (/^\/api\/sessions\/[^/]+$/.test(value)) return '打开对话';
  return '服务器请求';
}

export function serverRequestDiagnostic(receipt) {
  if (receipt.ok) return '成功';
  if (Number.isInteger(receipt.status) && receipt.status >= 400) return `HTTP ${receipt.status}`;
  return receipt.kind === 'timeout' ? '等待超时' : '未收到可读取的响应';
}

export const OBSERVATION_LOST_TEXT = '暂时无法接收回答，已暂停自动重连。任务已经提交，服务器可能仍在执行；请恢复连接后打开原对话查看结果，避免重复发送。';

export function serverTaskMayBeRunning(error) {
  const receipt = error?.requestTiming;
  return error?.code === 'TASK_OBSERVATION_LOST' || Boolean(
    receipt?.path === '/api/tasks' && receipt.method === 'POST' && !receipt.status && ['network', 'timeout'].includes(receipt.kind)
  );
}

export function serverRequestErrorText(error) {
  if (error?.code === 'TASK_OBSERVATION_LOST') return OBSERVATION_LOST_TEXT;
  const receipt = error?.requestTiming;
  if (!receipt) return '';
  const stage = serverRequestLabel(receipt.path);
  const status = Number(receipt.status || error.status);
  if (status === 401) return `${stage}：服务器登录已失效，请到 设置 → 服务器模式 重新登录`;
  if (status === 403) return `${stage}：服务器拒绝访问（403），请检查当前账号权限`;
  if (status >= 400) return `${stage}失败：服务器返回 HTTP ${status}，请检查服务器连接状态`;
  if (serverTaskMayBeRunning(error)) return `${stage}失败：未收到可读取的服务器响应，暂时无法确认任务是否已被接收。请到 设置 → 服务器模式 检查连接，再打开原对话查看，避免重复发送`;
  if (receipt.kind === 'timeout') return `${stage}超时，请到 设置 → 服务器模式 检查连接状态`;
  if (receipt.kind === 'network') return `${stage}失败：未收到可读取的服务器响应。请到 设置 → 服务器模式 检查连接；网络、证书或跨域限制都可能造成此现象`;
  return '';
}

export function serverConnectionText(event) {
  return event.state === 'connected' ? '连接已恢复，继续接收原任务回答'
    : '回答连接中断，正在重连原任务…';
}

export function serverObservationActions() {
  return [
    { title: '查看原对话', panel: 'sessions' },
    { title: '检查服务器连接', panel: 'settings' }
  ];
}
