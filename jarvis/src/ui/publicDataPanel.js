import { DEFAULT_PUBLIC_DATA_HOSTS, publicDataHosts } from '../agent/publicJson.js';
/** 使用模型工作台现成的scope保存；可信域名只由用户编辑，不暴露为模型工具。 */
export function publicDataPanel({ cfg, workspace, node, toast }) {
  const scope = workspace.scope;
  const input = node('textarea', { rows: 4, ariaLabel: '公开数据可信域名', value: (cfg.publicDataHosts ?? DEFAULT_PUBLIC_DATA_HOSTS).join('\n'), maxLength: 2000 });
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const save = node('button', { type: 'button', className: 'ml-button', textContent: '保存可信域名' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const domains = publicDataHosts(input.value.split(/[\n,，\s]+/).filter(Boolean));
      await workspace.patch(value => ({ ...value, publicDataHosts: domains }), scope);
      result.textContent = '已保存到' + (scope === 'server' ? '云服务器' : '本机') + '；共' + domains.length + '个域名。';
      toast(result.textContent);
    } catch (error) { result.textContent = error.message; }
    finally { save.disabled = false; }
  });
  const reset = node('button', { type: 'button', className: 'ml-button', textContent: '填入默认域名' });
  reset.addEventListener('click', () => { input.value = DEFAULT_PUBLIC_DATA_HOSTS.join('\n'); result.textContent = '默认域名已填入，点击保存后生效。'; });
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  return node('details', { className: 'ml-copy ml-public-data' },
    node('summary', { textContent: '公开数据接口 · ' + (scope === 'server' ? '云服务器' : '本机') }),
    node('p', { className: 'ml-muted', textContent: '每行一个可信域名，可增删；留空并保存将关闭公开JSON工具。只读免费、无需登录的HTTPS接口，不发送Cookie或密钥。允许域名不代表每个接口都可用，日期与单位仍以实际响应为准。' }),
    input, save, reset, result);
}
