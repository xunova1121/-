# syntax=docker/dockerfile:1
# 支持服务器已缓存的Node22 Alpine；不要求重新拉Debian镜像。
ARG BASE=node:22-alpine
FROM ${BASE}
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if command -v apk >/dev/null; then apk add --no-cache chromium font-noto-cjk; \
    elif command -v apt-get >/dev/null; then apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk && rm -rf /var/lib/apt/lists/*; \
    else echo '浏览器镜像需要Alpine或Debian基础'; exit 1; fi
ENV CHROMIUM_PATH=/usr/bin/chromium
USER 65534:65534
