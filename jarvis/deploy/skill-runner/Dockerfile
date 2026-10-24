# 未央技能运行器：技能里的 Python / Node 脚本在这个容器里跑（见 server/skillRunner.mjs）。
# 一般不用手动构建：运行同目录的 setup.sh 会装好 Docker、构建这个镜像并接到未央上。
ARG BASE=python:3.12-slim-bookworm
FROM ${BASE}

# 国内服务器：系统软件、Python 包、npm 包都走国内镜像（APT_MIRROR 留空就用官方源）
ARG APT_MIRROR=mirrors.cloud.tencent.com
RUN if [ -n "$APT_MIRROR" ] && [ -f /etc/apt/sources.list.d/debian.sources ]; then sed -i "s#deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && pip config --global set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple \
 && npm config --global set registry https://registry.npmmirror.com

# 取数据、读网页、处理表格最常用的几个库先装好；技能自己要的依赖第一次用时另装（装在每个技能自己的目录）
RUN pip install --no-cache-dir requests httpx beautifulsoup4 lxml pandas

# 运行时用 65534（nobody）账号、只读根目录，由未央在 docker run 时指定，这里不用再设
CMD ["python3", "--version"]
