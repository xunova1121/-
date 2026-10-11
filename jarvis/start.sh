#!/usr/bin/env bash
# 一键启动完整版（Mac / Linux）：首次运行自动安装依赖并构建，然后打开浏览器
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "需要先安装 Node.js 18 或更新版本：https://nodejs.org/"; exit 1; }
[ -d node_modules ] || { echo "首次运行，正在安装依赖……"; npm install; }
[ -d dist ] || npm run build
( sleep 1; (command -v open >/dev/null && open http://127.0.0.1:8787) || (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8787) || true ) &
exec node server/server.mjs
