/** 健康状态只按需读取；主动联网检查须点击按钮，本机与服务器分别保存。 */
export function lookupPanel({ cfg, workspace, node, toast }) {
  const scope = workspace.scope;
  const place = scope === 'server' ? '云服务器' : '本机';
  const select = node('select', { ariaLabel: '信息查询地区', className: 'ml-input' },
    ...[['auto', '自动判断'], ['cn', '国内来源优先'], ['global', '海外来源优先']].map(([value, text]) => node('option', { value, textContent: text })));
  select.value = cfg.lookupRegion || 'auto';
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const rows = node('ul', { className: 'ml-lookup-health', ariaLabel: '查询来源健康状态' });
  const save = node('button', { type: 'button', className: 'ml-button', textContent: '保存查询地区' });
  const refresh = node('button', { type: 'button', className: 'ml-button', textContent: '查看来源状态' });
  const check = node('button', { type: 'button', className: 'ml-button', textContent: '检查来源连通' });
  const cancel = node('button', { type: 'button', className: 'ml-button', textContent: '停止检查', hidden: true });
  let controller;
  function render(value) {
    rows.replaceChildren(...value.sources.map(source => {
      const sample = source.samples.at(-1);
      const label = source.validation === 'not_selected' ? '暂不选用' : source.validation === 'pending_cn' ? '待国内实测' : source.cooling ? '冷却至' + new Date(source.cooldownUntil).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : !sample ? '尚未检查' : sample.state === 'failed' ? '连接失败' : sample.state === 'empty' ? '已连通，当前无可验证条目' : '可读取';
      const details = sample ? ` · ${sample.elapsedMs}ms · 最近${source.samples.length}次` : '';
      return node('li', { textContent: `${source.label} · ${source.category} · ${source.region === 'cn' ? '国内' : '海外'}：${label}${details}${source.storageError ? ' · ' + source.storageError : ''}` });
    }));
    result.textContent = `${place}当前按${value.resolvedRegion === 'cn' ? '国内' : '海外'}地区选源。检查只证明连通，不代表全文核实。`;
  }
  async function load(probe) {
    if (controller) return;
    controller = new AbortController();
    refresh.disabled = check.disabled = save.disabled = true;
    cancel.hidden = !probe;
    result.textContent = probe ? `正在从${place}检查固定来源，不请求模型…` : '正在读取来源状态…';
    try { render(await workspace.lookupHealth(probe, scope, controller.signal)); }
    catch (error) { result.textContent = controller.signal.aborted ? '检查已停止，保留已有记录。' : error.message; }
    finally { controller = null; refresh.disabled = check.disabled = save.disabled = false; cancel.hidden = true; }
  }
  refresh.addEventListener('click', () => load(false));
  check.addEventListener('click', () => load(true));
  cancel.addEventListener('click', () => controller?.abort());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const region = select.value;
      if (!['auto', 'cn', 'global'].includes(region)) throw Error('请选择查询地区');
      await workspace.patch(value => ({ ...value, lookupRegion: region }), scope);
      result.textContent = `已保存到${place}；下一次查询生效。`;
      toast(result.textContent);
    } catch (error) { result.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return node('details', { className: 'ml-copy ml-lookup' },
    node('summary', { textContent: `信息查询来源 · ${place}` }),
    node('p', { className: 'ml-muted', textContent: '国内优先使用已实测的来源，海外报道只作已连通的补充。连续失败3次冷却30分钟；可主动检查恢复。自动模式参考运行设备时区，UTC服务器保守按国内处理。' }),
    select, save, refresh, check, cancel, result, rows);
}
