# Docker 部署说明

结论：**能跑，已实测通过。** 推荐 `api` 服务（FastAPI 接口，随用随取，412 自动自愈，全程不落盘）；批处理落盘用 `selfheal` 服务（采集 + 下载一体）。

**实测环境**：Docker Desktop 29.7.2（Windows / Linux 容器模式）、Docker Compose v2。

---

## 一、⚠️ 最重要的实测发现：Cookie 有效期只有 1~3 分钟

最初我判断 Cookie 有效期约 8~15 分钟，**这是错的**。本次启动服务时做了严格的时间实验：

| 实验 | 条件 | 结果 |
|---|---|---|
| 同容器采集后立即用 | T+0s | ✅ 200 PDF |
| 同容器连续用 3 次 | T+0s ×3 | ✅ 200 / 200 / 200 |
| 同容器等待后复用 | T+180s | ❌ 412 |
| 跨容器用同一份 Cookie | 间隔 3 分钟 | ❌ 412 |
| 共享网络栈（`--network container:`） | 间隔 3 分钟 | ❌ 412 |

关键结论：

1. **Cookie 有效期实际只有 1~3 分钟**，不是 15 分钟。
2. **与容器 IP 无关** —— 共享网络栈后依然 412，变量纯粹是时间。
3. **这意味着「独立 Cookie 供应端 + 定时刷新」方案从根本上不可行** —— 刷新周期必然大于有效期，业务请求总落在空窗期。

### 因此架构改为「自愈」

把采集与下载放在**同一次执行**内，并让客户端在遇到 412 时立即重新采集：

```
收到 412 → 自动调用 fetch-invoice.js 重取 Cookie → 重试下载
```

采集与使用的时间差 < 1 秒，必然在有效期内。

---

## 二、实测验证清单

| 场景 | 结果 |
|---|---|
| `docker build` 构建多阶段镜像 | ✅ Cookie 采集 609 字节 |
| `docker run` 单镜像直接下载 | ✅ `✓ /app/out/invoice.pdf 151901 字节` |
| PDF 文件头校验 | ✅ `%PDF-1.7` … `%%EOF` |
| compose `selfheal` 首次运行 | ✅ `[自愈] 采集完成: 609 字节` → `151959 字节` |
| compose `selfheal` + **失效 Cookie** | ✅ `↻ 收到 412` → `↻ 已获取新 Cookie (608 字符)` → `151898 字节` |
| 纯 HTTP 容器（node:22-alpine，无浏览器） | ✅ 151903 字节 |
| 批量下载（2 条 URL） | ✅ 成功 2/2 |

**自愈机制的严格验证**（故意注入失效 Cookie）：
```
[Cookie] /app/cookies/waf_cookie.txt  (85 字符)      ← 故意放的失效 Cookie
  ↻ 收到 412，正在自动重新采集 Cookie ...
  ↻ 已获取新 Cookie (608 字符)
  ✓ /app/out/invoice.pdf  151898 字节
```

---

## 三、服务说明

| 服务 | 基础镜像 | 大小 | 含浏览器 | 用途 |
|---|---|---|---|---|
| **`api`** ⭐ | Playwright 官方镜像 + Python | 3.07GB | ✅ | **推荐**。FastAPI 服务，随用随取，412 自动自愈，全程不落盘（见 [API.md](API.md)） |
| `selfheal` | Playwright 官方镜像 | 2.98GB | ✅ | 一次性命令行：采集 + 下载 + 自愈，PDF 落到宿主机 `out/` |
| `http-only` | `node:22-alpine` | 239MB | ❌ | 纯 HTTP，需要外部提供 1~3 分钟内有效的 Cookie |
| `invoice` | `node:22-alpine` | 239MB | ❌ | 构建时采集 Cookie，运行时下载（一次性任务） |

> **没有定时服务。** 早期版本的 `daemon` / `cookie-provider` 因"定时反复访问易被加黑"已移除，详见下方「四之二」。

