瑞数 WAF (HTTP 412 挑战) 发票抓取工具 · Docker 镜像

跨平台处理瑞数（Riverbed）动态安全防护返回的 HTTP 412 挑战页，抓取受保护的发票 PDF。

仅 Docker 方式 —— 全部能力封装在镜像内，宿主机无需安装 Node.js 或浏览器。

## 用法

```bash
docker run -d --name waf-api --shm-size=512m -p 8000:8000 \
  weikkj/waf-token-slim:latest

curl -G --data-urlencode "url=$TARGET_URL" \
     http://localhost:8000/fetch -o invoice.pdf
```

或用 compose：

```bash
cp .env.example .env      # 填入目标发票 URL
docker compose up -d api
```

## 接口

| 接口 | 说明 |
|---|---|
| GET /fetch?url=... | 返回 PDF 流（不落盘） |
| POST /fetch | JSON {"url": "..."} |
| GET /check?url=... | 只探测状态，返回决策链 |
| GET /token?url=... | 只返回 Cookie |
| GET /health | 健康检查 |
| GET /cache | 查看 Cookie 缓存 |
| DELETE /cache[?domain=...] | 清缓存 |

响应头 X-Waf-Steps 给出完整决策链。

## 工作原理

1. headless Chromium 打开目标 URL → 收到 412 挑战页
2. 浏览器执行挑战 JS → 生成挑战 Cookie
3. 用普通 HTTP 携带该 Cookie 重放 → 拿到 PDF

浏览器常驻复用，每个请求独立 browser context，比每次重启浏览器快约 10 倍。

## 体积

| 镜像 | 磁盘 / 拉取 |
|---|---|
| waf-api（旧版） | 3.07GB / 777MB |
| waf-token-slim（当前） | 815MB / 237MB |

## 注意

- Cookie 有效期仅 1~3 分钟，策略是「随用随取」：收到 412 才现场采集。
  不建议定时预采集 —— 固定周期反复访问同一域名容易被识别为爬虫。
- TARGET_URL 必须运行时传入（-e 或 compose environment），
  不要写进镜像 ENV —— 会固化进镜像 config 导致泄露。
- 需要足够的 /dev/shm，请加 --shm-size=512m。

源码：https://github.com/WeiKKJ/waf-bypass
