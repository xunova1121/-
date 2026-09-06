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

# ── 直接问容器，不走 HTTP，也就不需要口令 ──
#
# 上一版是拿 FD_TOKEN 去请求 /api/health。那要求口令写在 .env 里，
# 而 docker-compose.yml 里 FD_TOKEN 是**可选**的：不填的话应用第一次
# 启动会自己生成一个、存在数据卷里，只打印在 docker logs 里。
# 也就是说，在这个项目自己推荐的那种装法下，核对这一步**永远跳过** ——
# 而它恰恰是整个脚本存在的理由。用户跑完看到的是一句"跳过核对，
# 请自己打开页面看版本号"，等于什么都没验。
#
# 换成在容器里跑一行 node，读的是应用自己那份 version.info()：
# 同一段代码、同一个来源，页面上显示的就是这个数。不碰网络、不碰口令。
RUNNING=""
for _ in $(seq 1 30); do
  RUNNING="$(docker compose exec -T app node -e '
    import("./core/version.js").then((v) => console.log(v.info().build)).catch(() => console.log(""));
  ' 2>/dev/null | tr -d '\r\n ' || true)"
  [ -n "$RUNNING" ] && break
  sleep 2
done

if [ -z "$RUNNING" ]; then
  bad "起来了但问不到版本。看一眼它在干什么：docker compose logs --tail=40 app"
  exit 1
fi

if [ "$RUNNING" = "dev" ]; then
  # 镜像是在没有 FD_BUILD 的情况下建的（比如有人手敲了一遍 docker compose up -d --build）。
  # 这时候核对不出结论 —— 说清楚是"验不了"，别含糊成"通过了"
  bad "容器报的是 dev：这个镜像建的时候没带提交号，核对不出它到底是哪一版"
  echo "  重建一次就好："
  echo "    FD_BUILD=$AFTER docker compose up -d --build"
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
