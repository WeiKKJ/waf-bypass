#!/bin/sh
# ============================================================
# 瑞数 WAF 发票抓取 —— 目标环境一键导入脚本
#
# 用法:
#   sh deploy.sh <镜像tar路径> [项目源码目录]
#
# 例:
#   sh deploy.sh /data/waf-bypass-images.tar
#   sh deploy.sh /data/waf-bypass-images.tar /opt/waf-bypass
# ============================================================
set -eu

TAR="${1:?用法: sh deploy.sh <镜像tar路径> [项目源码目录]}"
SRC="${2:-./waf-bypass}"

echo "=========================================="
echo " 瑞数 WAF 发票抓取 —— 部署"
echo "=========================================="
echo "镜像包: $TAR"
echo "源码目录: $SRC"
echo ""

# ---------- 1. 环境检查 ----------
echo "[1/4] 检查 Docker 环境"
if ! command -v docker >/dev/null 2>&1; then
  echo "  ✗ 未找到 docker 命令，请先安装 Docker Engine" >&2
  exit 1
fi
DOCKER_VER="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'unknown')"
echo "  ✓ Docker Server 版本: $DOCKER_VER"

# 架构检查 —— 镜像是 linux/amd64
ARCH="$(uname -m)"
echo "  ✓ 本机架构: $ARCH"
case "$ARCH" in
  x86_64|amd64) ;;
  *)
    echo "  ⚠️ 警告：镜像是 linux/amd64，当前是 $ARCH。"
    echo "     ARM 机器需用 qemu-user-static 做 binfmt 模拟才能运行，"
    echo "     性能会明显下降，建议改在 x86 机器部署。"
    ;;
esac

# ---------- 2. 导入镜像 ----------
echo ""
echo "[2/4] 导入镜像"
if [ ! -f "$TAR" ]; then
  echo "  ✗ 找不到镜像文件: $TAR" >&2
  exit 1
fi

# .tar.gz 需先解压
case "$TAR" in
  *.tar.gz)
    echo "  · 解压 $TAR ..."
    gzip -dk "$TAR"
    TAR="${TAR%.gz}"
    ;;
esac

# 校验 SHA256（若同目录有校验文件）
if [ -f "$(dirname "$TAR")/SHA256SUMS" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    echo "  · 校验 SHA256 ..."
    (cd "$(dirname "$TAR")" && sha256sum -c SHA256SUMS 2>/dev/null) || echo "  ⚠️ 校验未完全通过，请确认文件传输完整"
  fi
fi

docker load -i "$TAR"

echo "  当前 WAF 相关镜像："
docker images | grep -E "waf-(api|selfheal|http|invoice)" || true

# ---------- 3. 配置 ----------
echo ""
echo "[3/4] 配置目标 URL"
if [ -d "$SRC" ]; then
  if [ ! -f "$SRC/.env" ]; then
    if [ -f "$SRC/.env.example" ]; then
      cp "$SRC/.env.example" "$SRC/.env"
      echo "  ✓ 已从 .env.example 生成 .env"
    fi
  fi
  if [ -f "$SRC/.env" ]; then
    echo "  ⚠️ 请编辑 $SRC/.env，把 TARGET_URL 改成你的真实发票 URL"
  else
    echo "  ⚠️ 未找到 .env / .env.example，请手动创建 .env 并填入 TARGET_URL"
  fi
else
  echo "  ⚠️ 源码目录 $SRC 不存在 —— 仅导入镜像。"
  echo "     若要用 docker compose 启动，请从 GitHub 拉取源码："
  echo "     git clone https://github.com/WeiKKJ/waf-bypass.git"
fi

# ---------- 4. 启动 ----------
echo ""
echo "[4/4] 启动 FastAPI 服务"
cd "$SRC" 2>/dev/null || true
if [ -f "docker-compose.yml" ]; then
  docker compose up -d api
  echo "  ✓ 服务已启动，等待就绪 ..."
  sleep 5
  echo ""
  echo "  健康检查:"
  curl -s http://localhost:8000/health || echo "  （若失败，用 docker compose logs -f api 查看）"
  echo ""
  echo "  调用示例:"
  echo "    curl -G --data-urlencode \"url=\$TARGET_URL\" http://localhost:8000/fetch -o invoice.pdf"
else
  echo "  未找到 docker-compose.yml，跳过自动启动。"
  echo "  手动启动示例（只起 api 服务即可）："
  echo "    docker run -d --name waf-api -p 8000:8000 \\"
  echo "      --tmpfs /tmp:size=512m,mode=1777 \\"
  echo "      --tmpfs /var/cache/fontconfig:size=16m \\"
  echo "      --tmpfs /app/__pycache__:size=16m \\"
  echo "      --tmpfs /ms-playwright/chromium-1134/chrome-linux/extensions:size=16m \\"
  echo "      -e WAF_HEAL_TIMEOUT=120 --restart unless-stopped waf-api:latest"
fi

echo ""
echo "=========================================="
echo " 部署完成"
echo "=========================================="