体积对比：需要浏览器能力的 `api` / `selfheal` 都基于 Playwright 官方镜像（约 3GB，含 Chromium）；`http` / `invoice` 是纯 HTTP 版（239MB，不含浏览器）。早期还有一个基于 apt chromium 的 `selfheal-lite` stage，因国内 apt 源构建极慢（实测 26 分钟未完成）且从未投产，**已从 Dockerfile 移除**。

### 容器空间不增长

所有浏览器相关服务都做了**可写层零增长**处理：

| 措施 | 作用 |
|---|---|
| compose `tmpfs: /tmp` | 浏览器 profile、Chromium 缓存不落容器层 |
| compose `tmpfs: /var/cache/fontconfig` | 字体缓存不落容器层 |
| `HOME=/tmp` + `XDG_CACHE_HOME`/`XDG_CONFIG_HOME` | Chromium 配置目录指向 tmpfs |
| `PYTHONDONTWRITEBYTECODE=1`（api） | 不生成 `.pyc` |
| CDP `Browser.setDownloadBehavior: deny` | **禁止 Chromium 自动下载 PDF**（原本会落到 `~/Downloads` 堆积） |
| `fetch-invoice.js` 等待浏览器退出后再删 profile | 原先删不掉会残留 `waf_prof_*` 目录 |

实测：`api` 服务连续 10 次调用后，可写层 **36.9kB → 36.9kB，完全无变化**。

> `selfheal` 的 PDF 输出到 `./out`，那是**宿主机挂载卷**，不占容器可写层；`api` 服务则完全不落盘。

---

## 四、最快上手

### FastAPI 服务（推荐生产用法）

```bash
cd waf-bypass

# 1. 配置目标 URL（可选，服务本身接受任意 URL 参数）
cp .env.example .env
#   TARGET_URL=...

# 2. 构建并启动（后台常驻，崩溃自动重启）
docker compose build api
docker compose up -d api

# 3. 看状态与日志
docker compose ps
docker compose logs -f api
```

调用：
```bash
URL=$(grep '^TARGET_URL=' .env | cut -d= -f2-)
curl -G --data-urlencode "url=$URL" http://localhost:8000/fetch -o invoice.pdf
```

详见 [API.md](API.md)。

### 一次性执行（落盘到宿主机 out/）

```bash
docker compose build selfheal
docker compose run --rm selfheal     # 采集 + 下载 + 自愈，跑完退出
```

### 纯 docker 命令

```bash
docker build --no-cache -f waf-bypass/Dockerfile --target selfheal \
  -t waf-selfheal:latest .

docker run --rm \
  -v "$(pwd)/out:/app/out" \
  -v "$(pwd)/cookie:/app/cookies" \
  -e TARGET_URL="<发票URL>" \
  waf-selfheal:latest
```

> ⚠️ 加 `--no-cache`。实测遇到过 Dockerfile 已 COPY 新文件、但镜像里却没有的情况 —— Docker 构建缓存没失效。改完 Dockerfile 建议加这个参数。
>
> ⚠️ **不要用 `--build-arg TARGET_URL=...`** —— 早期版本这么写，会把真实发票 URL 固化进镜像 config（`docker inspect` 可见，公开仓库会泄露发票号码）。现在 `TARGET_URL` 一律运行时用 `-e` 传入。

### 批量下载

```bash
docker run --rm \
  -v "$(pwd)/out:/app/out" \
  -v "$(pwd)/urls.txt:/app/urls.txt:ro" \
  -e TARGET_URL="<URL>" \
  -e BATCH_FILE=/app/urls.txt \
  waf-selfheal:latest sh -c '/app/run-selfheal.sh "$TARGET_URL" /app/out/invoice.pdf'
```

---

## 四之二、⚠️ 为什么没有定时服务

早期版本有 `daemon`（常驻定时，每 600 秒下载一次）和 `cookie-provider`（定时刷新 Cookie），**现已移除**。

