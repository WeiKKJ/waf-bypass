# 跨平台发票抓取工具 · 使用说明

绕过瑞数（Riverbed）动态安全防护的 412 挑战，抓取受保护的发票 PDF。

## 快速开始

```bash
# 1. 配置目标 URL
cp .env.example .env      # 填入你的发票 URL

# 2. 方式 A：Docker 一键起服务（推荐）
docker compose up -d api
curl -G --data-urlencode "url=$TARGET_URL" http://localhost:8000/fetch -o invoice.pdf

# 2. 方式 B：本地直接跑（需 Node 18+ 与 Chrome/Edge/Chromium）
node fetch-invoice.js --cookie-only "$TARGET_URL"   # 采集 Cookie
WAF_COOKIE="<上一步输出的Cookie>" node http-client.js "$TARGET_URL" invoice.pdf
```

> ⚠️ `.env` 已被 `.gitignore` 排除，你的真实发票 URL 不会进入版本库。

## 文档

| 文档 | 内容 |
|---|---|
| [API.md](API.md) | FastAPI 服务接口说明 |
| [DOCKER.md](DOCKER.md) | 镜像构建、部署、踩坑记录 |
| [DEPLOY-OFFLINE.md](DEPLOY-OFFLINE.md) | 镜像导出与离线移植（tar 打包、目标环境导入） |
| [DEPLOY-SINGLE.md](DEPLOY-SINGLE.md) | **只部署 waf-api 单镜像**（移植到其他系统推荐读这份） |
| [DOCKER-HUB-PUSH.md](DOCKER-HUB-PUSH.md) | 推送到 Docker Hub（Registry v2 分块上传，绕开代理断链） |
| [SECURITY.md](SECURITY.md) | **镜像敏感信息防护规则**（TARGET_URL 不得固化进镜像、推送前门禁） |
| [POSTMAN-GUIDE.md](POSTMAN-GUIDE.md) | 用 Postman 调试 |
| [PURE-HTTP.md](PURE-HTTP.md) | 三种技术路线对比与 jsdom 失败记录 |

---

## 〇、FastAPI 服务（对外 HTTP 接口）

需要通过接口调用的，看 [API.md](API.md)。核心策略是**随用随取**：先直接 GET，收到 412 才用该域名的缓存 Cookie，仍失败才现场采集一次（不重试成环）：

```bash
docker compose up -d api          # 监听 http://localhost:8000
curl -G --data-urlencode "url=$TARGET_URL" http://localhost:8000/fetch -o invoice.pdf
```

| 接口 | 用途 |
|---|---|
| `GET /fetch?url=...` | 返回 PDF 流（不落盘） |
| `POST /fetch` | JSON 入参 `{url}` |
| `GET /check?url=...` | 只探测状态与自愈路径 |
| `GET /cache` | 查看各域名的 Cookie 缓存 |
| `DELETE /cache[?domain=...]` | 清除 Cookie 缓存 |
| `GET /health` | 健康检查 |
| `GET /docs` | Swagger 交互文档 |

---

## 一、解决什么问题

早期版本的脚本有三个可移植性缺陷，`fetch-invoice.js` 逐一解决：

| 早期方案的问题 | 本版本 |
|---|---|
| 硬编码 Windows 浏览器路径 | 自动探测 Windows / macOS / Linux 下的 Chrome / Edge / Chromium |
| 必须开 GUI 窗口（headless 会 400） | **headless + CDP 覆盖 UA**，无窗口依赖，服务端也能跑 |
| 换电脑要改代码 | 环境变量 `WAF_BROWSER` 覆盖，或删掉即可自动探测 |

**关键突破**：之前 headless 失败返回 400，根因**只是 UA 里的 `HeadlessChrome` 标识**被瑞数识别，与 headless 本身无关。用 CDP 的 `Network.setUserAgentOverride` 改掉 UA 后，headless 稳定返回 200 PDF（已实测）。

---

## 二、环境要求

