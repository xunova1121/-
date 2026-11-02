#!/usr/bin/env bash
# 重点复测只读正式配置；在私有副本执行，不更新正式服务、不推送测试仓库。
set -euo pipefail
umask 077
FOCUS_REVISION="${1:-}"
[[ "$FOCUS_REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo '需要固定40位评测提交号'; exit 1; }
FOCUS_APP="${JARVIS_PRODUCTION_APP:-/opt/jarvis/current}"
FOCUS_EXPECT_VERSION="${2:-}"
[[ -z "$FOCUS_EXPECT_VERSION" || "$FOCUS_EXPECT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '期望服务版本格式不正确'; exit 1; }
if [ -n "$FOCUS_EXPECT_VERSION" ]; then export JOINT_EXPECT_VERSION="$FOCUS_EXPECT_VERSION"; fi
[ -f "$FOCUS_APP/evals/joint.mjs" ] && [ -d "$FOCUS_APP/node_modules" ] || { echo '未找到已安装服务；请设置JARVIS_PRODUCTION_APP'; exit 1; }
[ -n "${JARVIS_EVAL_TOKEN:-}" ] || { echo '需要独立的评测授权；请在安全批完成后生成评测专用令牌，不读取访问密码，未启动模型请求'; exit 1; }
command -v node >/dev/null
command -v curl >/dev/null
FOCUS_STAGE="$(mktemp -d /tmp/weiyang-focus-XXXXXX)"
mkdir "$FOCUS_STAGE/app"
cp "$FOCUS_APP/package.json" "$FOCUS_STAGE/app/package.json"
cp -aL "$FOCUS_APP/evals" "$FOCUS_STAGE/app/evals"
cp -aL "$FOCUS_APP/shared" "$FOCUS_STAGE/app/shared"
for part in src server node_modules; do ln -s "$FOCUS_APP/$part" "$FOCUS_STAGE/app/$part"; done
for relative in evals/evaluation-auth.mjs evals/focus-cases.mjs evals/focus-code-evidence.mjs evals/focus-report.mjs evals/joint.mjs evals/runner.mjs evals/joint-report.mjs evals/joint-calibrate.mjs shared/capabilityReadiness.js; do
  curl -fsSL --retry 2 --connect-timeout 10 --max-time 60 --max-filesize 1000000 -H 'Accept: application/vnd.github.raw+json' "https://api.github.com/repos/xunova1121/-/contents/jarvis/$relative?ref=$FOCUS_REVISION" -o "$FOCUS_STAGE/app/$relative"
done
node "$FOCUS_STAGE/app/evals/joint.mjs" --focus > "$FOCUS_STAGE/plan.json"
cat > "$FOCUS_STAGE/run.sh" <<'RUN'
#!/usr/bin/env bash
set -uo pipefail
umask 077
FOCUS_BASE="$(cd -- "$(dirname -- "$0")" && pwd)"
export JOINT_FOCUS=1 JOINT_SPEED_QUALITY=0 JOINT_OUT="$FOCUS_BASE/results"
unset JOINT_ONLY
export JARVIS_EVAL_URL="${JARVIS_EVAL_URL:-http://127.0.0.1:8787}"
FOCUS_EXTRA=()
[ -n "${JOINT_EXPECT_VERSION:-}" ] && FOCUS_EXTRA+=("--expected-version=$JOINT_EXPECT_VERSION")
node "$FOCUS_BASE/app/evals/joint.mjs" --live --focus "--out-dir=$FOCUS_BASE/results" "${FOCUS_EXTRA[@]}"
FOCUS_RESULT=$?
if [ -f "$FOCUS_BASE/results/report.json" ]; then
  node "$FOCUS_BASE/app/evals/focus-report.mjs" "$FOCUS_BASE/results/report.json" || FOCUS_RESULT=1
  printf '真实回答已私有保存，模型评分与人工校准尚未执行；不把执行结束当质量通过。\n'
fi
if [ -d "$FOCUS_BASE/results" ]; then
  tar -czf "$FOCUS_BASE/results.tar.gz" -C "$FOCUS_BASE" results
  printf '私有结果包（含回答和文件）：%s\n' "$FOCUS_BASE/results.tar.gz"
fi
printf '执行退出码：%s（结束不等于质量通过）\n' "$FOCUS_RESULT"
exit "$FOCUS_RESULT"
RUN
export JARVIS_EVAL_REVISION="$FOCUS_REVISION"
nohup bash "$FOCUS_STAGE/run.sh" > "$FOCUS_STAGE/run.log" 2>&1 < /dev/null &
printf '重点评测提交：%s\n后台PID：%s\n日志：%s\n' "$FOCUS_REVISION" "$!" "$FOCUS_STAGE/run.log"
echo '只测五类重点任务，各两次；保持当前默认模型，不更新服务、不推送仓库。将调用真实模型并消耗现有额度，请勿同时另开任务。'
