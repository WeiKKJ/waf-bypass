# FastAPI 服务使用说明

对外提供 HTTP 接口抓取受瑞数 WAF 保护的发票 PDF。

## 核心策略

**随用随取，不做定时预采集。**

```
①  先直接发普通 GET 请求（不带 Cookie）
        ↓ 返回 200 且是 PDF  →  直接返回
        ↓ 返回 412
②  试该域名已缓存的 Cookie
        ↓ 返回 200 → 返回 PDF
        ↓ 仍 412 → 丢弃该缓存
③  现场采集一次新 Cookie → 带 Cookie 重放 GET
        ↓ 返回 200 → 缓存该域名的 Cookie，返回 PDF
        ↓ 仍 412 → 放弃，不再重试
```

### 为什么不做定时采集

固定周期地反复访问同一域名，容易被服务端识别为爬虫行为而**加黑**，一旦进了黑名单，连正常的人工请求也会被拦。改成按需触发后，只有真实业务请求才会产生访问。

### 重试上限（不会死循环）

单次请求最多 **3 次** HTTP 尝试，**有界**：

| 步骤 | 说明 |
|------|------|
| `direct` | 不带 Cookie 的直接 GET |
| `cached_cookie` | 用该域名的缓存 Cookie 重试 |
| `healed` | 现场采集新 Cookie 后重试（**最后一次**） |

若 `healed` 后仍是 412，响应中会带 `give_up` 步骤并说明原因，**不再发起任何新请求**。

### 按域名隔离缓存

不同站点的瑞数挑战 Cookie 互不通用，因此缓存以 **host（含端口）** 为 key：

```python
_domain_cache = {"dppt.qingdao.chinatax.gov.cn:8443": {"cookie": "...", "at": 1758...}}
```

- 只在遇到 412 并成功采集后才写入
- 缓存失效（返回 412）立即丢弃，避免下次继续拿废 Cookie 去试
- 纯内存存储，进程重启即清空

## 不落盘保证

服务**不向磁盘写入任何文件**，容器可写层不会随调用次数增长：

| 项目 | 处理方式 |
|------|----------|
| PDF | 仅存在于内存，通过 `StreamingResponse` 直接流给调用方，**不写磁盘** |
| Cookie | 按域名缓存在**进程内存**（`_domain_cache`），**不写 Cookie 文件** |
| 浏览器 profile | `fetch-invoice.js` 在 `finally` 中等待浏览器退出后重试清理 |
| 浏览器下载 | CDP `Browser.setDownloadBehavior: deny` —— 禁止 Chromium 自动下载 PDF |
| Chromium 缓存 | `HOME=/tmp`，`XDG_CACHE_HOME`/`XDG_CONFIG_HOME` 指向 tmpfs |
| 容器卷 | compose 中 `api` 服务**不挂任何 volume** |
| pycache | `PYTHONDONTWRITEBYTECODE=1` + `/app/__pycache__` 挂 tmpfs |

调用方想保存 PDF 请自行在客户端落盘：

```bash
curl -G --data-urlencode "url=$TARGET_URL" http://localhost:8000/fetch -o invoice.pdf
```

`out/`、`cookie/` 挂载只属于 `selfheal` 等批处理服务，与本 API 服务无关。

### 实测：可写层零增长

```
初始:      waf-bypass-api-1   36.9kB (virtual 2.29GB)
10 次调用后 waf-bypass-api-1   36.9kB (virtual 2.29GB)   ← 完全没变
```

`docker diff` 中的条目全部是 tmpfs 挂载点（`/app/__pycache__` 实际占用 0 字节），不计入容器可写层。

## 启动

### Docker（推荐）

```bash
cd waf-bypass
docker compose up -d api
docker compose logs -f api
```

服务监听 `http://localhost:8000`。

### 本地

