/** 响应正文按字节限流，不等整页/整份PDF读进内存才检查大小。 */
export async function webBody(response, maxBytes, signal) {
  const tooLarge = () => Object.assign(new Error('网页或附件超过读取大小上限'), { code: 'WEB_BODY_LIMIT', kind: 'api' });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw tooLarge();
    return bytes;
  }
  // 取消时释放仍在等待的正文流，不能只让外层超时而留下后台读取。
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const result = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (result.done) break;
      length += result.value.length;
      if (length > maxBytes) throw tooLarge();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
