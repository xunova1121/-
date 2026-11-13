/** 只读评测协议；不拿主人设置，不退回密码或永久凭证。 */
import fs from 'node:fs/promises';
import constants from 'node:constants';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function evaluationInfo(api) {
  let info;
  try { info = await api('/api/tasks?evaluation=info'); }
  catch { throw Object.assign(new Error('评测专用授权不可用，请更新服务器并在设置页生成令牌；未读取访问密码或模型设置'), { code: 'EVAL_CONFIG' }); }
  if (info?.protocol !== 'evaluation-token-v1' || !/^[a-f0-9]{24}$/.test(info.tokenId || '') || info.permissions?.settings !== false || info.permissions?.files !== false) throw Object.assign(new Error('评测授权协议不兼容；请使用设置页生成的专用令牌'), { code: 'EVAL_CONFIG' });
  if (info.busy) throw Object.assign(new Error('服务器还有其他任务，请单独评测'), { code: 'EVAL_CONFIG' });
  return info;
}

/**
 * 只有在服务器本机以管理员身份启动时才收集文件证据。
 * HTTP令牌仍不能访问任何文件；磁盘读取仅限服务器签发给该令牌/该轮的空间。
 */
export function evaluationFiles({ dataDir, tokenId }) {
  const unavailable = async () => null;
  return {
    forTurn(turn) {
      if (!dataDir || !/^[a-f0-9]{24}$/.test(tokenId || '') || !new RegExp(`^ev_${tokenId}_[a-f0-9]{20}$`).test(turn.evaluationId || '')) return unavailable;
      const scope = path.resolve(dataDir, 'evaluations', turn.evaluationId, 'store', 'files');
      return async (file, { maxBytes = 20e6 } = {}) => {
        if (typeof file !== 'string' || !file || file.length > 1024 || file.split(/[\\/]/).includes('..')) return null;
        const key = createHash('sha1').update(file).digest('hex');
        let handle;
        try {
          // 不创建目录；拒绝任何父级符号链接或文件符号链接，不能越过本轮私有空间。
          if (await fs.realpath(scope) !== scope) return null;
          handle = await fs.open(path.join(scope, key + '.data.bin'), constants.O_RDONLY | constants.O_NOFOLLOW);
          const metadata = await handle.stat();
          const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(20e6, Math.floor(maxBytes)) : 20e6;
          if (!metadata.isFile() || metadata.size > limit) return null;
          const buffer = Buffer.alloc(Math.min(limit, metadata.size) + 1);
          let received = 0;
          while (received < buffer.length) {
            const read = await handle.read(buffer, received, buffer.length - received, null);
            if (!read.bytesRead) return new Uint8Array(buffer.subarray(0, received));
            received += read.bytesRead;
          }
          return received > limit || received > metadata.size ? null : new Uint8Array(buffer.subarray(0, received));
        } catch { return null; }
        finally { await handle?.close(); }
      };
    }
  };
}

export function evaluationReadiness(item) {
  if (item.requires?.some(kind => ['repo', 'browser', 'schedule'].includes(kind))) return '评测专用授权不开放代码仓库、浏览器及正式定时任务；本题需独立主人验收，不计通过';
  return '';
}