```bash
pip install -r requirements.txt
python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

> 本地跑自愈需要 `node` 与可用的 Chromium（`fetch-invoice.js` 会自动探测）。

## 接口

### `GET /fetch?url=...`

直接返回 PDF 二进制流，**不落盘**。

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 目标发票 URL（需 URL-encode） |

响应头带诊断信息：
- `X-Waf-Steps` —— JSON 数组，记录各步尝试与状态码
- `X-Waf-Status` —— 最终状态码
- `Content-Length` —— PDF 字节数

```bash
curl -G --data-urlencode "url=$TARGET_URL" \
     "http://localhost:8000/fetch" \
     -o invoice.pdf -D -
```

### `POST /fetch`

```bash
curl -X POST http://localhost:8000/fetch \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET_URL\"}"
```

响应体：

```json
{
  "ok": true,
  "status": 200,
  "content_type": "application/pdf;charset=utf-8",
  "length": 151906,
  "steps": [{"step": "direct", "status": 412}, {"step": "cached_cookie", "status": 200}],
  "persisted": false
}
```

`steps` 各段含义：

| step | 含义 |
|------|------|
| `direct` | 第一次不带 Cookie 的直接 GET |
| `cached_cookie` | 用该域名缓存的 Cookie 重试 |
| `healed` | 浏览器现场采集新 Cookie 后重试（最后一次机会） |
| `give_up` | 新 Cookie 仍被拒，已停止重试 |

### `GET /check?url=...`

只探测状态，不返回文件内容，适合排查。

```json
{"url":"...","status":200,"content_type":"application/pdf;charset=utf-8",
 "length":151892,"is_pdf":true,
 "steps":[{"step":"direct","status":412},{"step":"healed","status":200}]}
```

### `GET /cache`

查看各域名的 Cookie 缓存状态。

```json
{
  "count": 1,
  "domains": {
    "dppt.qingdao.chinatax.gov.cn:8443": {
      "cookie_len": 608, "age_seconds": 12.3, "at": 1758541234.5
    }
  }
}
```

### `DELETE /cache`

清空全部 Cookie 缓存。

```bash
curl -X DELETE http://localhost:8000/cache
# {"cleared": "*", "remaining": []}
```

### `DELETE /cache?domain=xxx`

只清除指定域名的缓存。

```bash
curl -X DELETE "http://localhost:8000/cache?domain=dppt.qingdao.chinatax.gov.cn:8443"
# {"cleared": "dppt.qingdao.chinatax.gov.cn:8443", "remaining": []}
```

### `GET /health`

```json
{"ok":true,"script":"/app/fetch-invoice.js","script_exists":true,
 "cached_domains":["dppt.qingdao.chinatax.gov.cn:8443"],"disk_write":false}
```

### `GET /`

返回接口索引与策略说明。

## 交互式文档

FastAPI 自带 Swagger UI：启动后访问 <http://localhost:8000/docs>，可直接在页面上试。

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WAF_UA` | Chrome 155 UA | 自定义 User-Agent |
| `WAF_HEAL_TIMEOUT` | `120` | 浏览器采集超时（秒） |
| `PORT` | `8000` | 监听端口 |

> 旧版的 `WAF_COOKIE_FILE` / `WAF_OUT_DIR` 已移除 —— Cookie 改存内存，PDF 不落盘。

## 实测记录

| 场景 | 结果 |
|------|------|
| 首次调用（内存无缓存 Cookie） | `direct 412` → `healed 200`，151897 字节 PDF |
| 二次调用（缓存 Cookie 仍有效） | `direct 412` → `cached_cookie 200`，151898 字节 |
| POST 接口 | `ok: true`，`persisted: false` |
| 容器可写层 | 连续调用后 `docker diff` 无文件增长 |

## 注意事项

- **Cookie 有效期实测仅 1~3 分钟**。内存缓存命中只是快路径，不能依赖它；超时后必定走 `healed`。
- 每次 `healed` 会启动一次 headless Chromium，约 5~10 秒开销。高并发建议在外层做限流或加锁。
- 自愈依赖 `fetch-invoice.js` 与 `api.py` **同目录**（容器内均在 `/app`）。
- 若目标返回的不是 PDF（挑战页、URL 失效），接口返回 4xx/502 并带 `hint` 字段。
