#!/usr/bin/env bash
set -euo pipefail
# 30 题联合复测（在未央服务器上用 root 运行）：跑题（每题两次）→ 自动评审 → 抽 10 题给你校准 → 白话摘要。
# 登录密码从 /opt/jarvis/jarvis.env 读（不打印）；读不到就让你输入。模型 Key 只在服务器本地用，不写进报告。
cd -- "$(dirname -- "$0")/.."
command -v node >/dev/null || { echo '需要 Node.js 22'; exit 1; }
export JARVIS_EVAL_URL="${JARVIS_EVAL_URL:-http://127.0.0.1:8787}"
ENVF=/opt/jarvis/jarvis.env
PASSWORD=""
if [ -r "$ENVF" ]; then PASSWORD=$(set -a; . "$ENVF"; printf '%s' "${JARVIS_PASSWORD:-}"); export JARVIS_DATA=$(set -a; . "$ENVF"; printf '%s' "${JARVIS_DATA:-/opt/jarvis/data}"); fi
if [ -z "$PASSWORD" ]; then read -r -s -p '输入未央服务器登录密码：' PASSWORD </dev/tty; echo; fi
JARVIS_EVAL_TOKEN=$(printf 'jarvis-server:%s' "$PASSWORD" | node --input-type=module -e "import fs from 'node:fs'; import crypto from 'node:crypto'; process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(0)).digest('hex'))")
export JARVIS_EVAL_TOKEN
unset PASSWORD
trap 'unset JARVIS_EVAL_TOKEN' EXIT
OUT="${JOINT_OUT:-/root/weiyang-joint-$(date +%Y%m%d-%H%M)}"
EXTRA=()
[ -n "${JOINT_EXPECT_VERSION:-}" ] && EXTRA+=("--expected-version=$JOINT_EXPECT_VERSION")
[ "${JOINT_SPEED_QUALITY:-0}" = "1" ] && EXTRA+=("--speed-quality")
[ -n "${JOINT_PREVIOUS:-}" ] && EXTRA+=("--previous=$JOINT_PREVIOUS")
[ -n "${JOINT_BASELINE:-}" ] && EXTRA+=("--baseline=$JOINT_BASELINE")
[ -n "${JOINT_PRICES:-}" ] && EXTRA+=("--prices=$JOINT_PRICES")
node evals/joint.mjs --live --out-dir="$OUT" "${EXTRA[@]}"
node evals/joint-judge.mjs "$OUT/report.json" ${JOINT_JUDGE:+--judge=$JOINT_JUDGE}
node evals/joint-calibrate.mjs sample "$OUT/report.json"
node --input-type=module -e "import fs from 'node:fs'; import { summaryMarkdown } from './evals/joint-report.mjs'; const r = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); fs.writeFileSync(process.argv[2], summaryMarkdown(r), { mode: 0o600 });" "$OUT/report.json" "$OUT/摘要.md"
echo "完成。白话摘要：$OUT/摘要.md；给你打分的：$OUT/校准打分表.md；完整报告（含回答原文）：$OUT/report.json"
