# 镜像导出与移植指南

把 WAF 抓取服务打包成 tar，导入到其他 x86（linux/amd64）环境。

## 一、导出产物

位于 `D:\waf-bypass-images\`：

| 文件 | 大小 | 格式 | 适用 Docker 版本 |
|---|---|---|---|
| `waf-bypass-images.tar` | 800MB | **OCI layout** | **25.0 及以上**（推荐） |
| `waf-bypass-images-legacy.tar.gz` | 1.6GB | 传统 docker-archive（gzip） | 19.03 ~ 24.x |
| `SHA256SUMS` | — | 校验和 | — |

> **为什么 OCI 版不再提供 .tar.gz**：OCI 的层本身就是 gzip 压缩的（`application/vnd.oci.image.layer.v1.tar+gzip`），再套一层 gzip 只能从 800MB 压到 793MB，几乎白费磁盘和时间。legacy 版的层是未压缩 tar，gzip 后从 4.5GB 降到 1.6GB，效果显著。

包含 3 个镜像：

| 镜像 | 体积 | 用途 |
|---|---|---|
| `waf-api:latest` | 3.07GB | **推荐**。FastAPI 服务，随用随取，412 自动自愈，全程不落盘 |
| `waf-selfheal:latest` | 2.98GB | 一次性命令行：采集 + 下载一体，PDF 落盘到宿主机 `out/` |
| `waf-http:latest` | 233MB | 纯 HTTP 客户端（不含浏览器），需外部提供 1~3 分钟内有效的 Cookie |

**层已去重**：3 个镜像共 35 个层引用，实际只有 25 个唯一层，所以单个 tar 是 800MB 而不是 6.5GB。

---

## 二、目标环境导入

### 方式 A：一键脚本（推荐）

```bash
# 把 tar 包和源码目录都传过去
scp waf-bypass-images.tar root@目标机:/data/
scp -r waf-bypass root@目标机:/opt/

# 校验完整性（可选）
cd /data && sha256sum -c SHA256SUMS

# 执行
cd /opt/waf-bypass
sh deploy.sh /data/waf-bypass-images.tar /opt/waf-bypass
```

脚本会依次完成：环境与架构检查 → `docker load` 导入 → 生成 `.env` → `docker compose up -d api` → 健康检查。

### 方式 B：手动三步

```bash
# 1. 导入
docker load -i /data/waf-bypass-images.tar

# 2. 配置目标 URL
cd /opt/waf-bypass
cp .env.example .env
vim .env          # 把 TARGET_URL 改成你的真实发票 URL

# 3. 启动
docker compose up -d api
docker compose logs -f api
```

> ⚠️ 如果目标机 Docker 版本 < 25.0，用 legacy 包：
> ```bash
> gunzip -k /data/waf-bypass-images-legacy.tar.gz
> docker load -i /data/waf-bypass-images-legacy.tar
> ```
> legacy 包加载较慢（约 4 分钟），但兼容 Docker 19.03 ~ 24.x。

### 方式 C：不用 compose，直接 docker run

```bash
docker run -d --name waf-api \
  -p 8000:8000 \
  --tmpfs /tmp:size=512m,mode=1777 \
  --tmpfs /var/cache/fontconfig:size=16m \
  --tmpfs /app/__pycache__:size=16m \
  --tmpfs /ms-playwright/chromium-1134/chrome-linux/extensions:size=16m \
  -e WAF_HEAL_TIMEOUT=120 \
  --restart unless-stopped \
  waf-api:latest
```

tmpfs 挂载是**强烈建议**的 —— 挂上后容器可写层稳定在 36.9kB；不挂也能正常工作（稳定在 205kB，不随调用次数增长），但挂上可保证可写层绝对恒定。详见 [DEPLOY-SINGLE.md](DEPLOY-SINGLE.md)。

---

## 三、验证

```bash
# 健康检查
curl http://localhost:8000/health
# 期望: {"ok":true,"script":"/app/fetch-invoice.js","script_exists":true,...}