原因：**固定周期地反复访问同一域名，容易被服务端识别为爬虫行为而加黑**，一旦进了黑名单，正常的人工请求也会被拦，反而更糟。

改为**随用随取**：

- 不做任何后台预采集，只在收到 412 时才现场采集 Cookie
- 采集到的新 Cookie **按域名单独缓存**在内存里，下次访问该域名直接复用
- 缓存失效（返回 412）就丢弃并重新采集一次
- **拿到新 Cookie 仍返回 412 就直接放弃**，不再重试，避免死循环

单次请求最多 3 次 HTTP 尝试：`direct` → `cached_cookie` → `healed`，**有界，不会打转**。

---

## 五、踩过的坑（都已修复，附原因）

### 1. ENTRYPOINT + CMD 组合导致参数被吞
```
失败: Invalid URL
```
原因：`ENTRYPOINT ["node", "http-client.js"]` 是 exec 形式，`CMD ["sh","-c","..."]` 会被当作**参数拼接**给 node。
**修复**：去掉 ENTRYPOINT，直接用 shell 形式 `CMD ["/bin/sh","-c","..."]`。

### 2. compose 的 command 覆盖镜像 CMD 时不做变量展开
```
exec: "/app/run-selfheal.sh \"$TARGET_URL\" /app/out/invoice.pdf\n": no such file or directory
```
原因：compose `command` 列表项不做 shell 展开，整行被当成可执行文件名。
**修复**：改用 `entrypoint: ["/bin/sh","-c"]` + `command: ["/app/run-selfheal.sh \"$$TARGET_URL\" ..."]`（`$$` 转义为容器内 `$`）。

### 3. 输出写 `/app/out.pdf` 报 EACCES
```
失败: EACCES: permission denied, open '/app/out.pdf'
```
原因：镜像 `USER node`，`/app` 属 root；`/app/out` 是挂载卷，可写。
**修复**：输出路径改 `/app/out/invoice.pdf`。

### 4. 挂载卷遮蔽镜像内脚本
```
Error: Cannot find module '/app/fetch-invoice.js'
```
原因：`- ./cookie:/app` 把整个 `/app` 换成宿主机目录，镜像里 COPY 的脚本全没了。
**修复**：挂载点改 `/data`（供应端）、`/app/cookies`（业务端）。

### 5. compose 多行 `command` 被拆散
```
sleep 600
done
: no such file or directory
```
原因：YAML 多行 command 列表在 Windows 换行符下被逐行拆成独立 argv。
**修复**：逻辑写进 `.sh` 脚本，compose 只写 entrypoint。

### 6. Playwright 镜像 Node 20 没有全局 WebSocket
```
失败: WebSocket is not defined
```
原因：Node 22+ 内置全局 `WebSocket`；Playwright v1.47 镜像内是 Node 20.17，没有。
**修复**：`fetch-invoice.js` 加**自举逻辑** —— 检测不到 `WebSocket` 时自动用 `--experimental-websocket` 重启自己；再不行回退 `require('ws')`。

### 7. Playwright 镜像的 Chromium 路径
`mcr.microsoft.com/playwright:v1.47.0-noble` → `/ms-playwright/chromium-1134/chrome-linux/chrome`

**修复**：`findBrowsers()` 增加 `/ms-playwright` 自动探测（扫描 `chromium-*` 目录），**版本号变化也无需改配置**。

### 8. Git Bash 路径转换
```
docker: Error response from daemon: the working directory '...' is invalid
```
原因：MSYS 把 `-w /app` 转成了 Windows 路径。
**修复**：加 `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"` 前缀，或改用 PowerShell。

