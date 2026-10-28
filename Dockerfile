# =====================================================================
# 瑞数 WAF 取 Token —— 精简镜像
#
# 相比原项目 (weikkj/waf-api, 3.07GB 磁盘 / 777MB 拉取) 的瘦身点：
#
#   1. **不用 Playwright 官方镜像当底座**
#      原镜像基于 mcr.microsoft.com/playwright，内含 Chromium + Firefox
#      + WebKit + ffmpeg + 全套浏览器依赖，其中 631MB 是浏览器全家桶层。
#      但本项目代码 **完全没用 Playwright** —— 它是零 npm 依赖的原生 CDP
#      客户端（Node 内置 WebSocket + fetch），浏览器只是被 spawn 出来
#      执行挑战 JS。所以 Firefox / WebKit / ffmpeg 纯属白扛。
#
#   2. **用 chromium-headless-shell 代替完整 chromium**
#      完整 chromium 会拖进 GTK3 + X11 + mesa 软件渲染栈 + 编解码器（1.4GB）。
#      headless-shell 是无 GUI 的精简版，本场景根本不需要 GUI。
#
#   3. **裁掉软件渲染 GPU 栈**（见 prune.sh）
#      libLLVM + libgallium + /usr/lib/dri 共约 225MB，
#      headless-shell 走 --disable-gpu 纯软件路径，用不到。
#
#   4. **去掉 Python / FastAPI**
#      原 api 镜像额外 apt 装 python3 + pip，再 pip 装 fastapi + uvicorn
#      + httpx，只为了提供 HTTP 接口。Node 22 自带 http 模块和 fetch，
#      一个进程就能干完，不需要解释器混装。
#
#   5. **合并三个 stage 为一个**
#      http / selfheal / api 三个 stage 是同一件事的三个切面，
#      合并后只有一个镜像、一种用法。
#
# 实测体积（amd64）：
#   weikkj/waf-api:latest      3.07 GB 磁盘 / 777 MB 拉取
#   waf-token-slim (本文件)     815 MB 磁盘  / 约 220 MB 拉取
#   仅纯 HTTP 重放 (无浏览器)   239 MB 磁盘 / 61.7 MB 拉取
#
# ⚠️ 安全约束（不要移除）：
#   TARGET_URL 一律运行时传入，不要写进镜像 ENV —— ENV 会固化进镜像
#   config，公开仓库页即可读取，会泄露真实发票 URL。
# =====================================================================

# ---------- Stage 1: 浏览器层 ----------
# 装完整 chromium-headless-shell，然后裁掉用不到的 GPU 栈。
FROM node:22-alpine AS browser

# 国内源：apk 默认源在国内极慢（原项目 README 记录过 26 分钟未完成）。
# 若部署在海外，删掉这行 sed 即可。
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache chromium-headless-shell font-wqy-zenhei

COPY prune.sh /prune.sh
RUN sh /prune.sh

# ---------- Stage 2: 运行时（默认 target：api）----------
# 只 COPY 需要的文件 —— 这样裁剪效果才能真正反映到最终镜像体积上。
# （在同一层里删文件不会减小已推送的层体积，必须换层重建。）
FROM node:22-alpine AS api

COPY --from=browser /opt/keep/chromium/ /usr/lib/chromium/
COPY --from=browser /usr/share/fonts/ /usr/share/fonts/
COPY --from=browser /lib/ /lib/
COPY --from=browser /usr/lib/ /usr/lib/

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    CHROME_PATH=/usr/lib/chromium/chromium-headless-shell \
    WAF_HEAL_TIMEOUT=120 \
    WAF_WAIT_MS=14000 \
    PORT=8000

COPY waf-token.js server.js ./

EXPOSE 8000
CMD ["node", "server.js"]

# ---------- Stage 3: 一次性自愈下载（CLI 模式，PDF 落盘）----------
# 与 api 同一个镜像，只是默认入口不同：
#   api     —— 起 HTTP 服务，对外提供接口
#   selfheal —— 跑一次就退出，PDF 写到挂载卷
FROM api AS selfheal

# ⚠️ TARGET_URL 运行时传入，不写进 ENV（会固化进镜像 config 泄露）
CMD ["/bin/sh", "-c", "node waf-token.js \"$TARGET_URL\" /app/out/invoice.pdf"]

# ---------- Stage 4: 纯 HTTP 模式（无浏览器，最轻量）----------
# 场景：Cookie 由外部系统注入，或已有浏览器环境负责采集。
# 这个镜像不含 chromium，无法自愈 —— 遇 412 直接失败。
FROM node:22-alpine AS http

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    WAF_COOKIE_FILE=/app/cookies/waf_cookie.txt

COPY http-client.js ./

# Cookie 从挂载卷读取，不烤进镜像（有效期仅 1~3 分钟，且属敏感凭据）
VOLUME ["/app/cookies", "/app/out"]

# ⚠️ TARGET_URL 运行时传入，不要写进 ENV（会固化进镜像 config 泄露）
CMD ["/bin/sh", "-c", "node http-client.js \"$TARGET_URL\" /app/out/invoice.pdf"]

