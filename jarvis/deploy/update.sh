#!/usr/bin/env bash
# 未央服务器版：自动更新（install.sh 装好后由系统定时运行，也可以在手机 / 电脑上点“立即更新服务器”触发）
#   1. 查 GitHub 上最新版本（国内先走镜像），和正在运行的版本比
#   2. 有新版：下载安装包，核对 sha256，用新包里的 install.sh 安装（对话、文件、密码都不动）
#   3. 结果写进 /opt/jarvis/data/update-status.json，手机 / 电脑上能看到
# 手动运行：bash /opt/jarvis/update.sh
set -uo pipefail

BASE="${JARVIS_BASE:-/opt/jarvis}"   # 测试时可以换目录
REPO=xunova1121/-
DATA="$BASE/data"
STATUS="$DATA/update-status.json"
WORK="$BASE/updates"
read -ra MIRRORS <<< "${JARVIS_MIRRORS:-https://ghfast.top/ -}"   # 国内服务器连 GitHub 常常很慢：先走镜像，不行再直连（“-”表示直连）

# 按国内习惯记北京时间
now() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
status() { # status 状态 说明 [版本]
  local msg="${2//\"/\'}"
  printf '{"state":"%s","message":"%s","version":"%s","at":"%s"}\n' "$1" "$msg" "${3:-}" "$(now)" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  chown jarvis:jarvis "$STATUS" 2>/dev/null || true
  echo "[$(now)] $1：$2"
}
fetch() { # fetch 地址 保存到；依次试镜像
  local m
  for m in "${MIRRORS[@]}"; do
    [[ "$m" == - ]] && m=''
    if curl -fsSL --connect-timeout 15 --max-time 600 -o "$2" "${m}$1"; then return 0; fi
  done
  return 1
}

# 同一时间只跑一个
exec 9>"$BASE/.update.lock"
flock -n 9 || { echo "已经在更新了"; exit 0; }
rm -f "$DATA/update-request"   # 手机上点“立即更新”留下的请求，处理掉

# install.sh 记下的 Node 所在目录（系统定时运行时 PATH 里没有 nvm 装的 Node）
[[ -f "$BASE/node-dir" ]] && PATH="$(cat "$BASE/node-dir"):$PATH"
export PATH

mkdir -p "$WORK"
CUR="$(cat "$BASE/current/VERSION" 2>/dev/null | tr -d '[:space:]')"
status checking "正在检查新版本" "$CUR"
if ! fetch "https://github.com/$REPO/releases/latest/download/jarvis-server-latest.json" "$WORK/latest.json"; then
  status error "连不上 GitHub，稍后会再试" "$CUR"; exit 1
fi
VER="$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$WORK/latest.json")"
SHA="$(sed -n 's/.*"sha256" *: *"\([0-9a-f]\{64\}\)".*/\1/p' "$WORK/latest.json")"
[[ -n "$VER" && -n "$SHA" ]] || { status error "版本信息读不出来" "$CUR"; exit 1; }
if [[ "$VER" == "$CUR" ]]; then status latest "已经是最新版 $CUR" "$CUR"; exit 0; fi

PKG="$WORK/jarvis-server-$VER.tar.gz"
status downloading "正在下载 $VER" "$CUR"
if ! fetch "https://github.com/$REPO/releases/download/desktop-v$VER/jarvis-server-$VER.tar.gz" "$PKG"; then
  status error "下载 $VER 失败，稍后会再试" "$CUR"; exit 1
fi
if ! echo "$SHA  $PKG" | sha256sum -c --status; then
  rm -f "$PKG"; status error "下载的安装包校验不对（可能没下完整），已删掉，稍后再试" "$CUR"; exit 1
fi
status installing "正在安装 $VER（服务会重启，大约 1–3 分钟）" "$CUR"
rm -rf "$WORK/pkg" && mkdir -p "$WORK/pkg"
tar -xzf "$PKG" -C "$WORK/pkg" jarvis-server/deploy/install.sh --strip-components=2
if bash "$WORK/pkg/install.sh" "$PKG"; then
  status done "已更新到 $VER" "$VER"
else
  status error "安装 $VER 没成功，还在用 $CUR；日志：journalctl -u jarvis-update -n 80" "$CUR"; exit 1
fi
# 安装包只留最新的一个
ls -t "$WORK"/jarvis-server-*.tar.gz 2>/dev/null | tail -n +2 | xargs -r rm -f
