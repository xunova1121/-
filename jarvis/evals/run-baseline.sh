#!/usr/bin/env bash
set -euo pipefail

# 使用私有环境中的评测专用授权，不读取访问密码。
cd -- "$(dirname -- "$0")/.."
command -v node >/dev/null || { echo '需要 Node.js 22 或更新版本'; exit 1; }
export JARVIS_EVAL_URL="${JARVIS_EVAL_URL:-http://127.0.0.1:8787}"
[ -n "${JARVIS_EVAL_TOKEN:-}" ] || { echo '需要设置页生成的评测专用令牌JARVIS_EVAL_TOKEN；不要发送到对话'; exit 1; }
export JARVIS_EVAL_TOKEN

BENCH_OUTPUT=$(mktemp -d /tmp/weiyang-baseline-XXXXXX)
node evals/baseline.mjs --live --out-dir="$BENCH_OUTPUT/results"

# 可分享摘要只含题号、计时和检查状态；完整回答留在私有报告里供人工复核。
node --input-type=module - "$BENCH_OUTPUT/results/report.json" "$BENCH_OUTPUT/summary.json" <<'JS'
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const summary = {
  suiteVersion: report.suiteVersion,
  provider: report.provider,
  model: report.model,
  startedAt: report.startedAt,
  finishedAt: report.finishedAt,
  mixedModel: report.mixedModel,
  summary: report.summary,
  results: report.results.map(({ id, status, quality, metrics }) => ({ id, status, quality, metrics })),
};
fs.writeFileSync(process.argv[3], JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(`可分享测速摘要：${process.argv[3]}`);
console.log('完整报告含回答，请先检查隐私，再决定是否提供；摘要不代表语义准确率。');
JS
