# Docker Hub 推送工具

`tools/` 下的脚本用于把本项目镜像推送到 Docker Hub（`weikkj/waf-*`），**不依赖 docker CLI 的 push 通道**，走 Registry v2 HTTP 协议。

## 为什么不用 `docker push`

在有代理的环境里，`docker push` 推大层会断链：

```
write tcp 192.168.65.3->192.168.65.1:3128: write: broken pipe
```

Docker daemon 走 `192.168.65.1:3128` 代理，单次长连接约 2 分钟被切断。失败的都是 ≤89MB 的层成功、>600MB 的层失败 —— 正是「长连接被断」的特征。

本目录的脚本用 **4MB 分块上传**，每块一次短连接，配合直连（不走代理）+ token 自动续期，可稳定推送 600MB 以上的大层。

> 完整的推送步骤见 `DOCKER-HUB-PUSH.md`。

## 精简版之后：多数情况 `docker push` 就够了

旧版镜像最大层 631MB（Playwright 浏览器全家桶），必然踩上面的断链问题。
精简版换用 chromium-headless-shell 后，**最大层降到 215MB**
（`/usr/lib/chromium/`），实测 `docker push` 可正常完成。

因此本目录的脚本现在主要用于**兜底**：
若你的网络环境仍会切断长连接（表现为 `write: broken pipe`），
再回退到下面的分块上传流程。

---

## 前置条件

1. Docker Hub Personal Access Token（需 `read` + `write` + `delete` 权限）：
   https://hub.docker.com/settings/tokens
2. 本地有镜像的 OCI 导出（`docker save` 生成的 OCI layout tar）

## 使用流程

### 0. 门禁：扫描敏感信息（必做）

```bash
python tools/scan_image_secrets.py \
  weikkj/waf-api:latest
```

退出码 0 = 干净。检查镜像 config（ENV / Cmd）与文件层（`waf_cookie.txt` / `.env`）里
是否含目标 URL、发票号码、瑞数 Cookie。**有泄露就绝对不能推送** ——
推到公开仓库后无法撤回。详见 [SECURITY.md](SECURITY.md)。

### 1. 导出镜像

```bash
docker save -o waf-images.tar \
  weikkj/waf-api:latest
```

### 2. 提取 manifest 与层 blob

```bash
python tools/extract_manifests.py waf-images.tar dh_manifests   # manifest v2 JSON
python tools/extract_blobs.py    waf-images.tar dh_blobs        # 各层 blob
```

`dh_manifests/` 下会生成 `docker.io_weikkj_waf-api.manifest.json` 这样的文件
（`/` 替换为 `_`）。

### 3. 一键推送

```bash
python tools/push_all.py \
  --manifests dh_manifests --blobs dh_blobs --pat "$PAT" \
  --repos weikkj/waf-api \
  --primary weikkj/waf-api
```

`push_all.py` 对每个 repo 依次做：HEAD 查缺 → 缺失层分块上传 → 跨仓库 mount →
提交 manifest。**Docker Hub 全局去重**，已存在的层直接跳过，重推极快
（实测重推三个镜像只传了 3 个小 blob）。

> `--primary` 指定跨仓库 mount 的源仓库。多个镜像共享的大层（如 Playwright 基础层
> 602MB）在 Docker Hub 上不自动跨 repo 共享，需显式 mount。

### 3'. 手动分步（需要精细控制时）

`push_layer.py` 是**单层**接口：

```bash
python tools/push_layer.py --repo weikkj/waf-api \
  --blob dh_blobs/blob_<digest> --digest sha256:<digest> --pat $PAT
```

跨仓库挂载共享层：

```bash
python tools/mount_blob.py --repo weikkj/waf-api \
  --from weikkj/waf-api --digest sha256:27be7e60... --pat $PAT
```

提交 manifest（提交前会 HEAD 校验所有层存在，缺层则拒绝提交）：

```bash
python tools/push_manifest.py --repo weikkj/waf-api \
  --manifest dh_manifests/docker.io_weikkj_waf-api.manifest.json --pat $PAT
```

