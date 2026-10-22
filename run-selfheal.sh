#!/bin/sh
# 自愈下载入口
#
# 流程：先用现有 Cookie 尝试下载 → 遇 412 自动调用 fetch-invoice.js 重取 → 重试
# http-client.js 内置 412 自愈逻辑；本脚本负责：
#   1. 确认 fetch-invoice.js 与 http-client.js 在同一目录（自愈依赖）
#   2. 首次运行无 Cookie 时先采集一份
#   3. 通过 WAF_COOKIE_FILE 显式指定 Cookie 文件路径，避免读到其它位置的旧文件
#
# 用法: run-selfheal.sh <目标URL> [输出路径]
set -eu

URL="${1:?需要传入目标 URL}"
OUT="${2:-/app/out/invoice.pdf}"

APP_DIR="${APP_DIR:-/app}"
# Cookie 存放位置：优先 COOKIE_FILE 环境变量，其次 /app/cookies/waf_cookie.txt
COOKIE_FILE="${COOKIE_FILE:-/app/cookies/waf_cookie.txt}"

mkdir -p "$(dirname "$COOKIE_FILE")" 2>/dev/null || true

# 首次运行且无 Cookie：先采集一份
if [ ! -s "$COOKIE_FILE" ]; then
  echo "[自愈] 无可用 Cookie，先采集一份 ..."
  node "$APP_DIR/fetch-invoice.js" --cookie-only "$URL" \
    | grep '^Cookie:' | sed 's/^Cookie: //' > "$COOKIE_FILE"
  echo "[自愈] 采集完成: $(wc -c < "$COOKIE_FILE") 字节"
fi

# 显式指定 Cookie 文件路径 —— http-client.js 会优先使用它，
# 且 412 自愈时会自动把新 Cookie 写回这个文件
export WAF_COOKIE_FILE="$COOKIE_FILE"

exec node "$APP_DIR/http-client.js" "$URL" "$OUT"