#!/usr/bin/env bash
set -euo pipefail
umask 077
command -v node >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
BASE_DIR=$(mktemp -d /tmp/weiyang-architecture-code-XXXXXX)
printf '测试代码目录：%s\n' "$BASE_DIR"
REVISION=$(curl --fail --silent --show-error --max-time 30 'https://api.github.com/repos/xunova1121/-/commits/claude%2Fjolly-darwin-tijh97' | node --input-type=module -e "let x='';for await(const c of process.stdin)x+=c;const s=JSON.parse(x).sha;if(!/^[a-f0-9]{40}$/.test(s))process.exit(1);process.stdout.write(s)")
curl --fail --silent --show-error --max-time 120 --max-filesize 100000000 "https://codeload.github.com/xunova1121/-/tar.gz/$REVISION" -o "$BASE_DIR/source.tar.gz"
mkdir "$BASE_DIR/source"
tar -xzf "$BASE_DIR/source.tar.gz" -C "$BASE_DIR/source" --strip-components=1
TEST_APP="$BASE_DIR/source/jarvis"
PRODUCTION_APP="${JARVIS_PRODUCTION_APP:-/opt/jarvis/current}"
if [ -d "$PRODUCTION_APP/node_modules" ] && cmp -s "$PRODUCTION_APP/package-lock.json" "$TEST_APP/package-lock.json"; then
  ln -s "$PRODUCTION_APP/node_modules" "$TEST_APP/node_modules"
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
