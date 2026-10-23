# =====================================================================
# 瑞数 WAF 发票抓取 —— Docker 镜像
#
# 构建上下文 = 工作区根目录
#   docker build -f waf-bypass/Dockerfile -t waf-api:latest .
#
# 设计要点：
#   瑞数 Cookie 实测有效期仅 1~3 分钟（远短于 15 分钟），
#   独立的「Cookie 供应端」长驻刷新并不可靠 —— 刷新间隔必然大于有效期。
#
#   因此改为**随用随取**：收到 412 时现场采集，采集与使用时间差 < 1 秒。
#   定时预采集被刻意去掉 —— 固定周期反复访问同一域名容易被服务端识别为爬虫而加黑。
#
# 三个 stage：
#   http    —— 纯 HTTP 客户端（node:22-alpine，239MB，不含浏览器）
#   selfheal—— 采集 + 下载一体（Playwright 镜像）
#   api     —— FastAPI 服务（对外 HTTP 接口，随用随取，不落盘）
#
# ⚠️ 安全约束（不要移除）：
#   1. **任何 stage 都不得把 TARGET_URL 写进 ENV**。
#      ENV 会固化进镜像 config，`docker inspect` 与公开仓库页均可读取，
#      会泄露真实发票 URL（含发票号码、公司信息）。
#      TARGET_URL 一律运行时传入：`docker run -e TARGET_URL="https://..."`
#   2. **不得把 Cookie 烤进镜像**。
#      瑞数 Cookie 有效期仅 1~3 分钟，烤进镜像的 Cookie 发布时必然已失效，
#      等于既无效又泄露凭据。Cookie 一律运行时采集或从卷挂载读入。
#   3. 因此**没有构建期 cookie stage** —— 早期版本有，已移除。
# =====================================================================

# ---------- Stage 1: 纯 HTTP 客户端（最终镜像，不含浏览器）----------
# 无浏览器 → 遇 412 无法自愈，需外部注入 Cookie（1~3 分钟内有效）
FROM node:22-alpine AS http

WORKDIR /app
COPY waf-bypass/http-client.js ./
COPY waf-bypass/run-http.sh ./run-http.sh
RUN chmod +x run-http.sh

USER node

# 不用 ENTRYPOINT + CMD 组合（ENTRYPOINT 是 exec 形式，CMD 会被当作参数拼接，
# 导致 sh -c 失效）。直接用 shell 形式 CMD。
# 输出落在挂载卷 /app/out 下；不写 /app 根目录（node 用户无写权限）。
# TARGET_URL 由运行时传入，不固化在镜像里。
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

# ⚠️ 同样不设 ENV TARGET_URL —— 运行时传入，避免泄露真实发票 URL
# （run-selfheal.sh 会在运行时读 $TARGET_URL）

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
