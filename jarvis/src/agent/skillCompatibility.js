/** 按明确依赖判断手机适配；不把说明里的“可选 / 不需要”误当成硬依赖。 */
export function skillCompatibility(pack, { mobile = false } = {}) {
  if (!mobile) return { status: 'available', label: '电脑可用', reason: '按当前设备的工具和服务执行' };
  if (pack.unverified) return { status:'conditional', label:'安装前需检查', reason:'远程技能先读取说明；安装时检查手机依赖' };
  const meta = pack.meta || {};
  const platforms = String(meta.platforms || meta.platform || meta.os || '').toLowerCase();
  const requirements = String(meta.requires || meta.dependencies || '');
  const text = [requirements, pack.body || ''].join('\n');
  const relevant = text.split('\n').filter(l => !/无需|不需要|不要使用|禁止使用|不支持|可选|optional|not required/i.test(l)).join('\n');
  const explicitNoMobile = /^(false|no|unsupported)$/i.test(String(meta.mobile ?? '')) || (/windows|macos|linux|desktop/.test(platforms) && !/android|mobile|web|all/.test(platforms));
  const mandatory = relevant.split('\n').filter(l => /必须|需要|依赖|requires?\b|prerequisite|^\s*(?:brew|apt(?:-get)?|sudo|docker|osascript|powershell|xdotool)\b/i.test(l)).join('\n');
  if (explicitNoMobile || /\b(docker|osascript|powershell|pyautogui|xdotool|win32com|selenium|playwright)\b|电脑桌面|鼠标键盘操作电脑|本机终端|本机命令行|本地命令行|控制电脑|桌面自动化/i.test(requirements + '\n' + mandatory)) {
    return { status: 'blocked', label: '手机用不了', reason: '依赖电脑系统、桌面控制或本机运行环境，请在 Windows 版使用' };
  }
  if (/\b(python|python3|pip|npm|node(?:\.js)?|ffmpeg|libreoffice|pandoc|cuda|pytorch)\b|API.?Key|密钥|付费|联网|浏览器自动化/i.test(relevant) || Object.keys(pack.files || {}).some(p => /\.(py|sh|ps1|bat|js)$/i.test(p))) {
    // 服务器模式：任务在服务器上做，脚本在服务器的隔离环境（技能运行器）里跑
    if (globalThis.__jarvisServerMode) return { status: 'conditional', label: '经服务器可用', reason: '脚本在你服务器的隔离环境里运行（会联网），服务器要装好技能运行器；只装可信来源的技能' };
    return { status: 'conditional', label: '手机有条件可用', reason: '文字和文件流程可用；脚本、外部服务和大文件需额外检查，未保证全部兼容' };
  }
  return { status: 'available', label: '适合手机', reason: '以文字、资料整理和已有文件工具为主' };
}
