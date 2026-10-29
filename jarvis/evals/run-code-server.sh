#!/usr/bin/env bash
set -euo pipefail
umask 077
command -v node >/dev/null
command -v curl >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || { echo '需要Node.js 20或更高版本，未请求模型' >&2; exit 1; }
command -v docker >/dev/null || { echo '缺少Docker，请先安装并启动本机Docker；未请求模型' >&2; exit 1; }
timeout 10 docker --host=unix:///var/run/docker.sock version --format '{{.Server.Version}}' >/dev/null 2>&1 || { echo '本机Docker守护进程不可用；未请求模型' >&2; exit 1; }
BASE_DIR="$(mktemp -d /tmp/weiyang-code-live-XXXXXX)"
RUNTIME='https://raw.githubusercontent.com/xunova1121/-/refs/heads/claude/jolly-darwin-tijh97/jarvis/evals'
QUERY="$(date +%s)-$$"
printf '隔离代码测试目录：%s\n' "$BASE_DIR"
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 --max-filesize 1000000 "$RUNTIME/code-runtime-manifest.json?v=$QUERY" -o "$BASE_DIR/manifest.json"
if ! read -r CODE_REVISION FETCH_HASH FETCH_BYTES < <(node - "$BASE_DIR/manifest.json" <<'NODE'
const fs = require('node:fs');
try {
const blob = fs.readFileSync(process.argv[2]);
if (blob.length > 1e6) process.exit(1);
const manifest = JSON.parse(blob);
const entry = manifest.files?.find(file => file.path === 'evals/architecture-runtime-fetch.mjs');
if (!/^[a-f0-9]{40}$/.test(manifest.revision) || !/^[a-f0-9]{64}$/.test(entry?.sha256) || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 1 || entry.bytes > 20e6) process.exit(1);
console.log(manifest.revision, entry.sha256, entry.bytes);
} catch { process.exit(1); }
NODE
); then echo '代码清单缺少固定版本或准备器摘要，未请求模型' >&2; exit 1; fi
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 --max-filesize "$FETCH_BYTES" "https://raw.githubusercontent.com/xunova1121/-/$CODE_REVISION/jarvis/evals/architecture-runtime-fetch.mjs" -o "$BASE_DIR/fetch.mjs"
node - "$BASE_DIR/fetch.mjs" "$FETCH_HASH" "$FETCH_BYTES" <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto');
const bytes = fs.readFileSync(process.argv[2]);
if (bytes.length !== Number(process.argv[4]) || crypto.createHash('sha256').update(bytes).digest('hex') !== process.argv[3]) {
  console.error('准备器下载哈希不符，未执行代码或请求模型'); process.exit(1);
}
NODE
PRODUCTION_APP="${JARVIS_PRODUCTION_APP:-/opt/jarvis/current}"
[ -d "$PRODUCTION_APP" ] || { echo '正式程序目录不存在，请设置JARVIS_PRODUCTION_APP；未请求模型' >&2; exit 1; }
TEST_APP="$BASE_DIR/source/jarvis"
node "$BASE_DIR/fetch.mjs" "$BASE_DIR/manifest.json" "$PRODUCTION_APP" "$TEST_APP"
if [ -d "$PRODUCTION_APP/node_modules" ] && cmp -s "$PRODUCTION_APP/package-lock.json" "$TEST_APP/package-lock.json"; then
  ln -s "$PRODUCTION_APP/node_modules" "$TEST_APP/node_modules"
else
  (cd "$TEST_APP" && npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com)
fi
node "$TEST_APP/evals/code-runtime.mjs" "$BASE_DIR/manifest.json" "$TEST_APP"
export JARVIS_TEST_REVISION="$(cat "$TEST_APP/runtime-revision.txt")"
printf '固定测试源码：%s；不更新正式服务、不推送测试仓库。\n' "$JARVIS_TEST_REVISION"
RESULT=0
JARVIS_CODE_SANDBOX_IMAGE="${JARVIS_CODE_SANDBOX_IMAGE:-node:22-bookworm-slim}" node "$TEST_APP/evals/code-server.mjs" --live "--data-dir=${JARVIS_PRODUCTION_DATA:-/opt/jarvis/data}" "--out-dir=$BASE_DIR/results" || RESULT=$?
if [ -f "$BASE_DIR/results/report.json" ]; then
  tar -czf "$BASE_DIR/code-results.tar.gz" -C "$BASE_DIR/results" report.json
  printf '私有结果包：%s/code-results.tar.gz\n' "$BASE_DIR"
fi
exit "$RESULT"
