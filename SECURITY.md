# 镜像安全说明

本文档记录本项目镜像的**敏感信息防护规则**，以及 2026-10 的一次真实泄露事件与修复。

> **当前镜像名**（精简重构后）：
> `weikkj/waf-api` —— 唯一镜像，提供 HTTP 服务。
>
> 下文「二、已发生的事件」章节保留的是**历史记录**，其中的旧镜像名
> （`waf-api` / `waf-selfheal` / `waf-http` / `waf-invoice`）指当时的镜像，不是当前名称。

---

## 一、核心规则（不要移除）

### 规则 1：TARGET_URL 一律运行时传入，不得固化进镜像

`ENV TARGET_URL=${TARGET_URL}` 会把目标 URL 写进镜像 **config**（不是文件层）。
后果：

- `docker inspect <image>` 直接可见
- `docker history <image>` 直接可见
- 推到 Docker Hub 后，**任何人都能拉取 config 读到**
- 镜像一旦推送，泄露无法撤回（只能删 tag，且已拉取的人手里已有）

**正确做法**：

```dockerfile
# ❌ 错误
ARG TARGET_URL
ENV TARGET_URL=${TARGET_URL}

# ✅ 正确：镜像里不出现，运行时传
CMD ["/bin/sh", "-c", "node http-client.js \"$TARGET_URL\" /app/out/invoice.pdf"]
```

```bash
# ❌ 错误
docker build --build-arg TARGET_URL="https://...Fphm=<发票号码>..."

# ✅ 正确
docker build -t waf-api:latest .
docker run -e TARGET_URL="https://...Fphm=..." waf-api:latest
```

### 规则 2：不得把 Cookie 烤进镜像

瑞数挑战 Cookie 有效期实测仅 **1~3 分钟**。构建期采集的 Cookie 在镜像发布时**必然已失效**，
所以烤进镜像既无效又泄露凭据。

**正确做法**：Cookie 运行时采集，或从卷挂载读入。

```dockerfile
# ❌ 错误
COPY --from=cookie /app/waf_cookie.txt ./waf_cookie.txt
```

```bash
# ✅ 正确：从宿主机目录挂载
docker run -v "$(pwd)/cookie:/app/cookies:ro" -e TARGET_URL="..." waf-api:latest
```

### 规则 3：推送/导出前必须跑扫描

```bash
python tools/scan_image_secrets.py weikkj/waf-api:latest
```

退出码 0 = 干净，1 = 发现泄露（禁止推送）。

---

## 二、2026-10 泄露事件

### 发生了什么

早期 Dockerfile 有两个问题：

1. `http` 与 `selfheal` stage 都写了 `ARG TARGET_URL` + `ENV TARGET_URL=${TARGET_URL}`
2. 存在一个 `cookie` stage，在**构建期**访问目标站点采集 Cookie 并 `COPY` 进最终镜像

这两个问题叠加，导致 `weikkj/waf-http` 与 `weikkj/waf-invoice` 两个公开镜像的 config 中
含有**真实发票 URL**（含发票号码 `Fphm=<号码>`、校验码、开票日期等），
且 `/app/waf_cookie.txt` 中含有一份瑞数挑战 Cookie。

同时还发现 `waf-invoice` 与 `waf-http` 在 compose 里 `target` **都是 `http`** ——
它们本质是同一个镜像，只差构建期烤进去的 URL 内容不同，属于设计冗余。

### 影响范围

