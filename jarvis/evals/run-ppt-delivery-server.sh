#!/usr/bin/env bash
# 固定版本、后台隔离三步验收。只读正式配置；不重启服务，不部署。
set -euo pipefail
umask 077
MANIFEST_REVISION="${1:-}"
[[ "$MANIFEST_REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo '需要固定40位清单提交号'; exit 1; }
command -v node >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
if [ "${2:-}" != '--worker' ]; then
  BASE_DIR="$(mktemp -d /tmp/weiyang-ppt-live-XXXXXX)"
  cp "$0" "$BASE_DIR/run.sh"
  nohup bash "$BASE_DIR/run.sh" "$MANIFEST_REVISION" --worker > "$BASE_DIR/run.log" 2>&1 < /dev/null &
  printf '后台PID：%s\n日志：%s/run.log\n' "$!" "$BASE_DIR"
  echo '保持当前模型，终端可以断开。将运行真实模型与配图，可能消耗现有接口额度；不更新正式服务。'
  exit 0
fi
BASE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TRANSPORT=github-api
QUERY="$(date +%s)-$$"
download_code() {
  local revision="$1" relative="$2" target="$3" maximum="$4"
  if [ "$TRANSPORT" = github-api ]; then
    curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 --max-filesize "$maximum" -H 'Accept: application/vnd.github.raw+json' "https://api.github.com/repos/xunova1121/-/contents/jarvis/$relative?ref=$revision&v=$QUERY" -o "$target"
  else
    curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 --max-filesize "$maximum" "https://raw.githubusercontent.com/xunova1121/-/$revision/jarvis/$relative?v=$QUERY" -o "$target"
  fi
}
printf '隔离PPT测试目录：%s\n' "$BASE_DIR"
download_code "$MANIFEST_REVISION" evals/code-runtime-manifest.json "$BASE_DIR/manifest.json" 1000000
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
download_code "$CODE_REVISION" evals/architecture-runtime-fetch.mjs "$BASE_DIR/fetch.mjs" "$FETCH_BYTES"
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
if [ "$TRANSPORT" = github-api ]; then
  node --input-type=module - "$BASE_DIR/fetch.mjs" "$BASE_DIR/manifest.json" "$PRODUCTION_APP" "$TEST_APP" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [helper, file, production, target] = process.argv.slice(2);
const {prepareRuntime} = await import(pathToFileURL(helper).href);
const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
const prefix = '/xunova1121/-/' + manifest.revision + '/jarvis/';
await prepareRuntime(manifest, production, target, {fetchFile: async (url, output, maximum) => {
  const raw = new URL(url);
  if (raw.origin !== 'https://raw.githubusercontent.com' || !raw.pathname.startsWith(prefix)) throw new Error('固定版本源码地址不符');
  const api = 'https://api.github.com/repos/xunova1121/-/contents/jarvis/' + raw.pathname.slice(prefix.length) + '?ref=' + manifest.revision;
  await promisify(execFile)('curl', ['-fsSL','--connect-timeout','15','--max-time','60','--retry','2','--max-filesize',String(Math.max(1,maximum)),'-H','Accept: application/vnd.github.raw+json',api,'-o',output], {timeout:200000,maxBuffer:64000});
},progress: item => console.log(`代码 ${item.done}/${item.total}；复用${item.reused}；下载${item.downloaded}`)});
await fs.writeFile(path.join(target,'runtime-revision.txt'),manifest.revision,{mode:0o600});
NODE
else
  node "$BASE_DIR/fetch.mjs" "$BASE_DIR/manifest.json" "$PRODUCTION_APP" "$TEST_APP"
fi
if [ -d "$PRODUCTION_APP/node_modules" ] && cmp -s "$PRODUCTION_APP/package-lock.json" "$TEST_APP/package-lock.json"; then
  ln -s "$PRODUCTION_APP/node_modules" "$TEST_APP/node_modules"
else
  (cd "$TEST_APP" && npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com)
fi
node "$TEST_APP/evals/code-runtime.mjs" "$BASE_DIR/manifest.json" "$TEST_APP"
export JARVIS_TEST_REVISION="$(cat "$TEST_APP/runtime-revision.txt")"
printf '固定测试源码：%s；不更新正式服务。\n' "$JARVIS_TEST_REVISION"
RESULT=0
node "$TEST_APP/evals/ppt-delivery-live.mjs" --live "--data-dir=${JARVIS_PRODUCTION_DATA:-/opt/jarvis/data}" "--out-dir=$BASE_DIR/results" || RESULT=$?
if [ -f "$BASE_DIR/results/report.json" ]; then
  MEMBERS=(report.json runtime-private.log)
  [ ! -d "$BASE_DIR/results/artifacts" ] || MEMBERS+=(artifacts)
  tar -czf "$BASE_DIR/ppt-results.tar.gz" -C "$BASE_DIR/results" "${MEMBERS[@]}"
  printf '私有结果包：%s/ppt-results.tar.gz\n' "$BASE_DIR"
fi
printf '执行退出码：%s；不代表视觉通过。\n' "$RESULT"
exit "$RESULT"
