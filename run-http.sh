#!/bin/sh
# 纯 HTTP 业务端入口
#
# 用法:
#   TARGET_URL=... sh /app/run-http.sh                  # 下载到 /app/out/invoice.pdf
#   TARGET_URL=... sh /app/run-http.sh <输出路径>
#   BATCH_FILE=/path/list.txt sh /app/run-http.sh        # 批量模式
set -eu

COOKIE_FILE="${COOKIE_FILE:-/app/cookies/waf_cookie.txt}"
OUT="${1:-/app/out/invoice.pdf}"

if [ ! -s "$COOKIE_FILE" ]; then
  echo "Cookie 文件为空或不存在: $COOKIE_FILE" >&2
  echo "请先启动 cookie-provider 容器：docker compose up -d cookie-provider" >&2
  exit 2
fi

WAF_COOKIE="$(cat "$COOKIE_FILE")"
export WAF_COOKIE

# 批量模式：读 URL 列表文件
if [ -n "${BATCH_FILE:-}" ]; then
  if [ ! -s "$BATCH_FILE" ]; then
    echo "批量文件为空或不存在: $BATCH_FILE" >&2
    exit 2
  fi
  exec node /app/http-client.js --url-from-file "$BATCH_FILE"
fi

# 单条模式
exec node /app/http-client.js "$TARGET_URL" "$OUT"