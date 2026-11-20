import { trashSnapshot } from '../agent/workspaceTrash.js';

/** 清理的范围来自当前来源的完整活动目录。用户看到的版本和路径一直用到操作结束。 */
export async function confirmTrashAll({ source, afterMove, refresh, toast }) {
  source.check?.();
  if (source.mode() === 'folder') throw new Error('请切回未央文件空间后再清理文件。');
  const location = source.locationLabel || (source.mode() === 'server' ? '当前云账号的文件空间' : '本机工作区');
  const dialog = document.createElement('dialog');
  dialog.className = 'ws-manager ws-clear-dialog';
  dialog.setAttribute('aria-label', '清理当前文件空间');
  const make = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const heading = make('h3', '全部移入回收站');
  const message = make('p', '正在核对' + location + '的文件…');
  const cancel = make('button', '取消');
  cancel.type = 'button';
  cancel.autofocus = true;
  const confirm = make('button', '确认移入回收站');
  confirm.type = 'button';
  confirm.hidden = true;
  const controller = new AbortController();
  let running = false;
  cancel.onclick = () => {
    if (!running) return dialog.close();
    controller.abort();
    cancel.disabled = true;
    message.textContent = '正在等待已开始的文件操作完成…';
  };
  dialog.oncancel = event => {
    if (running) { event.preventDefault(); cancel.click(); }
  };
  dialog.onclose = () => { controller.abort(); dialog.remove(); };
  dialog.append(heading, message, cancel, confirm);
  document.body.append(dialog);
  dialog.showModal();
  try {
    const files = (await source.list()).map(({ path, size, mtime }) => ({ path, size, mtime }));
    if (!dialog.open) return;
    source.check?.();
    if (!files.length) {
      message.textContent = location + '没有可清理的文件。';
      cancel.textContent = '关闭';
      return;
    }
    message.textContent = `${location}共有 ${files.length} 个文件，包括上传和过程文件。确认后可在这里的回收站恢复。`;
    const details = document.createElement('details');
    details.append(make('summary', '查看本次文件'));
    for (const file of files.slice(0, 20)) details.append(make('p', file.path));
    if (files.length > 20) details.append(make('p', `另有 ${files.length - 20} 个文件`));
    dialog.insertBefore(details, cancel);
    confirm.hidden = false;
    confirm.onclick = async () => {
      if (running) return;
      confirm.disabled = true;
      running = true;
      cancel.textContent = '停止';
      try {
        source.check?.();
        const { paths, errors } = await trashSnapshot(files, {
          signal: controller.signal,
          trashFile: (path, file) => {
            try { source.check?.(); } catch (error) { controller.abort(); throw error; }
            return source.trash(path, file);
          },
          onProgress: ({ done, total }) => {
            if (!controller.signal.aborted) message.textContent = `正在移入回收站 · ${done} / ${total}`;
          }
        });
        source.check?.();
        try { await afterMove(paths); }
        catch { toast('文件已处理，旧目录标记未能更新。'); }
        if (errors.length) {
          message.textContent = `已移入 ${paths.length} 个，${errors.length} 个未移入。`;
          details.replaceChildren(make('summary', '查看未移入的文件'));
          for (const { path, reason } of errors.slice(0, 20)) details.append(make('p', path + ' · ' + reason));
          details.open = true;
        } else {
          dialog.close();
          toast(`已将 ${paths.length} 个文件移入回收站。`);
        }
      } catch (error) {
        message.textContent = error.message;
      } finally {
        running = false;
        confirm.hidden = true;
        cancel.disabled = false;
        cancel.textContent = '关闭';
        refresh();
      }
    };
  } catch (error) {
    message.textContent = error.message;
    cancel.textContent = '关闭';
  }
}
