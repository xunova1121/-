#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
cd -- "$(dirname -- "$0")/.."
EXPECTED_VERSION="${1:-}"
if [[ ! "$EXPECTED_VERSION" =~ ^1\.0\.[0-9]+$ ]] || [[ ! -f VERSION ]] || [[ "$(tr -d '\r\n' < VERSION)" != "$EXPECTED_VERSION" ]]; then
  echo '请传入本次发布的版本号，并先更新服务器到该版本；未请求模型。'
  exit 1
fi
if pgrep -f '[n]ode .*evals/(market-time-live|joint)[.]mjs' >/dev/null; then
  echo '已有评测进程，请等它结束；未重复启动。'
  exit 1
fi
read -r -s -p '评测专用令牌（不显示；不要填访问密码）：' JARVIS_EVAL_TOKEN
printf '\n'
[[ -n "$JARVIS_EVAL_TOKEN" ]] || { echo '未输入令牌，未启动。'; exit 1; }
export JARVIS_EVAL_TOKEN
export JARVIS_EVAL_URL="${JARVIS_EVAL_URL:-http://127.0.0.1:8787}"
WEIYANG_ACCEPTANCE_DIR=$(mktemp -d /tmp/weiyang-market-time-XXXXXXXX)
nohup node evals/market-time-live.mjs --live "--expected-version=$EXPECTED_VERSION" "--out-dir=$WEIYANG_ACCEPTANCE_DIR/results" > "$WEIYANG_ACCEPTANCE_DIR/run.log" 2>&1 < /dev/null &
unset JARVIS_EVAL_TOKEN
printf '后台PID：%s\n日志：%s/run.log\n' "$!" "$WEIYANG_ACCEPTANCE_DIR"
echo '保持当前模型；15题每题一次，失败即停。期间请勿在未央另开任务。报告需人工核对，不自动记质量通过。'
