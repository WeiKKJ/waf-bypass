# 单镜像部署（只部署 waf-api）

移植到其他系统时，**只拉 `weikkj/waf-api` 一个镜像就够了**。本文档说明为什么、以及完整的部署清单。

---

## 一、为什么单镜像够用

`waf-api` 镜像是**自包含**的，把自愈链路的全部要素都打进了同一层：

| 要素 | 在 api 镜像内？ | 说明 |
|---|---|---|
| FastAPI 服务（`api.py`） | ✅ | `uvicorn` 启动，`PORT=8000` |
| Cookie 采集脚本（`fetch-invoice.js`） | ✅ | 412 时由 `api.py` 现场调用 |
| Node.js 运行时 | ✅ | Playwright 镜像自带 Node v20.17 |
| Chromium 浏览器 | ✅ | Playwright 官方镜像自带，含 CJK 字体 |
| Python 3 + httpx | ✅ | 镜像内 `apt-get` 安装 |
| WebSocket 支持 | ✅ | Node 20 走 `--experimental-websocket` 自举，无需 `npm i ws` |

运行时的完整链路：

```
客户端 HTTP 请求
   ↓
api.py 直接 GET（不带 Cookie）→ 200？直接返回
   ↓ 412
subprocess 调 fetch-invoice.js --cookie-only → 起 Chromium 跑挑战 → 拿新 Cookie
   ↓
httpx 带新 Cookie 重放 → 200？缓存该域名 Cookie 并返回 PDF 流
```

**整个过程不依赖任何其他镜像、不依赖宿主机文件、不产生落盘。**

### 实测验证

在干净环境用 `docker run` 单独起一个 `weikkj/waf-api:latest`（无 compose、无挂载）：

```
GET /health  → {"ok":true,"script":"/app/fetch-invoice.js","script_exists":true,
                "cached_domains":[],"disk_write":false}
GET /check   → {"status":200,"is_pdf":true,"length":151894,
                "steps":[{"step":"direct","status":412},{"step":"healed","status":200}]}
GET /fetch   → http=200  size=151896  type=application/pdf
```

注意 `steps` 里的 `direct: 412 → healed: 200` —— 自愈在**纯容器内**真实生效了，不是走缓存的假阳性。

---

## 二、什么时候才需要另外三个镜像

| 镜像 | 什么时候需要 |
|---|---|
| `weikkj/waf-selfheal` | 需要**批量下载并落盘**到宿主机时（`docker run --rm -v ./out:/app/out`）。走 API 的话 PDF 直接走 HTTP 流回客户端，不落盘 |
| `weikkj/waf-http` | 需要**纯 HTTP 无浏览器**方案时。但它没有浏览器，412 无法自愈，必须外部注入 1~3 分钟内的新鲜 Cookie |
| `weikkj/waf-invoice` | 一次性任务，构建期已采 Cookie。仅在你确定 URL 完全固定、且不需要自愈时用 |

**只用 API 接口的话，这三个都不需要。**

---

## 三、部署前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 架构 | **linux/amd64**（x86_64） | ARM 需 `qemu-user-static` 模拟，Chromium 在模拟下极慢，不建议 |
| 内存 | ≥ 2GB 可用 | Chromium 跑挑战页的峰值开销 |
| 磁盘 | ≥ 3.5GB | 解压后镜像 3.07GB + 运行余量 |
| 出网 | 能访问**目标站点**（如 `dppt.qingdao.chinatax.gov.cn:8443`） | 采集 Cookie 和下载 PDF 都要出网 |
| 出网 | 能访问 `registry-1.docker.io` | 拉镜像（离线环境见 [DEPLOY-OFFLINE.md](DEPLOY-OFFLINE.md)） |

> ⚠️ **出网可达性是最容易被忽略的一项。** 容器内 DNS 走 Docker 内嵌 DNS（`127.0.0.11`），若宿主机或防火墙对容器网段有额外限制，`fetch-invoice.js` 会静默拿不到 Cookie，`/fetch` 返回 412。先用 `/check` 确认 `steps` 里有 `healed` 环节。

---

## 四、部署命令

### 4.1 拉镜像

```bash
docker pull weikkj/waf-api:latest
```

### 4.2 启动

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

#### 关于 tmpfs 的实测数据

各配置下调用一次 `/check` 后的容器可写层大小：

| 挂载的 tmpfs | 可写层 | 增长来源 |
|---|---|---|
| 四项全挂 | **36.9kB** | 理想状态，几乎不增长 |
| 仅 `/tmp` | 73.7kB | `/var/cache/fontconfig` 268K 字体缓存 |
| 不挂 | 205kB | 上述 + `/tmp` 128K（`.pki` 76K / `.config` 32K / `.cache` 12K） |