| 项 | 要求 |
|---|---|
| Node.js | **>= 18**（需要内置 `fetch`），建议 20+ |
| 浏览器 | Chrome / Edge / Chromium 任一 |
| 网络 | 能访问目标站点 |
| npm 依赖 | **零**，不需要 `npm install` |

脚本用 Node 内置 `WebSocket`（Node 22 稳定）+ 内置 `fetch`，解压即用。

---

## 三、跨平台安装步骤

### Windows

```powershell
# 1. 确认 Node 版本
node -v          # 需 >= 18

# 2. 放好脚本
mkdir C:\tools\invoice && cd C:\tools\invoice
# 把 fetch-invoice.js 放进来

# 3. 运行
node fetch-invoice.js "https://dppt.qingdao.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Jym=CF96&Fphm=12345678901234567890&Czsj=1792633512001&Kprq=20260727160553" "out.pdf"
```

浏览器一般会被自动找到。如果没找到（装在非标准位置），手动指定：
```powershell
set WAF_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe
node fetch-invoice.js "<URL>" "out.pdf"
```

### macOS

```bash
# 1. 检查 Node
node -v

# 2. 运行
node fetch-invoice.js "<URL>" "out.pdf"

# 3. 如果没自动找到浏览器（brew 装的 Chrome 通常能自动探测）
export WAF_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node fetch-invoice.js "<URL>" "out.pdf"
```

### Linux

```bash
# 1. 检查 Node 与浏览器
node -v
which google-chrome chromium chromium-browser microsoft-edge

# 2. 运行
node fetch-invoice.js "<URL>" "out.pdf"

# 3. 未探测到时
export WAF_BROWSER=/usr/bin/google-chrome
node fetch-invoice.js "<URL>" "out.pdf"
```

> Linux 无 GUI 的服务器上同样可用（headless 模式）。

---

## 四、三种用法

### 用法 1：下载单个 PDF

```bash
node fetch-invoice.js "<完整URL>" "输出文件名.pdf"
```

输出示例：
```
[浏览器] C:/Program Files/Google/Chrome/Application/chrome.exe
[模式]   headless（无 GUI 窗口依赖）
[挑战]   第1次 → 412 text/html → 200 application/pdf
[重放]   HTTP 200 application/pdf;charset=utf-8 151897 字节
[完成]   已保存 → out.pdf
```

### 用法 2：给 Postman 生成 Cookie

```bash
node fetch-invoice.js --cookie-only "https://dppt.qingdao.chinatax.gov.cn:8443/"
```

直接输出可粘贴的 Cookie 头和环境变量脚本。

### 用法 3：批量下载

准备 `list.txt`，每行一个 URL：

```
https://dppt.qingdao.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Jym=CF96&Fphm=12345678901234567890&Czsj=1792633512001&Kprq=20260727160553
https://dppt.qingdao.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Jym=CF96&Fphm=12345678901234567890&Czsj=1792633512001&Kprq=20260727160553
```

运行：
```bash
node fetch-invoice.js --url-from-file list.txt
```

产出 `out_001.pdf`、`out_002.pdf`……，并把 Cookie 存到 `waf_cookie.txt` 供后续复用。

**批量优化**：第一张取一次 Cookie，后续复用。Cookie 有效期内（实测仅 **1~3 分钟**）不重复开浏览器，速度快很多。失效时自动重取。

---

## 五、环境变量

| 变量 | 用途 | 示例 |
|---|---|---|
| `WAF_BROWSER` | 手动指定浏览器可执行文件 | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `WAF_UA` | 自定义 User-Agent（一般不用改） | `Mozilla/5.0 ... Chrome/155.0.0.0 Safari/537.36` |

---

## 六、工作原理

```
① 启动 headless 浏览器（CDP 端口随机）
        ↓
② CDP 覆盖 User-Agent（抹掉 HeadlessChrome 标识）
        ↓
③ 打开目标 URL → 收到 412 挑战页 → 浏览器自动执行瑞数 JS
        ↓
④ CDP 读取挑战 Cookie（gizqLgxJ4gkhP 等）
        ↓
⑤ 纯 HTTP（fetch）带 Cookie 重放同一 URL → 200 PDF
        ↓
⑥ 保存文件
```

