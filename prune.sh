#!/bin/sh
# =====================================================================
# 浏览器裁剪脚本 —— 在 builder 阶段执行
#
# 目标：去掉 headless 场景完全用不到的东西，同时保证浏览器仍能启动。
#
# 只删两样（已实测安全）：
#   1. libLLVM.so.22.1 + libgallium-26.1.6.so —— Mesa 软件渲染 GPU 栈，约 225MB。
#      headless-shell 跑的是 --disable-gpu 的纯软件光栅化路径，用不到这套 LLVM。
#   2. /usr/lib/dri —— DRI 驱动目录，同样只服务于 GPU 加速。
#
# ⚠️ 不能删的（实测踩坑）：
#   - libavcodec / libavformat / libx265 等编解码库：
#     libavformat 依赖 libavcodec 的符号，删掉会导致
#     "Error relocating ...: symbol not found"，浏览器直接起不来。
#   - /usr/lib/chromium/：headless-shell 主二进制（201MB）就在这个目录里，
#     不是在 /usr/bin/ —— /usr/bin/chromium-headless-shell 只是软链。
# =====================================================================
set -e

mkdir -p /opt/keep

# 把 chromium 本体目录搬走（最后再放回去，避免被通配清理误删）
if [ -d /usr/lib/chromium ]; then
  mv /usr/lib/chromium /opt/keep/chromium
fi

# 删软件渲染 GPU 栈
rm -f /usr/lib/libLLVM.so.22.1 /usr/lib/libgallium-26.1.6.so
rm -rf /usr/lib/dri

# 删无关文档与缓存
rm -rf /usr/share/man /usr/share/doc /usr/share/icons /var/cache/apk/*