不挂 tmpfs **连续调用 5 次，可写层稳定在 205kB 不再增长** —— Chromium profile 目录（`/tmp/.org.chromium.Chromium.*`）是复用的，不会每次调用新建。

实测结论：**不挂 tmpfs 也能正常工作**。tmpfs 的价值是让可写层绝对恒定、避免长期运行时的意外写入（fontconfig 缓存随新字体累积等）。如果只是内网工具、容器用完即删，**挂 `/tmp` 一项就够**；追求确定性则四项全挂。

> 补充：`/app/__pycache__` 和 `/ms-playwright/chromium-1134/chrome-linux/extensions` 这两个路径在镜像里**本就不存在**，挂 tmpfs 是防御性的（Docker 挂载时会自动创建）。镜像内已设 `PYTHONDONTWRITEBYTECODE=1`，Python 不会写 pycache。

### 4.3 验证

```bash
# 健康检查
curl http://localhost:8000/health

# 关键：确认自愈路径生效（应看到 direct:412 → healed:200）
curl -G --data-urlencode "url=<你的发票URL>" http://localhost:8000/check

# 实际取票
curl -G --data-urlencode "url=<你的发票URL>" http://localhost:8000/fetch -o invoice.pdf
```

`/check` 返回的 `steps` 数组是关键指标：

| steps 内容 | 含义 |
|---|---|
| `[{"direct":200}]` | 目标站点当前没拦你（可能已放行或换了防护策略），无需自愈 |
| `[{"direct":412},{"healed":200}]` | ✅ **正常**，自愈成功 |
| `[{"direct":412},{"healed":412}]` | ❌ 自愈失败，看 `docker logs` 里 `fetch-invoice.js` 的输出 |
| `[]` | 目标 URL 无效或网络不通 |

---

## 五、开机自启

`--restart unless-stopped` 已覆盖 Docker 守护进程重启的场景。若用 `docker compose`，`restart: unless-stopped` 同样写在服务里。

```yaml
services:
  api:
    image: weikkj/waf-api:latest
    ports: ["8000:8000"]
    environment:
      - WAF_HEAL_TIMEOUT=120
    tmpfs:
      - /tmp:size=512m,mode=1777
      - /var/cache/fontconfig:size=16m
      - /app/__pycache__:size=16m
      - /ms-playwright/chromium-1134/chrome-linux/extensions:size=16m
    restart: unless-stopped
```

**注意 compose 里必须写 `image:` 而不是只写 `build:`** —— 目标机没有源码，也不该为了跑一个服务去装 Chromium 依赖。

---

## 六、反向代理注意事项

若前面挂 Nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_read_timeout 180s;      # 自愈要起 Chromium，最长可能 120s+
    proxy_buffering off;          # PDF 流式透传
    client_max_body_size 1m;
}
```

`proxy_read_timeout` 必须大于 `WAF_HEAL_TIMEOUT`（默认 120s），否则首个请求在自愈过程中会被网关掐断。

---

## 七、常见问题

**Q: `/fetch` 返回 412，logs 里没有报错？**
大概率是容器出网不通。用 `docker exec waf-api curl -sv https://目标站点/` 验证连通性。

**Q: 第一次调用很慢（20 秒+），第二次就快了？**
第一次要启动 Chromium 并等挑战 JS 执行完（`CHALLENGE_WAIT_MS=14000`），同时采集到的 Cookie 会被缓存到该域名，后续调用直接命中缓存。

**Q: 缓存的 Cookie 会不会过期导致误报 412？**
会。但服务有兜底：缓存 Cookie 返回 412 时会丢弃并现场重采一次，重采后仍 412 就放弃（不重试成环）。单请求最多 3 次 HTTP 尝试。

**Q: 内存不够被 OOM Kill？**
Chromium 是内存大户。给容器加 `--memory=2g --memory-swap=3g`，或调低 `WAF_HEAL_TIMEOUT` 减少并发堆积。

**Q: 需要多副本吗？**
不需要，也不建议 —— Cookie 缓存是**进程内内存**的，多副本各存各的，反而增加对目标站点的请求密度。单副本足够。

---

## 八、相关文档

- [API.md](API.md) —— 接口完整说明
- [DOCKER.md](DOCKER.md) —— 镜像构建与踩坑
- [DEPLOY-OFFLINE.md](DEPLOY-OFFLINE.md) —— 无法访问 Docker Hub 时的 tar 包导入
- [DOCKER-HUB-PUSH.md](DOCKER-HUB-PUSH.md) —— 推送到 Docker Hub
