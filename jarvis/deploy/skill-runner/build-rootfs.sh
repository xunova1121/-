#!/usr/bin/env bash
# 拉不到 Docker Hub 的基础镜像时用：用本机系统自带的软件源（如 OpenCloudOS / CentOS 的国内源）
# 装一套最小的 Python 3 + Node 环境，直接导入成镜像 jarvis-skill-runner，不经过任何 Docker 镜像仓库。
#   用 root 运行：bash build-rootfs.sh [镜像名]
set -euo pipefail
IMAGE="${1:-jarvis-skill-runner}"
command -v dnf >/dev/null 2>&1 || { echo "没有 dnf，这个办法只适合 OpenCloudOS / CentOS / Rocky 这类系统"; exit 1; }
RV="$(python3 -c 'import dnf;print(dnf.Base().conf.releasever)')"
R="$(mktemp -d /tmp/skillroot.XXXXXX)"
trap 'rm -rf "$R"' EXIT
echo "== 用系统软件源装 Python 3 + Node（系统版本 $RV，几分钟）"
D=(dnf -y --installroot="$R" --releasever="$RV" --setopt=reposdir=/etc/yum.repos.d --setopt=install_weak_deps=False)
"${D[@]}" install python3 python3-pip nodejs coreutils bash ca-certificates findutils
"${D[@]}" install npm || echo "== 没找到单独的 npm 包（有的系统 npm 跟着 nodejs 一起装）"
"${D[@]}" clean all >/dev/null 2>&1 || true
echo "== 导入成镜像 $IMAGE"
tar -C "$R" -c . | docker import -c 'CMD ["python3", "--version"]' - "$IMAGE"
docker run --rm --user 65534:65534 "$IMAGE" sh -c 'python3 --version && node --version'
