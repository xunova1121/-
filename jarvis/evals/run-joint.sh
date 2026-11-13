#!/usr/bin/env bash
set -euo pipefail
# 30题联合复测：受限授权跑题（每题两次）并保存私有原回答，评审/校准另行安排。
# 仅使用私有环境中的评测专用授权，不读取访问密码。
cd -- "$(dirname -- "$0")/.."
command -v node >/dev/null || { echo '需要 Node.js 22'; exit 1; }
export JARVIS_EVAL_URL="${JARVIS_EVAL_URL:-http://127.0.0.1:8787}"
[ -n "${JARVIS_EVAL_TOKEN:-}" ] || { echo '请先在设置页生成评测专用令牌，并仅保存到私有环境变量JARVIS_EVAL_TOKEN；不启动模型'; exit 1; }
export JARVIS_EVAL_TOKEN
export JARVIS_EVAL_DATA="${JARVIS_EVAL_DATA:-/opt/jarvis/data}"
OUT="${JOINT_OUT:-/root/weiyang-joint-$(date +%Y%m%d-%H%M)}"
EXTRA=()
[ -n "${JOINT_EXPECT_VERSION:-}" ] && EXTRA+=("--expected-version=$JOINT_EXPECT_VERSION")
[ "${JOINT_SPEED_QUALITY:-0}" = "1" ] && EXTRA+=("--speed-quality")
[ "${JOINT_FOCUS:-0}" = "1" ] && EXTRA+=("--focus")
[ -n "${JOINT_ONLY:-}" ] && EXTRA+=("--only=$JOINT_ONLY")
[ -n "${JOINT_PREVIOUS:-}" ] && EXTRA+=("--previous=$JOINT_PREVIOUS")
[ -n "${JOINT_BASELINE:-}" ] && EXTRA+=("--baseline=$JOINT_BASELINE")
[ -n "${JOINT_PRICES:-}" ] && EXTRA+=("--prices=$JOINT_PRICES")
node evals/joint.mjs --live --out-dir="$OUT" "${EXTRA[@]}"
echo "原回答已保存；模型评分需单独执行与核对，执行结束不代表通过。"
node --input-type=module -e "import fs from 'node:fs'; import { summaryMarkdown } from './evals/joint-report.mjs'; const r = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); fs.writeFileSync(process.argv[2], summaryMarkdown(r), { mode: 0o600 });" "$OUT/report.json" "$OUT/摘要.md"
echo "完成。白话摘要：$OUT/摘要.md；评分/校准待执行；完整报告（含回答原文）：$OUT/report.json"
