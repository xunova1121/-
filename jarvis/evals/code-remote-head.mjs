/** 固定测试仓库的main用GitHub只读ref接口核对，不为一个SHA再发起Git传输。 */
import { CODE_TEST_REPOSITORY } from './code-live-config.mjs';

export async function codeRemoteHead(connection, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (connection.repository !== CODE_TEST_REPOSITORY) throw Object.assign(new Error('仅核对指定测试仓库'), { code: 'CODE_REPO_NOT_ALLOWED' });
  const timeout = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl('https://api.github.com/repos/' + CODE_TEST_REPOSITORY + '/git/ref/heads/main', {
      redirect: 'manual',
      signal: combined,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Weiyang-Code-Acceptance', Authorization: 'Bearer ' + connection.token }
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code = { 401: 'CODE_GITHUB_AUTH', 403: 'CODE_GITHUB_FORBIDDEN', 404: 'CODE_GITHUB_NOT_FOUND' }[response.status] || 'CODE_GITHUB_HTTP';
      throw Object.assign(new Error('GitHub远端核对未完成'), { code });
    }
    const reader = response.body?.getReader();
    if (!reader) throw Object.assign(new Error('GitHub缺少回执'), { code: 'CODE_GITHUB_RESPONSE' });
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        combined.throwIfAborted();
        if (part.done) break;
        if ((size += part.value.length) > 65536) throw Object.assign(new Error('远端回执超过64KB'), { code: 'CODE_GITHUB_SIZE' });
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('远端回执格式错误'), { code: 'CODE_GITHUB_RESPONSE' });
    }
    if (value.ref !== 'refs/heads/main' || value.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(value.object.sha || ''))
      throw Object.assign(new Error('远端分支或提交不符'), { code: 'CODE_GITHUB_RESPONSE' });
    return value.object.sha;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code?.startsWith('CODE_')) throw error;
    throw Object.assign(new Error('远端main尚未核验'), { code: timeout.aborted ? 'CODE_GITHUB_TIMEOUT' : 'CODE_GITHUB_NETWORK' });
  }
}
