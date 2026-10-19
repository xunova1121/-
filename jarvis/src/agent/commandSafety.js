/**
 * 命令安全检查（思路参考开源的 Hermes Agent：tools/approval_detection.py，MIT 许可；规则按未央的场景重写）。
 *
 *   block   禁止执行：抹掉整个系统盘 / 用户目录、格式化磁盘、删除系统还原点……直接拦下，不问用户
 *   danger  危险命令：删除文件、关机、改注册表、结束进程、下载脚本直接执行、提权……
 *           每次都要单独确认（不能“本次都允许”），无人值守的定时任务一律拒绝
 *   ok      其他命令：照常征得同意（可以“本次都允许”）
 *
 * 只是第一道防线：规则拦不住刻意绕过的写法，所以危险命令仍以用户确认为准。
 */

/** [规则, 原因] */
const BLOCK = [
  [/\brm\s+(?:-[a-z]*\s+)*(?:-[a-z]*r[a-z]*|--recursive)\b[^|;&]*?\s(?:\/|~|\/\*|~\/\*|\$HOME|"\$HOME")(?:\s|$)/i, '删除整个系统盘或用户目录'],
  [/--no-preserve-root/i, '删除整个系统盘'],
  [/\b(?:rd|rmdir)\s+\/s\b[^|;&]*?\s['"]?[a-z]:\\?['"]?(?:\s|$)/i, '删除整个磁盘'],
  [/\b(?:del|erase)\b[^|;&]*\/s[^|;&]*?\s['"]?[a-z]:\\(?:\*(?:\.\*)?)?['"]?(?:\s|$)/i, '删除整个磁盘'],
  [/\bRemove-Item\b(?=[^|;]*-Recurse)[^|;]*?\s['"]?(?:[a-z]:\\?|~|\$env:USERPROFILE|\$HOME)['"]?(?:\s|$)/i, '删除整个磁盘或用户目录'],
  [/\bformat(?:\.com)?\s+[a-z]:/i, '格式化磁盘'],
  [/\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, '格式化或清空磁盘'],
  [/\bdiskpart\b/i, '磁盘分区操作'],
  [/\bmkfs(?:\.\w+)?\b/i, '格式化磁盘'],
  [/\bdd\b[^|;&]*\bof=\/dev\/(?:sd|hd|nvme|disk|mmcblk)/i, '直接写入磁盘设备'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, '让系统卡死的命令'],
  [/\bvssadmin\b[^|;&]*\bdelete\s+shadows\b|\bwbadmin\b[^|;&]*\bdelete\b/i, '删除系统还原点或备份'],
  [/\bbcdedit\b[^|;&]*\/delete\b/i, '删除系统启动项'],
  [/\bcipher\b[^|;&]*\/w\b/i, '彻底擦除磁盘空闲空间']
];

const DANGER = [
  [/\b(?:rm|Remove-Item|del|erase|rd|rmdir|unlink|shred)\s+/i, '删除文件或文件夹'],
  [/\bClear-RecycleBin\b/i, '清空回收站'],
  [/\b(?:shutdown|reboot|halt|poweroff|logoff|Stop-Computer|Restart-Computer)\b/i, '关机、重启或注销'],
  [/\breg(?:\.exe)?\s+(?:add|delete|import)\b|\b(?:Set|New|Remove)-ItemProperty\b[^|;]*\b(?:HKLM|HKCU|Registry::)/i, '修改注册表'],
  [/\b(?:taskkill|kill|pkill|killall|Stop-Process)\b/i, '强制结束程序'],
  [/\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(?:sh|bash|zsh|iex|Invoke-Expression|python3?|node)\b/i, '下载脚本后直接执行'],
  [/\b(?:iex|Invoke-Expression)\b/i, '执行动态拼出的代码'],
  [/\s-e(?:nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, '执行编码过的命令（看不到真实内容）'],
  [/\b(?:sudo|runas)\b|Start-Process\b[^|;]*-Verb\s+RunAs/i, '以管理员身份运行'],
  [/\b(?:chmod|chown)\s+-R\b|\bicacls\b[^|;&]*\/(?:grant|reset)|\btakeown\b/i, '批量修改文件权限'],
  [/\bSet-ExecutionPolicy\b|\bnetsh\b|\bsetx\b[^|;&]*\/m\b|\b(?:Set|Add)-MpPreference\b/i, '修改系统或安全设置'],
  [/\bschtasks\b[^|;&]*\/(?:create|delete)|\bsc(?:\.exe)?\s+(?:create|config|delete)\b|\b(?:New|Set|Remove)-Service\b|\bcrontab\s+-r\b/i, '修改系统服务或计划任务'],
  [/\b(?:winget|choco|scoop|brew)\s+uninstall\b|\bapt(?:-get)?\s+(?:remove|purge)\b|\b(?:npm\s+uninstall\s+-g|pip3?\s+uninstall)\b/i, '卸载软件'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\b[^|;&]*(?:--force|\s-f\b)|branch\s+-D\b|checkout\s+--\s)/i, '丢弃 Git 里的改动'],
  [/\b(?:Clear-Content|Set-Content|Out-File)\b[^|;]*\b(?:[a-z]:\\Windows|\/etc\/)/i, '改写系统文件']
];

/**
 * @param {string} command
 * @returns {{ level: 'block'|'danger'|'ok', why: string }}
 */
export function checkCommand(command) {
  const c = String(command ?? '');
  for (const [re, why] of BLOCK) if (re.test(c)) return { level: 'block', why };
  for (const [re, why] of DANGER) if (re.test(c)) return { level: 'danger', why };
  return { level: 'ok', why: '' };
}

/**
 * 不用问用户就可以放行吗：危险操作永远要问；其余的看“本次会话已允许”或任务的“允许无人值守操作”
 * @param {{ key?: string, danger?: boolean }} req  工具的 approval() 返回值
 * @param {{ sessionKeys?: Set<string>, unattended?: boolean }} [o]
 */
export function preApproved(req, { sessionKeys = new Set(), unattended = false } = {}) {
  if (req?.danger) return false;
  return unattended || Boolean(req?.key && sessionKeys.has(req.key));
}
