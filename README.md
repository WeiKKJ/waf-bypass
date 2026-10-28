# waf-bypass —— 瑞数 WAF 取 Token 工具（精简版）

跨平台处理**瑞数（Riverbed）动态安全防护**返回的 **HTTP 412 挑战页**，抓取受保护的发票 PDF。

> **本仓库已精简重构。** 早期版本基于 Playwright 官方镜像 + FastAPI，镜像体积 3.07GB，
> 其中绝大部分是**从未被调用**的 Firefox / WebKit / ffmpeg。
> 新版换用 Alpine + chromium-headless-shell 并移除 Python 栈，**镜像降至 815MB（拉取 237MB）**，
> 且**每次请求快约 10 倍**。详见 [为什么原来的镜像这么大](#为什么原来的镜像这么大)。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
- [为什么原来的镜像这么大](#为什么原来的镜像这么大)
- [镜像体积对比](#镜像体积对比)
- [HTTP 接口](#http-接口)
- [设计要点](#设计要点)
- [常见问题](#常见问题)

---

## 它解决什么问题

目标站点由瑞数 WAF 保护。直接请求发票 URL 会得到 **412** 状态码 + 一个挑战页，
页面上有一段混淆的 JS。这段 JS 执行成功后会在浏览器里写入挑战 Cookie，
带上这个 Cookie 重放请求就能拿到真正的 PDF。

所以流程固定是三步：

```
① 启动 headless 浏览器 → 打开目标 URL → 收到 412 挑战页
② 浏览器自动执行挑战 JS → 生成挑战 Cookie
③ 用普通 HTTP 携带该 Cookie → 重放请求 → 拿到 PDF
```

本工具把①②③打包成命令行脚本和 HTTP 服务。

**Cookie 有效期实测仅 1~3 分钟**，所以策略是「随用随取」：
收到 412 才现场采集，采集到使用间隔 < 1 秒。**不要做定时预采集** ——
固定周期反复访问同一域名容易被服务端识别为爬虫而加黑。

---

## 快速开始

**本项目只提供 Docker 使用方式。** 所有能力都封装在镜像里，无需在宿主机安装
Node.js 或浏览器。

```bash
git clone https://github.com/WeiKKJ/waf-bypass.git
cd waf-bypass
cp .env.example .env          # 填入目标发票 URL
docker compose up -d api

curl -G --data-urlencode "url=$TARGET_URL" \
     http://localhost:8000/fetch -o invoice.pdf
```

也可以直接用镜像，无需克隆仓库：

```bash
docker run -d --name waf-api --shm-size=512m -p 8000:8000 \
  weikkj/waf-api:latest

curl -G --data-urlencode "url=$TARGET_URL" \
     http://localhost:8000/fetch -o invoice.pdf
```

---

## 为什么原来的镜像这么大

旧 Dockerfile 的底座是：

```dockerfile
FROM mcr.microsoft.com/playwright:v1.47.0-noble
```

这个镜像包含 **Chromium + Firefox + WebKit + ffmpeg + 全套浏览器依赖**，
实测 manifest 里光是浏览器全家桶就占 **631MB 单层**。

**但这个项目的代码从来没用过 Playwright。** 旧版 `fetch-invoice.js` 是零 npm 依赖的
原生 CDP 客户端：

```js
const chrome = spawn(browserPath, ['--remote-debugging-port=...']);
const ws = new WebSocket(version.webSocketDebuggerUrl);  // Node 内置 WebSocket
```

它只是把 Playwright 镜像当成「一个带 Chromium 的 Ubuntu」来用 ——
**Firefox、WebKit、ffmpeg 三家从头到尾没被碰过**。

第二处浪费：旧 `api` stage 额外 `apt` 装了 `python3` + `pip`，
再 `pip` 装 `fastapi` + `uvicorn` + `httpx`，**只为了提供 HTTP 接口**。
而 Node 22 自带 `http` 模块和 `fetch`，一个进程就能干完。

### 瘦身的三个动作（缺一不可）

| 动作 | 省下 |
|---|---|
| ① 换掉 Playwright 底座 → Alpine + chromium-headless-shell | ~1.5 GB |
| ② headless-shell 替代完整 chromium → 去掉 GTK3 / X11 / mesa 依赖 | ~400 MB |
| ③ **multi-stage 重建** | ~400 MB |

第 ③ 点最容易被忽略：**删除文件不会减小已推送的镜像层**。
在同一层里 `rm` 掉 225MB 的库，镜像体积不变（层里仍含被删文件）。
必须 multi-stage —— builder 里装 + 裁，最终镜像只 `COPY` 需要的内容。

裁掉的 225MB 是 `libLLVM.so.22.1` + `libgallium-26.1.6.so` + `/usr/lib/dri`
（Mesa 软件渲染 GPU 栈），headless 走 `--disable-gpu` 纯软件光栅化，用不到。

---

## 镜像体积对比

实测（linux/amd64）：

| 版本 | 磁盘占用 | 拉取体积 | 说明 |
|---|---:|---:|---|
| 旧版 | 3.07 GB | 777 MB | Playwright 底座 + Python 栈 |
| **当前** | **815 MB** | **237 MB** | Alpine + chromium-headless-shell，纯 Node |

**磁盘 -73%，拉取 -72%。**

> 本项目只发布一个镜像 `weikkj/waf-api`。
> 早期的 `waf-selfheal` / `waf-http` / `waf-invoice` 等仓库已删除。

---

## HTTP 接口

`docker compose up -d api` 或 `docker run weikkj/waf-api:latest` 后，
服务监听容器内 `:8000`（映射到宿主机 `8000:8000`）。

| 接口 | 说明 |
|---|---|
| `GET /fetch?url=...` | 返回 PDF 流（不落盘） |
| `POST /fetch` | JSON `{"url": "..."}` |
| `GET /check?url=...` | 只探测状态，返回决策链 |
| `GET /token?url=...` | 只返回 Cookie |
| `GET /health` | 健康检查 |
| `GET /cache` | 查看各域名 Cookie 缓存 |
| `DELETE /cache[?domain=...]` | 清缓存 |

响应头 `X-Waf-Steps` 给出完整决策链，便于排查：

```json
[{"step":"direct","status":412},{"step":"healed","status":200}]
```

| step | 含义 |
|---|---|
| `direct` | 首次裸请求的结果 |
| `cached_cookie` | 命中该域名缓存的 Cookie |
| `healed` | 现场采集新 Cookie 后重放成功 |
| `give_up` | 新 Cookie 仍被拒(412)，停止重试 |

**不落盘保证**：PDF 只在内存中返回，Cookie 按域名缓存在进程内存，
容器可写层不随调用次数增长。

---

## 设计要点

### 浏览器常驻复用

旧版每次请求都 `spawn` 一次 Chromium —— 启动 2~4s + 等挑战 14s，**每次约 18s+**。
新版浏览器进程常驻，每个请求只新建一个隔离 target：

```js
Target.createBrowserContext()   // 每个请求独立的 cookie 隔离区
Target.createTarget()           // 新页面
```

请求间互不污染，**快约 10 倍**。用完即销毁 context，不残留 Cookie。

### 进程内 CDP 调用

旧版 `api.py` 通过 `subprocess` 调 `fetch-invoice.js`，再用正则从 stdout 里抠 Cookie。
新版直接在进程内调 CDP，**去掉了这层桥接**。

### 覆盖 User-Agent

瑞数会识别 UA 中的 `HeadlessChrome` 标识。用 CDP `Network.setUserAgentOverride`
覆盖后，headless 模式可稳定返回 `200 application/pdf`。
**关键不是开 GUI 窗口，而是隐藏 headless 标识。**

### 修掉的一个真 bug

旧 `fetch-invoice.js` 里：

```js
if (headless) args.unshift('--headless=new');   // 插到数组最前
// 但 'about:blank' 仍在最后
```

`--headless=new` 被插到数组首位，而 `about:blank` 留在末尾 ——
Chrome 启动时先开空白页，且在部分环境下 headless 模式实际未生效，
**导致取不到 Cookie**。新版把 `--headless=new` 固定写在参数表首位。

---

## 常见问题

**Q：构建很慢？**
apk 默认源在国内极慢。Dockerfile 里已内置阿里云源，但换源后仍需约 10 分钟
（网络瓶颈，不是磁盘问题）。层命中缓存后重建只要 11 秒。

**Q：容器报 `Chromium 启动超时 / CDP 未就绪`？**
Chromium 需要足够的 `/dev/shm`。compose 里已配 `shm_size: 512m`，
手动 `docker run` 时请加 `--shm-size=512m`。

**Q：目标站点换了 WAF 策略怎么办？**
挑战 Cookie 的名称和有效期都可能变。`/check` 接口的 `steps` 能看出断在哪一步；
`X-Waf-Steps` 会告诉你是否成功采集到了 Cookie。

**Q：能直接跑真实站点吗？**
本仓库的验证是在本地 mock 挑战服务（412 → 下发 JS → 写 Cookie → 校验返 PDF）上完成的，
链路与真实瑞数一致。首次接入真实站点时建议先用 `/check` 探一下。

---

## 安全须知

**`TARGET_URL` 必须运行时传入，绝不能写进镜像 `ENV`。**
`ENV` 会固化进镜像 config，推到 Docker Hub 后任何人 `docker inspect` 都能读到 ——
而发票 URL 里含发票号码和公司信息。详见 [SECURITY.md](SECURITY.md)。

推送前请跑门禁扫描：

```bash
python tools/scan_image_secrets.py weikkj/waf-api:latest
```

---

## 长期建议

本工具用于临时抓取。长期集成应优先向目标站点申请**正式 API 通道**。
使用时请控制请求频率，避免给服务端造成压力。

## License

MIT
