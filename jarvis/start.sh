#!/usr/bin/env bash
# 一键启动完整版（Mac / Linux）：首次运行自动安装依赖并构建，然后打开浏览器
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "需要先安装 Node.js 18 或更新版本：https://nodejs.org/"; exit 1; }
node scripts/ensure-build.mjs
echo "贾维斯网关运行中：浏览器会自动打开；也可以直接打开 jarvis-standalone.html，它会自动连上这个网关。使用期间请不要关闭本窗口。"
( sleep 1; (command -v open >/dev/null && open http://127.0.0.1:8787) || (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8787) || true ) &
exec node server/server.mjs