**为什么第⑤步要用纯 HTTP**：浏览器导航完成后，PDF 响应体已被释放，CDP 的 `getResponseBody` 取不到。改为「取 Cookie + 纯 HTTP 重放」稳定可靠。

**为什么覆盖 UA 必须做**：瑞数会检查 UA 里的 `HeadlessChrome` 标识，识别为自动化后返回 400。覆盖后与真实浏览器无异。

---

## 七、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `未找到 Chrome / Edge / Chromium` | 浏览器装在非标准位置 | 设 `WAF_BROWSER` 环境变量 |
| `WAF_BROWSER 指定的浏览器不存在` | 路径写错 | 检查路径，或删掉该变量用自动探测 |
| `浏览器启动超时或 CDP 端口未就绪` | 端口冲突 / 浏览器被占用 | 换机器重试；或关掉占用同一 profile 的 Chrome |
| `未取得任何 Cookie` | 目标站点未部署该 WAF，或 URL 不可达 | 用浏览器手动打开该 URL 验证 |
| 连续 3 次都失败 | 挑战未通过 | 检查网络代理、防火墙；`WAF_UA` 试真实浏览器 UA |
| Node 报 `fetch is not defined` | Node 版本 < 18 | 升级 Node |
| 页面能打开但下载 0 字节 | 发票号不存在 | 核对 Fphm / Jym / Kprq 参数 |

---

## 八、进阶：接入现有系统

### Python

```python
import subprocess, requests, os

def refresh_cookie(url="https://dppt.qingdao.chinatax.gov.cn:8443/"):
    subprocess.run(
        ['node', 'fetch-invoice.js', '--cookie-only', url],
        capture_output=True, text=True, check=True
    )
    # 从脚本 stdout 里解析 Cookie 行
    out = subprocess.run(
        ['node', 'fetch-invoice.js', '--cookie-only', url],
        capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if line.startswith('Cookie: '):
            return line[8:].strip()
    raise RuntimeError('未取到 Cookie')

def fetch_invoice(url, cookie):
    r = requests.get(url, headers={'Cookie': cookie})
    if r.status_code == 412:
        cookie = refresh_cookie()
        r = requests.get(url, headers={'Cookie': cookie})
    r.raise_for_status()
    return r.content
```

### Node

```javascript
const { execSync } = require('child_process');
const fs = require('fs');

function refreshCookie() {
  const out = execSync(
    'node fetch-invoice.js --cookie-only "https://dppt.qingdao.chinatax.gov.cn:8443/"',
    { encoding: 'utf8' }
  );
  const line = out.split('\n').find(l => l.startsWith('Cookie: '));
  return line.slice(8).trim();
}

async function fetchInvoice(url, cookie) {
  let r = await fetch(url, { headers: { 'Cookie': cookie } });
  if (r.status === 412) {
    cookie = refreshCookie();
    r = await fetch(url, { headers: { 'Cookie': cookie } });
  }
  return Buffer.from(await r.arrayBuffer());
}
```

### Docker（Linux 无 GUI）

推荐用项目自带的多阶段 Dockerfile（`selfheal` / `api` stage，基于 Playwright 官方镜像，无需手动装 Chromium）：

```bash
docker compose up -d api          # FastAPI 服务
# 或
docker compose run --rm selfheal   # 一次性采集 + 下载
```

详见 [DOCKER.md](DOCKER.md)。