也可以直接用 docker CLI（不走代理、层较小时更省事）：

```bash
docker push weikkj/waf-api:latest
```

但注意 `docker push` 在有代理的环境推大层会断链（见下节），此时用上面的 `push_layer.py`。

### 4. 跨仓库挂载共享层

多个镜像共享的大层（如 Playwright 基础层 602MB）在 Docker Hub 上**不会自动跨 repo 共享**，需显式 mount：

```bash
python tools/mount_blob.py \
  --repo weikkj/waf-api \
  --from weikkj/waf-api \
  --digest sha256:27be7e60... \
  --pat $PAT
```

返回 `201` 即成功。token 需同时带目标仓库的 `pull,push` 与源仓库的 `pull` scope —— 脚本已自动处理。

### 5. 提交 manifest

```bash
python tools/push_manifest.py --repo weikkj/waf-api \
  --manifest dh_manifests/docker.io_weikkj_waf-api.manifest.json --pat $PAT
```

提交前会 HEAD 校验所有层是否已存在，缺层则明确列出并拒绝提交（避免产生「manifest 指向空层」的坏镜像）。

### 6. 校验

```bash
python tools/verify_remote.py --repos weikkj/waf-api
```

匿名拉取 manifest → HEAD 校验每个 blob 存在 → 抽查小层内容重算 sha256 比对。

## 关键实现细节

| 事项 | 做法 |
|---|---|
| 分块上传 | `POST /v2/<repo>/blobs/uploads/` → `PATCH <Location>` 带 `Content-Range` → `PUT <Location>&digest=...` |
| PATCH URL | **不能**追加 `chunk_start`/`chunk_end` 参数，会 404。必须原样使用响应中的 `Location` |
| 提交 digest | 必须保留 `Location` 的完整查询串（含 `_state` 游标），否则报 `BLOB_UPLOAD_INVALID / invalid secret` |
| token 续期 | registry token 有效期 300 秒，脚本每 200 秒主动续期；遇 401 立即换 token 重试当前块 |
| 无 body 请求 | `data=None` 时需显式补 `Content-Length: 0`，否则 registry 返回 411 |
| 代理 | 脚本内 `urllib.request.ProxyHandler({})` 强制直连，绕开代理长连接断链 |
| Location 头大小写 | HTTP/2 会把头名小写化（`location` 而非 `Location`），`dict(headers)` 键不保证大小写 —— 必须大小写不敏感地取 |
| Location 可能是相对 URL | 形如 `/v2/...` 时需拼上 `https://registry-1.docker.io` 前缀 |
| push_all 复用 | Docker Hub 全局去重，重推时绝大多数层已存在，HEAD 命中直接跳过 |

## 安全提示

- PAT 只通过 `--pat` 命令行传入，**不要写进脚本或提交到仓库**
- `dh_secret.txt` / `dh_pat.txt` / `dh_regtoken.txt` 等临时凭据文件用完请立即删除
- **推送前必跑 `tools/scan_image_secrets.py`** —— 镜像 config 里的 `TARGET_URL` 会被任何人读到，
  推到公开仓库后无法撤回。详见 [SECURITY.md](SECURITY.md)
- 若 PAT 泄露，请到 https://hub.docker.com/settings/tokens 吊销重置
- 删除 tag 需要 `delete` scope：
  `repository:<repo>:pull,push,delete`（多 scope 之间的空格要编码为 `%20`）
- 若 PAT 泄露，请到 https://hub.docker.com/settings/tokens 吊销重置

## 常见问题

**Q: `mount` 返回 401？**
token scope 不足。跨仓库 mount 需要源仓库的 `pull` 权限，`mount_blob.py` 已自动追加该 scope。

**Q: `mount` 返回 202 而不是 201？**
Docker Hub 判定该层需重新上传（跨 repo 层不共享）。改用 `push_layer.py` 对目标 repo 重传该层。

**Q: 大层传到一半 401？**
token 过期。脚本已内置续期与 401 重试，若仍失败请检查 PAT 是否有效。
