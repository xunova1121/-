import { normalizeReadiness, READINESS_ITEMS, READINESS_CODES } from '../../shared/capabilityReadiness.js';

const STATUS = { ready: '环境可用', verified: '上次检测通过', configured: '待实测', missing: '待配置', unavailable: '不可用', unknown: '未检查', demo: '演示' };
const failure = (error, scope) =>
  error?.status === 401
    ? '登录已失效，请到服务器设置重新登录'
    : error?.status === 404
      ? scope === 'local'
        ? '本机网关尚不支持统一自检，请更新电脑完整版'
        : '当前服务器尚不支持统一自检，请先更新服务器'
      : error?.code === 'SERVER_NOT_CONNECTED'
        ? '请先到设置登录云服务器'
        : error?.code === 'READINESS_PROTOCOL'
          ? '自检响应不兼容，请更新服务器和客户端'
          : '能力自检未完成，请检查连接后重试';

/** 各配置位置独立检查；重绘/切位置销毁请求，旧结果不能显示到另一端。 */
export function readinessPanel({ workspace, node, onModels = () => {}, onKeys = () => {} }) {
  const scope = workspace.scope;
  const where = scope === 'server' ? '云服务器' : '本机';
  const root = node('details', { className: 'ml-copy capability-readiness' });
  const note = node('p', {
    className: 'ml-muted',
    role: 'status',
    textContent: '按需配置，无需全部开通。检查配置与运行环境，不调用模型、不拉取镜像；外部服务连接需另行检测。'
  });
  const list = node('div', { className: 'readiness-results' });
  const start = node('button', { type: 'button', className: 'ml-button', textContent: '开始自检' });
  const stop = node('button', { type: 'button', className: 'ml-link', textContent: '停止等待', hidden: true });
  const copy = node('button', { type: 'button', className: 'ml-link', textContent: '复制脱敏结果', disabled: true });
  let controller,
    destroyed = false,
    report = null;
  const current = (value) => !destroyed && controller === value && !value.signal.aborted && workspace.scope === scope;
  start.addEventListener('click', async () => {
    if (controller && !controller.signal.aborted) return;
    const request = new AbortController();
    controller = request;
    report = null;
    copy.disabled = true;
    start.disabled = true;
    stop.hidden = false;
    list.replaceChildren();
    note.textContent = `正在检查${where}配置与运行环境…`;
    try {
      const result = normalizeReadiness(await workspace.readiness(scope, request.signal), scope);
      if (!current(request)) return;
      report = result;
      const time =
        result.checkedAt && result.checkedAt <= 8640000000000000
          ? new Date(result.checkedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
          : '未知时间';
      note.textContent = `${where} · ${result.version} · ${time}（北京时间）。按需配置，无需全部开通。未测试模型回答或外部API；环境结果最多复用30秒，上次图库检测状态单独标示。`;
      for (const item of result.checks) {
        const [label, action] = READINESS_ITEMS[item.id];
        const row = node('div', { className: 'readiness-row' });
        row.dataset.readinessId = item.id;
        row.dataset.readinessStatus = item.status;
        row.append(
          node('strong', { textContent: label }),
          node('span', { textContent: STATUS[item.status] }),
          node('p', { textContent: READINESS_CODES[item.code][1] }),
          node('small', { textContent: '处理位置：' + action })
        );
        list.append(row);
      }
      copy.disabled = false;
    } catch (error) {
      if (current(request)) note.textContent = failure(error, scope);
    } finally {
      if (controller === request && !destroyed) {
        start.disabled = false;
        stop.hidden = true;
        controller = null;
      }
    }
  });
  stop.addEventListener('click', () => {
    controller?.abort();
    controller = null;
    start.disabled = false;
    stop.hidden = true;
    note.textContent = '已停止等待；服务器环境检查有时间上限，结束后会清理检查容器。';
  });
  copy.addEventListener('click', async () => {
    if (!report || destroyed || workspace.scope !== scope) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(normalizeReadiness(report, scope), null, 2));
    } catch {
      note.textContent = '未能复制，可选择下方自检文字后手动复制';
    }
  });
  const models = node('button', { type: 'button', className: 'ml-link', textContent: '模型配置' });
  const keys = node('button', { type: 'button', className: 'ml-link', textContent: '服务商与 Key' });
  models.addEventListener('click', onModels);
  keys.addEventListener('click', onKeys);
  root.append(
    node('summary', { textContent: `能力自检 · ${where}` }),
    note,
    node('div', { className: 'readiness-actions' }, start, stop, copy, models, keys),
    list
  );
  return {
    root,
    destroy() {
      destroyed = true;
      controller?.abort();
      report = null;
    }
  };
}