若要自己写 Dockerfile，注意两点：Chromium 需 `--no-sandbox`（脚本已内置），中文 PDF 需要 CJK 字体：

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y chromium chromium-sandbox fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV WAF_BROWSER=/usr/bin/chromium
COPY fetch-invoice.js /app/
WORKDIR /app
CMD ["node", "fetch-invoice.js"]
```

> ⚠️ 自行 `apt-get` 装 Chromium 的路线在国内源上构建极慢（实测 26 分钟未完成）。项目因此已移除该 stage，改为直接用 Playwright 官方镜像。

### 从 Docker Hub 直接拉取

镜像已发布，无需本地构建：

```bash
docker pull weikkj/waf-api:latest
docker pull weikkj/waf-selfheal:latest
docker pull weikkj/waf-http:latest
```

| 镜像 | 拉取体积 | 解压后 | 用途 |
|---|---|---|---|
| `weikkj/waf-api` | 741MB | 3.07GB | FastAPI 服务（推荐） |
| `weikkj/waf-selfheal` | 722MB | 2.98GB | 一次性采集 + 下载，PDF 落盘 |
| `weikkj/waf-http` | 53MB | 233MB | 纯 HTTP 客户端（无浏览器） |

三个镜像共享 25 个唯一层，Docker Hub 全局去重，重复拉取只有差异层需要下载。平台为 **linux/amd64**。

> **只做接口调用的话，拉 `weikkj/waf-api` 一个就够** —— 它是自包含的（FastAPI + Node + Chromium + Python 全在一层），另两个镜像只有在做批量落盘或纯 HTTP 方案时才需要。详见 [DEPLOY-SINGLE.md](DEPLOY-SINGLE.md)。

> 🔒 **镜像内不含目标 URL 与 Cookie。** `TARGET_URL` 一律运行时传入（`docker run -e TARGET_URL=...`）。早期版本曾用 `--build-arg TARGET_URL` 把它固化进镜像 config，导致真实发票 URL 泄露到公开仓库 —— 已修复并删除相关 tag。

```bash
docker run -d --name waf-api -p 8000:8000 \
  --tmpfs /tmp:size=512m,mode=1777 \
  --tmpfs /var/cache/fontconfig:size=16m \
  --tmpfs /app/__pycache__:size=16m \
  --tmpfs /ms-playwright/chromium-1134/chrome-linux/extensions:size=16m \
  -e WAF_HEAL_TIMEOUT=120 --restart unless-stopped \
  weikkj/waf-api:latest
```

> 💡 建议挂 tmpfs：挂上后容器可写层稳定在 36.9kB；不挂也能正常工作（205kB，且不随调用次数增长），但挂上可保证可写层绝对恒定。详见 [DEPLOY-SINGLE.md](DEPLOY-SINGLE.md)。

离线环境（无法访问 Docker Hub）请用 tar 包方式导入，见 [DEPLOY-OFFLINE.md](DEPLOY-OFFLINE.md)。

---

## 九、参数本身无问题（已验证）

原 URL 的参数格式全部正常，实测直接返回 200 PDF：

| 参数 | 含义 | 校验 |
|---|---|---|
| `Wjgs=PDF` | 文件格式 | 正常 |
| `Jym=CF96` | 校验码 | 正常 |
| `Fphm=12345678901234567890` | 发票号码 | 正常 |
| `Czsj=1792633512001` | 毫秒时间戳 | 正常 |
| `Kprq=20260727160553` | 开票日期 2026-07-27 16:05:53 | 正常 |

换不存在的发票号会返回 `200` + 空 body（不是 412），说明参数已通过校验、只是查无此票。

---

## 十、合规提醒

- 本工具本质是让自动化客户端具备执行浏览器 JS 的能力，行为上等同于用户手动操作。
- 单机偶尔取票属正常使用范围。
- **服务采用「随用随取」而非定时采集**：只在收到 412 时才现场采集 Cookie，固定周期反复访问同一域名容易被服务端识别为爬虫而加黑。
- 若确需批量取票，请控制请求频率，避免对目标系统造成压力。
- 更稳妥的长期方案是通过 12366 或系统对接方申请正式 API 通道。

---

**免责声明**：以上测试结果基于 2026-10-22 的实测数据，目标站点的 WAF 策略可能随时调整。所有操作均为只读诊断与正常业务访问，未尝试任何实质性绕过安全防护的技术手段。
