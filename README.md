# waf-bypass —— 瑞数 WAF 取 Token 工具（精简版）

跨平台处理**瑞数（Riverbed）动态安全防护**返回的 **HTTP 412 挑战页**，抓取受保护的发票 PDF。

> **本仓库已精简重构。** 早期 Playwright + FastAPI 镜像为 3.07GB；之后的 Node 版约 813MB。
> 当前 API 使用静态 Go 二进制控制 Alpine `chromium-headless-shell`，本机镜像约 **603MB**，
> 比 Node 版减少约 **210MB（26%）**。详见 [为什么原来的镜像这么大](#为什么原来的镜像这么大)。

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

早期 Dockerfile 的底座是：

```dockerfile
FROM mcr.microsoft.com/playwright:v1.47.0-noble
```

这个镜像包含 **Chromium + Firefox + WebKit + ffmpeg + 全套浏览器依赖**，
实测 manifest 里光是浏览器全家桶就占 **631MB 单层**。

**项目的浏览器控制一直通过 CDP 完成，没有使用 Playwright API。** Playwright 镜像只是被当成
“带 Chromium 的 Ubuntu”来用 ——
**Firefox、WebKit、ffmpeg 三家从头到尾没被碰过**。

后续 Node 版去掉了 Python 栈；当前 Go 版再移除 Node 运行时，API 编译为约 6.4MiB 的静态二进制。
Go 只在构建阶段使用，运行镜像不包含 Go 工具链。

### 瘦身的三个动作（缺一不可）

| 动作 | 省下 |
|---|---|
| ① Playwright 镜像改为 Alpine + headless-shell | 不再携带多套浏览器引擎 |
| ② multi-stage 安装并裁剪 Chromium 依赖 | 不把安装工具和 Mesa GPU 栈带入运行层 |
| ③ 静态 Go API 替代 Node 运行时 | 相比 Node 版实测减少约 210MB |

Dockerfile 在临时阶段同一个 `RUN` 层安装 Chromium 并裁掉不需要的 Mesa 库，
避免这些文件先进入旧层、再以删除标记留在镜像历史里。最终镜像只接收裁剪后的
Chromium 本体和运行所需的系统库，不包含 APK 安装缓存和临时构建文件。

裁掉的 225MB 是 `libLLVM.so.22.1` + `libgallium-26.1.6.so` + `/usr/lib/dri`
（Mesa 软件渲染 GPU 栈），headless 走 `--disable-gpu` 纯软件光栅化，用不到。

---

## 镜像体积对比

实测（linux/amd64）：

| 版本 | 磁盘占用 | 拉取体积 | 说明 |
|---|---:|---:|---|
| 旧版 | 3.07 GB | 777 MB | Playwright 底座 + Python 栈 |
| Node 版（前一版） | 813 MB | 未测 | Alpine + Chromium + Node API |
| **当前 Go 版** | **603 MB** | **181 MB** | Alpine + Chromium + 静态 Go API |

Go 版比 Node 版本机镜像小约 **26%**。拉取体积按 Docker Hub amd64 manifest 压缩层合计计算。

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
Dockerfile 默认使用清华 Alpine 镜像源。在国内网络下，本机完整构建约 80 秒；
后续命中缓存时只需数秒。若部署在海外，可切回 Alpine 官方源。

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
