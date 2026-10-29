#!/usr/bin/env bash
set -euo pipefail
umask 077
command -v node >/dev/null
command -v curl >/dev/null
BASE_DIR="$(mktemp -d /tmp/weiyang-code-live-XXXXXX)"
RUNTIME='https://raw.githubusercontent.com/xunova1121/-/refs/heads/claude/jolly-darwin-tijh97/jarvis/evals'
QUERY="$(date +%s)-$$"
printf '隔离代码测试目录：%s\n' "$BASE_DIR"
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 "$RUNTIME/code-runtime-manifest.json?v=$QUERY" -o "$BASE_DIR/manifest.json"
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 "$RUNTIME/architecture-runtime-fetch.mjs?v=$QUERY" -o "$BASE_DIR/fetch.mjs"
PRODUCTION_APP="${JARVIS_PRODUCTION_APP:-/opt/jarvis/current}"
TEST_APP="$BASE_DIR/source/jarvis"
node "$BASE_DIR/fetch.mjs" "$BASE_DIR/manifest.json" "$PRODUCTION_APP" "$TEST_APP"
if [ -d "$PRODUCTION_APP/node_modules" ] && cmp -s "$PRODUCTION_APP/package-lock.json" "$TEST_APP/package-lock.json"; then
  ln -s "$PRODUCTION_APP/node_modules" "$TEST_APP/node_modules"
else
  (cd "$TEST_APP" && npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com)
fi
export JARVIS_TEST_REVISION="$(cat "$TEST_APP/runtime-revision.txt")"
printf '固定测试源码：%s；不更新正式服务、不推送测试仓库。\n' "$JARVIS_TEST_REVISION"
RESULT=0
JARVIS_CODE_SANDBOX_IMAGE="${JARVIS_CODE_SANDBOX_IMAGE:-node:22-bookworm-slim}" node "$TEST_APP/evals/code-server.mjs" --live "--data-dir=${JARVIS_PRODUCTION_DATA:-/opt/jarvis/data}" "--out-dir=$BASE_DIR/results" || RESULT=$?
if [ -f "$BASE_DIR/results/report.json" ]; then
  tar -czf "$BASE_DIR/code-results.tar.gz" -C "$BASE_DIR/results" report.json
  printf '私有结果包：%s/code-results.tar.gz\n' "$BASE_DIR"
fi
exit "$RESULT"
