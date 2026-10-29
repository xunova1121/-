#!/usr/bin/env bash
# 一次性：装好“技能运行器”，让未央能运行技能里的 Python / Node 脚本（手机、电脑在服务器模式下都能用）。
#   用 root 运行：bash /opt/jarvis/current/deploy/skill-runner/setup.sh
# 会做这些事：
#   1. 没有 Docker 就装上并启动（装不上会提示用宝塔“Docker”一键安装后再运行本脚本）
#   2. 腾讯云服务器：配置腾讯云内网的镜像加速（国内拉不动 Docker Hub）
#   3. 构建镜像 jarvis-skill-runner（Python 3 + Node，几分钟）
#   4. 让运行未央的 jarvis 账号能用 Docker，并重启未央
# 安全说明：能用 Docker 的账号权限很大（接近 root）。未央只用 Docker 跑隔离容器（不挂你的数据、不传密钥、非 root、限资源），
# 但技能脚本可以联网，所以只装你信得过的技能。不想要了：gpasswd -d jarvis docker && systemctl restart jarvis
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "请用 root 运行（sudo bash $0）"; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
BASE=/opt/jarvis
IMAGE="${JARVIS_SKILL_RUNNER_IMAGE:-jarvis-skill-runner}"

if ! command -v docker >/dev/null 2>&1; then
  echo "== 安装 Docker"
  if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    PM="$(command -v dnf || command -v yum)"
    "$PM" install -y docker-ce 2>/dev/null || "$PM" install -y docker 2>/dev/null || "$PM" install -y moby-engine 2>/dev/null || true
  elif command -v apt-get >/dev/null 2>&1; then
    (export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq docker.io) || true
  fi
  command -v docker >/dev/null 2>&1 || { echo "Docker 没装上：请在宝塔面板“Docker”里一键安装，装好后再运行本脚本"; exit 1; }
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# 腾讯云：用内网镜像加速（只在腾讯云服务器上能连上）。已有加速配置但拉不动（比如早已停用的中科大镜像），换成腾讯云的，原配置备份成 daemon.json.bak
if curl -s -m 5 -o /dev/null https://mirror.ccs.tencentyun.com/v2/; then
  if [[ ! -s /etc/docker/daemon.json ]]; then
    echo "== 配置腾讯云 Docker 镜像加速"
    mkdir -p /etc/docker
    printf '{\n  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]\n}\n' > /etc/docker/daemon.json
    systemctl restart docker
  elif ! timeout 120 docker pull -q python:3.12-slim-bookworm >/dev/null 2>&1; then
    echo "== 现有的 Docker 镜像加速拉不动，换成腾讯云的（原配置备份为 /etc/docker/daemon.json.bak）"
    cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
    python3 -c "import json;p='/etc/docker/daemon.json';d=json.load(open(p));d['registry-mirrors']=['https://mirror.ccs.tencentyun.com'];json.dump(d,open(p,'w'),indent=2)"
    systemctl restart docker
  fi
fi

echo "== 构建镜像 $IMAGE（第一次几分钟）"
if ! docker build -t "$IMAGE" "$DIR"; then
  # 国内常拉不到 Docker Hub 的基础镜像（加速地址失效、内网镜像解析不了）：改用本机系统软件源拼一个
  echo "== 拉不到基础镜像，改用本机系统软件源构建"
  bash "$DIR/build-rootfs.sh" "$IMAGE"
fi
docker run --rm --user 65534:65534 "$IMAGE" sh -c 'python3 --version && node --version'

# 仅需要真实浏览器验收的技能（如Archify）选装；普通技能不额外下载Chromium。
if [[ "${JARVIS_SKILL_BROWSER:-0}" == 1 ]]; then
  docker build --build-arg "BASE=$IMAGE" -f "$DIR/Dockerfile.browser" -t "$IMAGE-browser" "$DIR"
  docker run --rm --user 65534:65534 "$IMAGE-browser" chromium --version
  docker tag "$IMAGE-browser" "$IMAGE"
fi

echo "== 让 jarvis 账号能用 Docker"
id jarvis >/dev/null 2>&1 || { echo "没找到 jarvis 账号：先按部署说明装好未央服务器版"; exit 1; }
usermod -aG docker jarvis
mkdir -p "$BASE/data/skill-runner"
chown jarvis:jarvis "$BASE/data/skill-runner"
ENVF="$BASE/jarvis.env"
if [[ -f "$ENVF" ]] && ! grep -q '^JARVIS_SKILL_RUNNER_IMAGE=' "$ENVF"; then echo "JARVIS_SKILL_RUNNER_IMAGE=$IMAGE" >> "$ENVF"; fi
systemctl restart jarvis
echo "== 好了：手机 / 电脑的“技能”页会显示“技能运行器：已装好”。带脚本的技能装上就能运行。"
