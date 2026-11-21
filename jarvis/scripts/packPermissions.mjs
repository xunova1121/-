/**
 * 打包前统一应用文件权限（1.0.419 事故根治：构建环境 umask 偏严时，打出的包里目录 0700、文件 0600，
 * root 安装后 jarvis 服务账号读不了，服务起不来）。规则：目录 0755；普通文件原本带执行位的 0755，其余 0644；
 * 都不给组和其他人写权限。符号链接本身不改、也不跟随（不越界改包外文件）。
 */
import fs from 'node:fs';
import path from 'node:path';

export function normalizePackPermissions(root) {
  fs.chmodSync(root, 0o755);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        fs.chmodSync(p, 0o755);
        walk(p);
      } else if (entry.isFile()) {
        fs.chmodSync(p, fs.lstatSync(p).mode & 0o100 ? 0o755 : 0o644);
      }
    }
  };
  walk(root);
}
