#!/usr/bin/env bash
set -euo pipefail
umask 077
command -v node >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
BASE_DIR="${JARVIS_ARCHITECTURE_CODE_DIR:-$(mktemp -d /tmp/weiyang-architecture-code-XXXXXX)}"
case "$BASE_DIR" in /tmp/weiyang-architecture-code-*) ;; *) printf '测试目录必须在/tmp/weiyang-architecture-code-*下\n' >&2; exit 1;; esac
[ -d "$BASE_DIR" ]
[ ! -e "$BASE_DIR/results" ] || { printf '此目录已有测试结果；不会重复提交任务，请新建测试目录。\n' >&2; exit 1; }
chmod 700 "$BASE_DIR"
printf '测试代码目录：%s\n' "$BASE_DIR"
RUNTIME_ROOT='https://raw.githubusercontent.com/xunova1121/-/refs/heads/claude/jolly-darwin-tijh97/jarvis/evals'
curl --fail --silent --show-error --connect-timeout 15 --max-time 60 --retry 2 --retry-delay 2 "$RUNTIME_ROOT/architecture-runtime-manifest.json" -o "$BASE_DIR/runtime-manifest.json"
curl --fail --silent --show-error --connect-timeout 15 --max-time 60 --retry 2 --retry-delay 2 "$RUNTIME_ROOT/architecture-runtime-fetch.mjs" -o "$BASE_DIR/runtime-fetch.mjs"
TEST_APP="$BASE_DIR/source/jarvis"
PRODUCTION_APP="${JARVIS_PRODUCTION_APP:-/opt/jarvis/current}"
node "$BASE_DIR/runtime-fetch.mjs" "$BASE_DIR/runtime-manifest.json" "$PRODUCTION_APP" "$TEST_APP"
REVISION=$(cat "$TEST_APP/runtime-revision.txt")
if [ -d "$PRODUCTION_APP/node_modules" ] && cmp -s "$PRODUCTION_APP/package-lock.json" "$TEST_APP/package-lock.json"; then
  [ -e "$TEST_APP/node_modules" ] || ln -s "$PRODUCTION_APP/node_modules" "$TEST_APP/node_modules"
else
  (cd "$TEST_APP" && npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com)
fi
export JARVIS_TEST_REVISION="$REVISION"
printf '测试源码：%s；不更新正式服务。\n' "$REVISION"
TEST_RESULT=0
node "$TEST_APP/evals/architecture-server.mjs" --live "--data-dir=${JARVIS_PRODUCTION_DATA:-/opt/jarvis/data}" "--source=${JARVIS_ARCHITECTURE_SOURCE:-上传/重点水域禁捕项目正式招标文件.docx}" "--out-dir=$BASE_DIR/results" || TEST_RESULT=$?
if [ -f "$BASE_DIR/results/report.json" ]; then
  tar -czf "$BASE_DIR/architecture-results.tar.gz" -C "$BASE_DIR/results" report.json artifacts runtime-private.log
  printf '私有结果包：%s/architecture-results.tar.gz\n' "$BASE_DIR"
fi
exit "$TEST_RESULT"
