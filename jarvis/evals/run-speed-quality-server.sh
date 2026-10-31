#!/usr/bin/env bash
# 在用户服务器启动私有后台评测；只复用已安装依赖，不修改正式源码或服务。
set -euo pipefail
umask 077
REVISION="${1:-}"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo '需要固定的40位评测提交号'; exit 1; }
APP="${JARVIS_PRODUCTION_APP:-/opt/jarvis/current}"
[ -f "$APP/evals/joint.mjs" ] && [ -d "$APP/node_modules" ] || { echo '未找到已安装服务的评测入口/依赖；请设置JARVIS_PRODUCTION_APP'; exit 1; }
[ -r /opt/jarvis/jarvis.env ] || { echo '后台启动需要服务器本地jarvis.env；不要向聊天发送密码'; exit 1; }
command -v node >/dev/null
command -v curl >/dev/null
STAGE="$(mktemp -d /tmp/weiyang-speed-quality-XXXXXX)"
mkdir "$STAGE/app"
cp "$APP/package.json" "$STAGE/app/package.json"
cp -a "$APP/evals" "$STAGE/app/evals"
for part in src shared server node_modules; do ln -s "$APP/$part" "$STAGE/app/$part"; done
for file in joint.mjs joint-evidence.mjs joint-files.mjs joint-rubric.mjs joint-report.mjs speed-quality-cases.mjs speed-quality-report.mjs run-joint.sh; do
  curl -fsSL --retry 2 --connect-timeout 10 --max-time 60 --max-filesize 1000000 -H 'Accept: application/vnd.github.raw+json' "https://api.github.com/repos/xunova1121/-/contents/jarvis/evals/$file?ref=$REVISION" -o "$STAGE/app/evals/$file"
done
node --check "$STAGE/app/evals/joint.mjs"
bash -n "$STAGE/app/evals/run-joint.sh"
cat > "$STAGE/run.sh" <<'RUN'
#!/usr/bin/env bash
set -uo pipefail
umask 077
BASE="$(cd -- "$(dirname -- "$0")" && pwd)"
export JOINT_EXPECT_VERSION="${JOINT_EXPECT_VERSION:-1.0.351}" JOINT_SPEED_QUALITY=1 JOINT_OUT="$BASE/results"
bash "$BASE/app/evals/run-joint.sh"
RESULT=$?
if [ -f "$BASE/results/report.json" ]; then
  node "$BASE/app/evals/speed-quality-report.mjs" "$BASE/results/report.json" "$BASE/results/speed-quality.json" || RESULT=1
  tar -czf "$BASE/results.tar.gz" -C "$BASE" results
  printf '私有结果包（含回答与文件）：%s\n' "$BASE/results.tar.gz"
fi
printf '评测退出码：%s（执行结束不代表质量通过）\n' "$RESULT"
exit "$RESULT"
RUN
nohup bash "$STAGE/run.sh" > "$STAGE/run.log" 2>&1 < /dev/null &
printf '评测提交：%s\n后台PID：%s\n日志：%s\n' "$REVISION" "$!" "$STAGE/run.log"
echo '保持当前模型配置不变；评测期间请勿在未央另开任务。无需保持终端连接。'
