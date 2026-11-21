import { spawn } from 'node:child_process';

export const codeError = (code, message, extra = {}) => Object.assign(new Error(message), { code, kind: 'code_repository', ...extra });
export function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || ['.', '..', '.git'].includes(value.split('/')[1]))
    throw codeError('CODE_REPOSITORY', '仓库请填写GitHub的owner/repo，不填网址或本机路径');
  return value.toLowerCase();
}
export function redactCode(value, token = '') {
  let text = String(value);
  if (token)
    for (const secret of [token, encodeURIComponent(token), Buffer.from('x-access-token:' + token).toString('base64')])
      text = text.split(secret).join('[已隐藏凭据]');
  return text.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[已隐藏凭据]');
}
/** 不用shell、不继承宿主凭据/用户git配置；认证仅经子进程环境传递，不进argv或仓库。 */
export function createGitRunner({ spawnImpl = spawn, timeoutMs = 120000, maxOutput = 250000 } = {}) {
  return (args, { cwd, signal, token = '', accept = [0] } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const env = {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_TRACE: '0',
        GIT_TRACE_CURL: '0',
        GIT_CURL_VERBOSE: '0'
      };
      for (const key of [
        'PATH',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'no_proxy',
        'GIT_SSL_CAINFO',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR'
      ])
        if (process.env[key]) env[key] = process.env[key];
      const config = [
        ['core.hooksPath', '/dev/null'],
        ['credential.helper', ''],
        ['protocol.file.allow', 'never'],
        ['protocol.ext.allow', 'never'],
        ['http.followRedirects', 'false'],
        ['http.sslVerify', 'true']
      ];
      if (token) config.push(['http.https://github.com/.extraHeader', 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64')]);
      env.GIT_CONFIG_COUNT = String(config.length);
      config.forEach(([key, value], i) => {
        env['GIT_CONFIG_KEY_' + i] = key;
        env['GIT_CONFIG_VALUE_' + i] = value;
      });
      const child = spawnImpl('git', args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let total = 0,
        done = false;
      const output = [],
        errors = [];
      const kill = () => {
        try {
          process.platform !== 'win32' ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      };
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => {
        kill();
        finish(signal.reason);
      };
      const timer = setTimeout(() => {
        kill();
        finish(codeError('CODE_GIT_TIMEOUT', 'Git操作超时，已停止', { kind: 'timeout' }));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      for (const [stream, chunks] of [
        [child.stdout, output],
        [child.stderr, errors]
      ])
        stream.on('data', (chunk) => {
          if (done) return;
          total += chunk.length;
          if (total > maxOutput) {
            kill();
            finish(codeError('CODE_GIT_OUTPUT', 'Git输出超过检查上限，请缩小文件范围'));
          } else chunks.push(chunk);
        });
      child.once('error', (error) =>
        finish(codeError(error.code === 'ENOENT' ? 'CODE_GIT_MISSING' : 'CODE_GIT_START', error.code === 'ENOENT' ? '服务器缺git命令' : 'Git进程未能启动'))
      );
      child.once('close', (exitCode) => {
        const stdout = redactCode(Buffer.concat(output).toString('utf8'), token),
          stderr = redactCode(Buffer.concat(errors).toString('utf8'), token);
        finish(accept.includes(exitCode) ? null : codeError('CODE_GIT_FAILED', `Git操作失败（退出码${exitCode}）：${stderr.slice(-1200)}`, { exitCode }), {
          stdout,
          stderr,
          exitCode
        });
      });
    });
}

export async function gitRetry(operation, signal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (attempt || !['CODE_GIT_FAILED', 'CODE_GIT_TIMEOUT'].includes(error.code)) throw error;
      await new Promise((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(finish, 250 + Math.random() * 250);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
