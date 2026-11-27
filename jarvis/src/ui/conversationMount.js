// 两个工作台都使用当前对话的原始节点。表单事件、待发队列、文件预览和流式回复仍由原控制器管理。
export function createConversationMount(transcript, form) {
  const home = transcript.parentElement;
  const anchor = document.createComment('conversation');
  home.insertBefore(anchor, transcript);
  let host = home;

  function moveTo(parent) {
    if (parent === host) return;
    const position = transcript.scrollTop;
    const following = transcript.scrollHeight - position - transcript.clientHeight < 20;
    const before = parent === home ? anchor.nextSibling : null;
    for (let item = transcript; item;) {
      const next = item.nextElementSibling;
      if (parent.moveBefore && parent.isConnected && item.isConnected) parent.moveBefore(item, before);
      else parent.insertBefore(item, before);
      if (item === form) break;
      item = next;
    }
    host = parent;
    // 调用方完成场景和空状态的布局后，再恢复视野。
    return () => { transcript.scrollTop = following ? transcript.scrollHeight : position; };
  }

  return { moveTo, restore: () => moveTo(home) };
}
