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

# 腾讯云：用内网镜像加速（只在腾讯云服务器上能连上；已有 daemon.json 的不改）
if [[ ! -s /etc/docker/daemon.json ]] && curl -s -m 5 -o /dev/null https://mirror.ccs.tencentyun.com/v2/; then
  echo "== 配置腾讯云 Docker 镜像加速"
  mkdir -p /etc/docker
  printf '{\n  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi

echo "== 构建镜像 $IMAGE（第一次几分钟）"
docker build -t "$IMAGE" "$DIR"
docker run --rm --user 65534:65534 "$IMAGE" sh -c 'python3 --version && node --version'

echo "== 让 jarvis 账号能用 Docker"
id jarvis >/dev/null 2>&1 || { echo "没找到 jarvis 账号：先按部署说明装好未央服务器版"; exit 1; }
usermod -aG docker jarvis
mkdir -p "$BASE/data/skill-runner"
chown jarvis:jarvis "$BASE/data/skill-runner"
ENVF="$BASE/jarvis.env"
if [[ -f "$ENVF" ]] && ! grep -q '^JARVIS_SKILL_RUNNER_IMAGE=' "$ENVF"; then echo "JARVIS_SKILL_RUNNER_IMAGE=$IMAGE" >> "$ENVF"; fi
systemctl restart jarvis
echo "== 好了：手机 / 电脑的“技能”页会显示“技能运行器：已装好”。带脚本的技能装上就能运行。"
