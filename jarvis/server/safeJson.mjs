/**
 * 配置文件的安全读写：
 *   - 写：先写临时文件再替换（断电、崩溃不会留下写了一半的文件），替换前把上一份能用的存成 .bak
 *   - 读：文件坏了就把坏文件改名留底（.broken-时间），从 .bak 恢复；都不行才当作没有配置
 */
import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  // 当前文件能解析才拿来当备份（不要用坏文件覆盖好备份）
  try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, `${file}.bak`); } catch { /* 还没有或已损坏 */ }
  fs.renameSync(tmp, file);
}

/**
 * @returns {{ data: any, restored: boolean, broken?: string }} data 为 fallback 表示没有可用配置
 */
export function readJsonSafe(file, fallback = null) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { data: fallback, restored: false }; }
  try { return { data: JSON.parse(text), restored: false }; } catch { /* 损坏，往下恢复 */ }
  const broken = `${file}.broken-${Date.now()}`;
  try { fs.renameSync(file, broken); } catch { /* ignore */ }
  try {
    const data = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
    fs.copyFileSync(`${file}.bak`, file);
    return { data, restored: true, broken };
  } catch {
    return { data: fallback, restored: false, broken };
  }
}