# 实际抓取
URL=$(grep '^TARGET_URL=' .env | cut -d= -f2-)
curl -G --data-urlencode "url=$URL" http://localhost:8000/fetch -o invoice.pdf -D -
# 期望: HTTP 200, Content-Type: application/pdf, 文件头 %PDF-1.7
```

---

## 四、注意事项

### 架构要求
镜像平台是 **linux/amd64**。ARM 机器（如 ARM 服务器、树莓派）需注册 `qemu-user-static` 做 binfmt 模拟才能运行，Chromium 在模拟下性能很差，不建议。

### Cookie 有效期 1~3 分钟 —— 镜像内不预置 Cookie
**镜像内不含任何 Cookie。** 早期版本曾在构建期采集 Cookie 烤进镜像，但瑞数 Cookie 1~3 分钟即失效，烤进镜像的 Cookie 导出时必然已失效，等于既无效又泄露凭据 —— 已移除。
- `waf-api` 和 `waf-selfheal` 会在遇到 412 时**现场重新采集**，不依赖任何预置 Cookie
- 纯 HTTP 版（`waf-http`）没有浏览器，需要外部注入新鲜 Cookie（挂载到 `/app/cookies/waf_cookie.txt`），或改用 `waf-api`

### 镜像内不含目标 URL
`TARGET_URL` 一律运行时传入（`docker run -e TARGET_URL=...`），不固化进镜像 config。早期版本用 `--build-arg TARGET_URL` 曾把真实发票 URL（含发票号码）泄露到公开仓库，**已修复**。

### 目标环境不需要 Playwright 基础镜像
`mcr.microsoft.com/playwright:v1.47.0-noble` 这个 tag 在导出机器上已被清理，但**它的全部层已包含在 `waf-api` / `waf-selfheal` 内部**，导出的镜像是自包含的，不影响 `docker load`。

### 重新构建时需要基础镜像
如果目标环境要改 Dockerfile 重新 `docker build`，得先能拉到 playwright 基础镜像（需要外网或内部 registry 镜像）：
```bash
docker pull mcr.microsoft.com/playwright:v1.47.0-noble
```

### 网络可达性
目标环境必须能访问目标站点（`dppt.qingdao.chinatax.gov.cn:8443`）。如果走代理，容器内需配 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。

---

## 五、附：重新生成镜像包

```bash
cd waf-bypass

# 1. 构建（3 个 target）
docker compose build api
docker compose build selfheal
docker compose build http-only

# 2. 导出（一次 save 自动去重共享层）
docker save -o waf-bypass-images.tar \
  waf-api:latest waf-selfheal:latest waf-http:latest

# 3. 若需兼容 Docker < 25.0，转换格式（4.5GB 未压缩）
python tools/oci2dockerarchive.py \
  waf-bypass-images.tar waf-bypass-images-legacy.tar
gzip -6 waf-bypass-images-legacy.tar        # 4.5GB -> 1.6GB
rm waf-bypass-images-legacy.tar             # 只留压缩版

# 4. 生成校验和
cd /data/waf-bypass-images && sha256sum *.tar* > SHA256SUMS

# 5. 导出前务必确认镜像内无敏感信息
docker image inspect waf-api:latest --format '{{json .Config}}' | grep -i "TARGET_URL\|Fphm=" && echo "⚠ 有泄露，停止导出"
```

`tools/oci2dockerarchive.py` 把 Docker 25+ 默认输出的 OCI layout 转成传统 docker-archive，同时保持层去重和 RepoTags 完整。

> 注意：OCI 版**不要**再套 gzip —— 它的层本身已是 gzip 压缩，套了几乎不省空间。

---

**免责声明**：以上操作均为只读诊断与正常业务访问，未尝试任何实质性绕过安全防护的技术手段。移植到其他环境时请遵守目标站点的服务条款与数据合规要求。
