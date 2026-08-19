/**
 * 这台跑的是哪一版。
 *
 * ── 为什么需要它 ──
 *
 * 服务器上更新是 `git pull && docker compose up -d --build`。
 * 这条命令有好几种**看起来成功、其实没更新**的失败法：
 * pull 到了但镜像用了缓存层、build 成功但容器没重建、
 * 改的是另一个目录、compose 文件里的 build context 指着别处。
 *
 * 而应用本身没有任何地方能回答"你现在跑的是哪个提交" ——
 * 于是判断"更新到底生效没有"只能靠**去点一个新功能试试**，
 * 试出来没有还分不清是没更新还是这个功能本来就有问题。
 *
 * 一个 7 位的提交号解决整件事。
 *
 * ── 为什么不公开 ──
 *
 * /api/health 在服务器模式下是要口令的，这个不改。
 * 版本号对外是攻击面（"哦这版有那个洞"），对内才有用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let cached = null;

export function info() {
  if (cached) return cached;

  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || version;
  } catch {
    /* 打包之后读不到也不该炸 —— 这只是一行显示信息 */
  }

  /**
   * 提交号由构建时注入（Docker 的 build-arg / 打包流水线的环境变量）。
   *
   * 注入不到时回 'dev' 而**不是**装作知道。写一个假的版本号，
   * 比没有版本号更坏 —— 它会让人相信一个错的答案。
   */
  const build = (process.env.FUTUREDREAM_BUILD || '').trim() || 'dev';

  cached = { version, build };
  return cached;
}
