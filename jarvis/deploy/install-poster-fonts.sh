#!/usr/bin/env bash
# 海报字体独立于 Office：已有 Office 的升级也要补齐，不能把 fontconfig 的替代字体当成功。
# 只使用系统已经配置的软件源，不读取 jarvis.env 或其他用户配置。
set -euo pipefail

if [[ "${JARVIS_NO_POSTER_FONTS:-}" == 1 ]]; then
  echo "== 已按 JARVIS_NO_POSTER_FONTS=1 跳过海报字体检查与安装"
  exit 0
fi

fail() {
  echo "== 海报字体未就绪：$1；中文海报 PNG 暂不可用，请补装 fontconfig 和 Noto Sans/Serif CJK SC" >&2
  exit 1
}

command -v timeout >/dev/null 2>&1 || fail "缺少 timeout，未启动无时限的安装"

has_family() {
  local family="$1" matched
  matched="$(timeout --kill-after=5s 15s fc-match -f '%{family}\n' "$family")" || return 1
  # fc-match 即使找不到指定字体也会返回另一种字体，必须核对真实家族名。
  case ",${matched//$'\n'/,}," in
    *,"$family",*) return 0 ;;
    *) return 1 ;;
  esac
}

fonts_ready() {
  command -v fc-match >/dev/null 2>&1 && command -v fc-cache >/dev/null 2>&1 || return 1
  has_family 'Noto Sans CJK SC' && has_family 'Noto Serif CJK SC'
}

if fonts_ready; then
  echo "== 海报字体已就绪（Noto Sans/Serif CJK SC）"
  exit 0
fi

echo "== 安装海报字体（fontconfig + Noto Sans/Serif CJK SC）"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  timeout --kill-after=15s 360s apt-get update -qq \
    && timeout --kill-after=15s 360s apt-get install -y -qq --no-install-recommends fontconfig fonts-noto-cjk \
    || fail "系统 apt 软件源安装失败或超时"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  POSTER_FONT_PM="$(command -v dnf || command -v yum)"
  timeout --kill-after=15s 360s "$POSTER_FONT_PM" install -y -q fontconfig google-noto-sans-cjk-ttc-fonts google-noto-serif-cjk-ttc-fonts \
    || fail "系统 RPM 软件源安装失败或超时，未启用第三方源"
else
  fail "未找到 apt、dnf 或 yum"
fi

command -v fc-cache >/dev/null 2>&1 || fail "安装后仍缺少 fontconfig"
timeout --kill-after=5s 60s fc-cache -f || fail "刷新字体缓存失败或超时"
fonts_ready || fail "安装后仍缺少指定字体，未接受替代字体"
echo "== 海报字体已就绪（Noto Sans/Serif CJK SC）"
