# 未来创梦 · 服务器版
#
# 用 Docker 而不是"照着文档 apt install 一遍"：这个应用要的东西不多
# （Node + FFmpeg），但**版本对不对**很要命 —— FFmpeg 少编了 libass 就烧不了字幕，
# Node 低于 18 连 fetch 都没有。镜像把这两样钉死，换台机器结果一样。
#
# 应用本身零运行时依赖，所以这里没有 npm install —— 拷源码进去就能跑。
FROM node:22-slim

# ffmpeg：合成、裁剪、抽帧、烧字幕全靠它。fonts-noto-cjk 是为了烧中文字幕，
# 少了它 subtitles 滤镜会把中文画成一排方框
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY core ./core
COPY ui ./ui
COPY scripts ./scripts
COPY package.json ./

# 数据（项目、密钥、成片）全在这个卷里。删容器不删数据。
ENV FUTUREDREAM_DATA_DIR=/data
ENV FUTUREDREAM_MODE=server
ENV PORT=5178
# 服务器上没有桌面，也没人坐在它前面。代码里已经不会去开浏览器了，
# 这一行是第二道保险 —— 曾经就因为容器里没有 xdg-open 而无限重启
ENV FUTUREDREAM_NO_OPEN=1
VOLUME ["/data"]
EXPOSE 5178

# 起来之前先自检一遍：配置不全会直接退出并说清楚缺什么，
# 而不是带着一个敞开的口子跑起来
CMD ["node", "core/server.js"]
