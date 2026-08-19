#!/usr/bin/env bash
#
# 服务器一键更新。在服务器上、desktop/ 目录里跑：
#
#     bash scripts/update-server.sh
#
# ── 为什么值得单开一个脚本 ──
#
# 手打那三条命令（pull / build / up）本身不难，难的是**它们能失败得很安静**：
# pull 到了但镜像用了缓存层、build 成功但容器没重建、
# 端口起来了但应用在里面崩溃重启。三种都是"命令回了 0，页面还是旧的"。
#
# 所以这个脚本干的其实是最后那件事：**更新完自己去核对一遍**，
# 把跑着的那个提交号和刚拉下来的比一比，不一样就红着退出并说清楚。
#
# ⚠ 只做更新，不碰数据。项目、密钥、成片都在 fd-data 卷里，全程没有一条命令动它。

set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
bad() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }

# ── 先看清楚现在是什么状态 ──
BEFORE="$(git rev-parse --short HEAD)"
say "当前：$BEFORE"

# 本地有没有改过的文件。有的话 pull 会失败，与其让 git 报一句难懂的话，
# 不如提前说清楚 —— 服务器上"顺手改了个配置"是很常见的事
if ! git diff --quiet || ! git diff --cached --quiet; then
  bad "工作区有未提交的改动，先处理掉再更新："
  git status --short
  exit 1
fi

say "拉最新代码"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git pull origin "$BRANCH"

AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "代码已经是最新的（$AFTER）"
else
  ok "$BEFORE → $AFTER"
  git log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'
fi

# ── 重建并起来 ──
#
# FD_BUILD 把提交号钉进镜像。少了它，下面那步核对就无从谈起 ——
# 这也正是这个变量存在的唯一理由。
say "重建镜像并重启（数据不动）"
FD_BUILD="$AFTER" docker compose up -d --build

# ── 核对：跑着的到底是不是刚拉的那一版 ──
#
# 这一步才是这个脚本的重点。前面每一条命令都可能回 0 而实际没生效。
say "核对跑着的版本"

TOKEN=""
if [ -f .env ]; then
  # 只去掉两头的引号和空白。用 tr -d 会把**中间**的字符也删掉 ——
  # 口令是复制粘贴的，删错一个字符就变成"口令不对"，而看上去完全正常
  TOKEN="$(grep -E '^FD_TOKEN=' .env | head -1 | sed -E "s/^FD_TOKEN=//; s/^[[:space:]]*//; s/[[:space:]]*$//; s/^[\"']//; s/[\"']$//" || true)"
fi
if [ -z "$TOKEN" ]; then
  bad "在 .env 里没找到 FD_TOKEN，跳过核对 —— 请自己打开页面看「设置」最下面那行版本号"
  exit 0
fi

# 容器刚起来，给它几秒。轮询而不是死等固定秒数：好了就立刻往下走
RUNNING=""
for _ in $(seq 1 30); do
  # 口令用 -e 传进容器，不拼进命令行 —— 拼进去它会留在 shell 历史和 ps 输出里
  RUNNING="$(docker compose exec -T -e K="$TOKEN" app node -e '
    fetch("http://127.0.0.1:5178/api/health", { headers: { "x-fd-key": process.env.K } })
      .then((r) => r.json())
      .then((j) => console.log(j.build || ""))
      .catch(() => console.log(""));
  ' 2>/dev/null | tr -d '\r\n ' || true)"
  [ -n "$RUNNING" ] && break
  sleep 2
done

if [ -z "$RUNNING" ]; then
  bad "起来了但问不到版本。看一眼它在干什么：docker compose logs --tail=40 app"
  exit 1
fi

if [ "$RUNNING" = "$AFTER" ]; then
  ok "跑着的就是 $AFTER —— 更新确实生效了"
else
  bad "跑着的是 $RUNNING，而刚拉的是 $AFTER —— 更新没生效"
  echo "  多半是镜像用了缓存层或者容器没重建。强制重来一次："
  echo "    FD_BUILD=$AFTER docker compose build --no-cache app && docker compose up -d"
  exit 1
fi
