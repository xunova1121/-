/** 输入状态只决定入口显隐；发送和停止互不替代。 */
export function composerState({ text = '', attachments = 0, generating = false } = {}) {
  const hasDraft = Boolean(String(text).trim() || attachments);
  return { hasDraft, send: hasDraft, voice: !hasDraft && !generating, stop: generating };
}
