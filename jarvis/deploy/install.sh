#!/usr/bin/env bash
# 未央服务器版：安装 / 更新（同一个脚本）。在服务器上用 root 运行：
#   bash install.sh jarvis-server-1.0.xxx.tar.gz
# 做的事：
#   1. 解压到 /opt/jarvis/app-<版本>，用国内镜像安装依赖（不运行任何安装脚本）
#   2. 第一次安装时：建一个专门运行未央的系统账号 jarvis，问你设访问密码，写进 /opt/jarvis/jarvis.env（只有 root 能读）
#   3. 注册成系统服务 jarvis（开机自启、崩了自动重启、最多用 700MB 内存），只在本机 127.0.0.1:8787 上监听
#   4. 切换到新版本并重启；旧版本保留最近 2 个，出问题可以切回去
# 你的对话、记忆、文件在 /opt/jarvis/data，更新不会动它。
set -euo pipefail

PKG="${1:-}"
if [[ -z "$PKG" ]]; then PKG="$(ls -t jarvis-server-*.tar.gz 2>/dev/null | head -1 || true)"; fi
[[ -f "$PKG" ]] || { echo "用法：bash install.sh jarvis-server-1.0.xxx.tar.gz（找不到安装包）"; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo "请用 root 运行"; exit 1; }
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "没找到 Node.js，请先安装 Node 22（宝塔：软件商店 → Node.js 版本管理器）"; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node.js 版本太旧（需要 20 以上），当前 $("$NODE" -v)"; exit 1; }
NPM="$(dirname "$NODE")/npm"; [[ -x "$NPM" ]] || NPM="$(command -v npm)"

BASE=/opt/jarvis
VER="$(basename "$PKG" .tar.gz | sed 's/^jarvis-server-//')"
APP="$BASE/app-$VER"
mkdir -p "$BASE" "$BASE/data"

echo "== 解压 $VER"
rm -rf "$APP.tmp" && mkdir -p "$APP.tmp"
tar -xzf "$PKG" -C "$APP.tmp" --strip-components=1
echo "== 安装依赖（国内镜像，几分钟）"
(cd "$APP.tmp" && "$NPM" install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com)
rm -rf "$APP" && mv "$APP.tmp" "$APP"

if ! id jarvis >/dev/null 2>&1; then
  echo "== 新建系统账号 jarvis（不能登录，只用来运行未央）"
  useradd --system --home-dir "$BASE" --shell /sbin/nologin jarvis
fi

ENVF="$BASE/jarvis.env"
if [[ ! -f "$ENVF" ]]; then
  echo "== 设置访问密码（手机 / 电脑登录用，至少 8 位；输入时不显示）"
  while :; do
    read -rsp "访问密码：" P1; echo
    read -rsp "再输一次：" P2; echo
    [[ "$P1" == "$P2" && ${#P1} -ge 8 ]] && break
    echo "两次不一样或少于 8 位，请重输"
  done
  umask 077
  printf 'PORT=8787\nHOST=127.0.0.1\nJARVIS_DATA=%s/data\nJARVIS_PASSWORD=%s\nJARVIS_MAX_TASKS=1\nNODE_OPTIONS=--max-old-space-size=512\n' "$BASE" "$P1" > "$ENVF"
  unset P1 P2
fi
chmod 600 "$ENVF"
chown -R jarvis:jarvis "$BASE/data"
chown -R root:root "$APP"
ln -sfn "$APP" "$BASE/current"

cat > /etc/systemd/system/jarvis.service <<UNIT
[Unit]
Description=未央 WEIYANG AI 服务器版
After=network-online.target
Wants=network-online.target

[Service]
User=jarvis
Group=jarvis
WorkingDirectory=$BASE/current
EnvironmentFile=$ENVF
ExecStart=$NODE server/server.mjs
Restart=always
RestartSec=3
MemoryMax=700M
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$BASE/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable jarvis >/dev/null 2>&1
systemctl restart jarvis
sleep 3
if curl -fsS http://127.0.0.1:8787/api/health | grep -q '"serverMode":true'; then
  echo "== 好了：未央 $VER 已在运行（本机 127.0.0.1:8787）"
else
  echo "== 启动好像没成功，看看日志：journalctl -u jarvis -n 50"; exit 1
fi
# 只留最近 2 个旧版本
ls -dt "$BASE"/app-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