### 9. Cookie 文件被误读（隐蔽）
现象：明明指定了失效 Cookie，却下载成功了。
原因：`loadCookie()` 依次找 `--cookie-file` > `WAF_COOKIE` > `WAF_COOKIE_FILE` > `__dirname/waf_cookie.txt` > `cwd/waf_cookie.txt`。旧文件 `__dirname/waf_cookie.txt` 里存着上次运行留下的有效 Cookie，被优先读到了。
**修复**：`run-selfheal.sh` 显式 `export WAF_COOKIE_FILE=/app/cookies/waf_cookie.txt`，并把 Cookie 统一存到独立目录。

---

## 六、关键约束

### 1. Cookie 有效期 1~3 分钟 —— 必须自愈
这是本方案的核心。任何依赖「长期持有 Cookie」的设计都不可行。`http-client.js` / `http_client.py` 已内置 412 自愈，默认开启（`--no-heal` 可禁用）。

### 2. 自愈依赖同目录有 fetch-invoice.js
`http-client.js` 会在 `__dirname` 找 `fetch-invoice.js`。纯 HTTP 镜像（`http-only`）没带这个文件，遇到 412 会提示「同目录下未找到 fetch-invoice.js，无法自动采集」。

### 3. Cookie 失效的主因是时间，不是 IP
同一台 Docker 主机上的容器出口 IP 相同（NAT 后），**跨容器可以复用**。实测把容器共享网络栈（`--network container:`）后，间隔 3 分钟的 Cookie 依然 412 —— 说明变量是**时间**而非 IP。

**唯一真正的硬约束**：Cookie 必须在 1~3 分钟内用掉。因此：
- 采集与使用必须在同一进程/同一次会话内完成（自愈模式天然满足）
- 跨主机部署时不必担心 IP，但**不能**指望预先采集的 Cookie 能跨主机存活过有效期

K8s 多副本：自愈模式下每次请求都会重新采集，约束很弱；若改用共享缓存，需保证各 Pod 能在有效期内（1~3 分钟）消费到该缓存。

### 4. Chromium 在容器里需要 `--no-sandbox`
`fetch-invoice.js` 已内置 `--no-sandbox` 和 `--disable-dev-shm-usage`。

### 5. 中文 PDF 需要 CJK 字体
`api` / `selfheal` 基于 Playwright 官方镜像，**自带 CJK 字体**，无需额外安装。纯 HTTP 镜像（`http-only` / `invoice`）不渲染 PDF，只做文件搬运，也不涉及字体。缺字体可能导致 PDF 渲染异常。

### 6. Alpine 跑不了 Chromium
最终镜像用 `node:22-alpine` 只跑纯 HTTP，没问题。但**采集阶段绝不能用 Alpine**（musl 缺 glibc 依赖）。

---

## 七、Python 版进容器

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY waf-bypass/http_client.py waf-bypass/fetch-invoice.js ./
RUN pip install --no-cache-dir requests
ENV WAF_COOKIE=""
ENTRYPOINT ["python", "http_client.py"]
```

`http_client.py` 同样内置了 412 自愈（调用同目录的 `fetch-invoice.js`）。

---

## 八、Kubernetes 部署形态

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: waf-client
spec:
  replicas: 2
  selector:
    matchLabels: { app: waf-client }
  template:
    metadata:
      labels: { app: waf-client }
    spec:
      containers:
        - name: client
          image: waf-selfheal:latest
          env:
            - name: TARGET_URL
              valueFrom: { configMapKeyRef: { name: waffle, key: url } }
          volumeMounts:
            - { name: out, mountPath: /app/out }
            - { name: cookies, mountPath: /app/cookies }
      volumes:
        - name: out
          emptyDir: {}
        - name: cookies
          emptyDir: {}
```

因为自愈版自带浏览器，**不需要**额外的 Cookie 供应 CronJob。唯一约束：多副本需同一 SNAT 出口（自愈模式下约束较弱，因为每次请求都会重新采集）。

---

## 九、命令速查

```bash
# 查看运行中的容器
docker compose ps

# 查看自愈日志
docker compose logs -f selfheal

# 查看镜像
docker images | grep waf-

# 停止
docker compose down

# 清理（含卷）
docker compose down -v
```
