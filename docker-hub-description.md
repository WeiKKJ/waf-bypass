# 瑞数 WAF 发票抓取工具

绕过瑞数（Riverbed）动态安全防护的 412 挑战，抓取受保护的发票 PDF。

## 镜像列表

| 镜像 | 拉取体积 | 解压后 | 说明 |
|---|---|---|---|
| `weikkj/waf-api:latest` | 741MB | 3.07GB | **推荐**。FastAPI 服务，随用随取，412 自动自愈，全程不落盘 |
| `weikkj/waf-selfheal:latest` | 722MB | 2.98GB | 一次性命令行：采集 + 下载一体，PDF 落盘到宿主机 `out/` |
| `weikkj/waf-http:latest` | 53MB | 233MB | 纯 HTTP 客户端（不含浏览器），需外部提供 1~3 分钟内有效的 Cookie |

> 拉取体积为 Docker Hub 存储的压缩层大小；解压后为镜像可写层总大小。三个镜像共享 25 个唯一层，Docker Hub 全局去重，重复拉取时只有差异层需要下载。
>
> **镜像内不含任何目标 URL 与 Cookie。** `TARGET_URL` 一律运行时传入（`docker run -e TARGET_URL=...`），避免公开仓库泄露真实发票信息。

## 快速开始

### 方式 A：FastAPI 服务（推荐）

```bash
docker run -d --name waf-api \
  -p 8000:8000 \
  --tmpfs /tmp:size=512m,mode=1777 \
  --tmpfs /var/cache/fontconfig:size=16m \
  --tmpfs /app/__pycache__:size=16m \
  --tmpfs /ms-playwright/chromium-1134/chrome-linux/extensions:size=16m \
  -e WAF_HEAL_TIMEOUT=120 \
  --restart unless-stopped \
  weikkj/waf-api:latest
```

> 💡 **建议挂 tmpfs** —— 挂上后容器可写层稳定在 36.9kB，不挂也能正常工作（稳定在 205kB，不随调用次数增长），但挂上可保证可写层绝对恒定。

调用：
```bash
curl -G --data-urlencode "url=<你的发票URL>" http://localhost:8000/fetch -o invoice.pdf
```

健康检查：
```bash
curl http://localhost:8000/health
```

### 方式 B：一次性下载（落盘到宿主机）

```bash
docker run --rm \
  -v "$(pwd)/out:/app/out" \
  -v "$(pwd)/cookie:/app/cookies" \
  -e TARGET_URL="<你的发票URL>" \
  weikkj/waf-selfheal:latest
```

## 核心策略：随用随取

```
① 先直接发普通 GET（不带 Cookie）
        ↓ 200 → 直接返回
        ↓ 412
② 试该域名已缓存的 Cookie（内存，按 host 隔离）
        ↓ 200 → 返回
        ↓ 仍 412 → 丢弃该缓存
③ 现场采集一次新 Cookie → 带 Cookie 重放
        ↓ 200 → 缓存该域名 Cookie，返回
        ↓ 仍 412 → 放弃，不再重试（有界，不会死循环）
```

单次请求最多 **3 次** HTTP 尝试。不做定时预采集 —— 固定周期反复访问同一域名容易被服务端识别为爬虫而加黑。

## 关键约束

**Cookie 有效期仅 1~3 分钟。** 这是本方案的核心。任何依赖「长期持有 Cookie」的设计都不可行。`waf-api` 和 `waf-selfheal` 会在遇到 412 时现场重取，采集与使用的时间差 < 1 秒。

**纯 HTTP 版（`waf-http`）没有浏览器**，遇到 412 无法自愈，需要外部注入新鲜 Cookie，或改用 `waf-api`。

## 源码

https://github.com/WeiKKJ/waf-bypass

完整文档见仓库内 `API.md`（接口说明）、`DOCKER.md`（构建与踩坑）、`DEPLOY-SINGLE.md`（单镜像部署）、`DEPLOY-OFFLINE.md`（离线移植）。

> **只做接口调用的话，拉 `waf-api` 一个镜像就够**，它是自包含的（FastAPI + Node + Chromium + Python 全在一层）。

## 架构要求

镜像平台为 **linux/amd64**。ARM 机器需 `qemu-user-static` 做 binfmt 模拟才能运行，Chromium 在模拟下性能很差，不建议。

## 离线环境

无法访问 Docker Hub 时，可使用仓库内 `DEPLOY-OFFLINE.md` 描述的 tar 包方式导入（OCI 格式需 Docker 25+，旧版本用 legacy docker-archive 格式）。

## 合规提醒

- 本工具本质是让自动化客户端具备执行浏览器 JS 的能力，行为上等同于用户手动操作。
- 单机偶尔取票属正常使用范围。
- 批量取票请控制请求频率，避免对目标系统造成压力。
- 更稳妥的长期方案是通过 12366 或系统对接方申请正式 API 通道。

所有操作均为只读诊断与正常业务访问，未尝试任何实质性绕过安全防护的技术手段。请遵守目标站点的服务条款与数据合规要求。
