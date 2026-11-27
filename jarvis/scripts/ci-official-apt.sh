#!/usr/bin/env bash
set -euo pipefail

# 仅调整 GitHub 临时 Linux 构建机。保留软件包签名、发行版和其他源；不用于用户服务器。
# 416 的 Azure 镜像多次停顿，使环境安装耗尽总作业时间；换用 Ubuntu 官方 HTTPS 源。
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ]]; then
  echo '非 GitHub Linux 构建机，不改软件源。'
  exit 0
fi
rules="$(dirname "${BASH_SOURCE[0]}")/ci-ubuntu-mirrors.sed"
for source_file in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
  if [[ -f "$source_file" ]]; then
    sudo sed -E -i -f "$rules" "$source_file"
  fi
done
