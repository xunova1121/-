import '../ui/modelLocalOptions.css';
/** 独有的本机诊断/离线选项集中在模型中心，兼容原表单和事件，不另存一份配置。 */
export function createModelLocalOptions() {
  const legacy = document.querySelector('#model-advanced');
  if (!legacy) return { openLocalOptions() {} };
  const dialog = document.createElement('dialog');
  dialog.id = 'model-tools-dialog';
  dialog.className = 'model-tools-dialog';
  dialog.setAttribute('aria-labelledby', 'model-tools-title');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'model-tools-title';
  title.textContent = '本机连接与选项';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'model-tools-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭本机选项');
  close.addEventListener('click', () => dialog.close());
  header.append(title, close);
  const note = document.createElement('p');
  note.className = 'model-tools-note';
  note.textContent = '连接诊断和离线模型仅用于本机。响应选项沿用现有设置，备用并发开关会同步已连接的服务器。';
  const options = document.createElement('section');
  options.className = 'model-tools-options';
  // 移动原节点，保留连接测试、Ollama和开关的既有监听及状态。
  const firstOption = legacy.querySelector('#fast-chat')?.closest('label');
  if (firstOption) {
    let current = firstOption;
    while (current) {
      const next = current.nextSibling;
      options.append(current);
      current = next;
    }
  }
  legacy.querySelector('summary').textContent = '手动连接诊断';
  const help = legacy.querySelector('.note');
  if (help) help.textContent = '排查接口地址、密钥或型号时使用。这里的“保存并使用”只切换本机默认模型。';
  const fallback = document.querySelector('#card-search');
  const searchOptions = document.createElement('details');
  searchOptions.className = 'model-tools-search';
  const searchTitle = document.createElement('summary');
  searchTitle.textContent = '本机搜索选项';
  searchOptions.append(searchTitle);
  if (fallback) {
    const paragraphs = fallback.querySelectorAll('p.muted.small');
    if (paragraphs[0]) paragraphs[0].textContent = '检查本机备用搜索，或调整免密钥搜索范围。服务商密钥统一在模型中心维护。';
    if (paragraphs[1]) paragraphs[1].hidden = true;
    searchOptions.append(fallback);
  }
  dialog.append(header, note, options, searchOptions, legacy);
  document.body.append(dialog);
  return {
    openLocalOptions() {
      if (!dialog.open) dialog.showModal();
    }
  };
}