| 载体 | 状态 |
|---|---|
| Docker Hub `weikkj/waf-http` | 已删除 tag，并已用无泄露版本重新推送 |
| Docker Hub `weikkj/waf-invoice` | 已删除 tag（仓库本身因网络限制未能删除，但已无 tag、无法拉取） |
| Docker Hub `weikkj/waf-api` | **未受影响**（该 stage 从未设置 TARGET_URL） |
| Docker Hub `weikkj/waf-selfheal` | **未受影响**（`TARGET_URL` 为空构建） |
| Git 仓库 | **未受影响**（`.env` 已被 `.gitignore` 排除，历史无泄露） |
| `D:\waf-bypass-images\` 离线包 | 已重新生成，新包不含泄露 |
| 本地 `dh_blobs/` 上传缓存 | 已重建，不含泄露 |

### 修复动作

1. **删除** 泄露的 `waf-http:latest` / `waf-invoice:latest` tag
2. **移除** `cookie` stage（构建期采 Cookie 本身就无意义）
3. **移除** 所有 `ENV TARGET_URL`
4. **合并** `invoice` 服务到 `http-only`（二者 target 相同）
5. **重建** 全部镜像并用新脚本扫描确认干净
6. **重新推送** 三个无泄露镜像
7. **重新生成** 离线 tar 包
8. 新增 `tools/scan_image_secrets.py` 作为推送门禁

### 遗留风险

真实发票 URL 与发票号码曾公开存在于 Docker Hub 上。已删除 tag，但：

- 已拉取过该镜像的人手里仍持有旧版本
- Docker Hub 的 blob 存储在 GC 前可能仍可通过 digest 访问

**建议**：该发票已开具完成，暴露窗口内的信息风险有限。若需彻底处置，
可在 Docker Hub 后台开启 blob 自动 GC，或联系 Docker Hub 支持清理。

---

## 三、扫描脚本说明

`tools/scan_image_secrets.py` 检查两类泄露：

**config 层**（ENV / Cmd / Entrypoint）
- 目标 URL 特征串：`exportDzfpwjEwm`（导出接口路径）、`Fphm=`、`Jym=`、`Czsj=`、`Kprq=`
- 瑞数 Cookie 名：`gizqLgxJ4gkhO` / `gizqLgxJ4gkhP` / `lzkqow39189` / `lzkqow38189` /
  `DTSwUOYx7MiWN` / `MKls83gqduGS`
- 敏感环境变量被固化：`TARGET_URL` / `WAF_COOKIE` / `COOKIE`

**文件层**（镜像内文件）
- `waf_cookie.txt` / `.env` / `*.cookie`
- 命中文件会再读前 400 字节，检查内容是否含上述特征串

### 实现上的两个坑

1. **容器内 `/bin/sh` 可能是 dash**，语法与 bash 不同。`find` 的括号组需反斜杠转义：
   ```sh
   find / -xdev -type f \( -name 'waf_cookie.txt' -o -name '*.cookie' \) 2>/dev/null
   ```
2. **`find` 即使找到结果也可能返回非 0**（如 `/proc` 下的权限错误），
   不能拿退出码判断成败，要看 stdout 是否有内容。

---

## 四、日常操作清单

### 构建

```bash
# 构建
docker compose build api
docker compose build api
docker compose build http-only

# 门禁：扫描
python tools/scan_image_secrets.py \
  waf-api:latest
```

### 推送

```bash
# 1. 门禁（必须通过）
python tools/scan_image_secrets.py weikkj/waf-api:latest

# 2. 导出
docker save -o waf-images.tar weikkj/waf-api:latest

# 3. 提取
python tools/extract_manifests.py waf-images.tar dh_manifests
python tools/extract_blobs.py waf-images.tar dh_blobs

# 4. 推送
python tools/push_all.py --manifests dh_manifests --blobs dh_blobs --pat "$PAT" \
  --repos weikkj/waf-api --primary weikkj/waf-api
```

### 导出离线包

```bash
docker save -o waf-bypass-images.tar \
  weikkj/waf-api:latest
python tools/oci2dockerarchive.py waf-bypass-images.tar waf-legacy.tar
gzip -6 waf-legacy.tar
```

---

## 五、凭据管理

- PAT 只通过 `--pat` 命令行传入，**不要写进脚本或提交到仓库**
- 临时 PAT 文件用完立即删除
- 泄露后到 https://hub.docker.com/settings/tokens 吊销重置
- 推送需要 `delete` scope 时，token 的 scope 字符串要写成
  `repository:<repo>:pull,push,delete`，多个 scope 之间的空格要编码为 `%20`
