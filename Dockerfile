# =====================================================================
# 瑞数 WAF 发票抓取 —— Docker 镜像
#
# 构建上下文 = 工作区根目录
#   docker build -f waf-bypass/Dockerfile -t waf-invoice:latest .
#
# 设计要点：
#   瑞数 Cookie 实测有效期仅 1~3 分钟（远短于 15 分钟），
#   独立的「Cookie 供应端」长驻刷新并不可靠 —— 刷新间隔必然大于有效期。
#
#   因此改为**随用随取**：收到 412 时现场采集，采集与使用时间差 < 1 秒。
#   定时预采集被刻意去掉 —— 固定周期反复访问同一域名容易被服务端识别为爬虫而加黑。
#
# 四个 stage：
#   cookie  —— 构建期采集 Cookie（Playwright 镜像，含 Chromium）
#   http    —— 纯 HTTP 客户端（node:22-alpine，239MB，不含浏览器）
#   selfheal—— 采集 + 下载一体（Playwright 镜像）
#   api     —— FastAPI 服务（对外 HTTP 接口，随用随取，不落盘）
# =====================================================================
# ---------- Stage 1: Cookie 采集器（Playwright 官方镜像）----------
FROM mcr.microsoft.com/playwright:v1.47.0-noble AS cookie

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY waf-bypass/fetch-invoice.js ./
COPY waf-bypass/http-client.js ./

ARG TARGET_URL
ENV TARGET_URL=${TARGET_URL}

RUN node fetch-invoice.js --cookie-only "$TARGET_URL" \
    | grep '^Cookie:' | sed 's/^Cookie: //' > /app/waf_cookie.txt \
    && test -s /app/waf_cookie.txt \
    && echo "Cookie 采集成功: $(wc -c < /app/waf_cookie.txt) 字节"


# ---------- Stage 2: 纯 HTTP 客户端（最终镜像，不含浏览器）----------
FROM node:22-alpine AS http

WORKDIR /app
COPY waf-bypass/http-client.js ./
COPY waf-bypass/run-http.sh ./run-http.sh
RUN chmod +x run-http.sh
COPY --from=cookie /app/waf_cookie.txt ./waf_cookie.txt

ARG TARGET_URL
ENV TARGET_URL=${TARGET_URL}

USER node

# 不用 ENTRYPOINT + CMD 组合（ENTRYPOINT 是 exec 形式，CMD 会被当作参数拼接，
# 导致 sh -c 失效）。直接用 shell 形式 CMD。
# 输出落在挂载卷 /app/out 下；不写 /app 根目录（node 用户无写权限）。
CMD ["/bin/sh", "-c", "node http-client.js \"$TARGET_URL\" /app/out/invoice.pdf"]


# ---------- Stage 3: 自愈版（采集+下载一体，推荐用于生产）----------
# 基于 Playwright 官方镜像：无需 apt 装 chromium，构建快、依赖全
FROM mcr.microsoft.com/playwright:v1.47.0-noble AS selfheal

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config

COPY waf-bypass/fetch-invoice.js ./
COPY waf-bypass/http-client.js ./
COPY waf-bypass/run-selfheal.sh ./run-selfheal.sh
RUN chmod +x run-selfheal.sh

ARG TARGET_URL
ENV TARGET_URL=${TARGET_URL}

CMD ["/bin/sh", "-c", "/app/run-selfheal.sh \"$TARGET_URL\" /app/out/invoice.pdf"]


# ---------- Stage 5: FastAPI 服务（对外提供 HTTP 接口）----------
# 自愈需要浏览器采集 Cookie，因此同样基于 Playwright 官方镜像
FROM mcr.microsoft.com/playwright:v1.47.0-noble AS api

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WAF_HEAL_TIMEOUT=120 \
    PORT=8000 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config

# node 已在镜像内（供 fetch-invoice.js 使用）；补装 Python
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY waf-bypass/requirements.txt ./requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY waf-bypass/fetch-invoice.js ./
COPY waf-bypass/api.py ./

# 不建 out/cookies 目录：服务全程不落盘
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
