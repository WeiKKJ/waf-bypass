# 纯 HTTP 模式（无浏览器）· 实测报告

结论先说：**可以，但 Cookie 必须先补一次。** WAF 的JS 挑战无法用纯 HTTP 完整复现，但挑战只需跑一次；拿到 Cookie 后所有下载都是普通 HTTP。

> ⚠️ **本文档的时效性说明**
> 本文成文于项目早期，当时的结论是「Cookie 有效期约 8~15 分钟 → 定时刷新供应端可行」。**后续严格实测证明这是错的**：Cookie 有效期实际仅 **1~3 分钟**（见 [DOCKER.md](DOCKER.md) 第一节），定时供应架构从根本上不可行。
> 当前项目的推荐架构已改为**随用随取**（收到 412 才现场采集），对外通过 FastAPI 服务提供，见 [API.md](API.md)。本文保留纯 HTTP 技术路线的实测记录（尤其路线 B 的负面结论），架构部分已按新结论重写。

---

## 一、三条路线实测对比

| 路线 | 浏览器 | 额外依赖 | 结果 |
|---|---|---|---|
| **A. 纯 HTTP + 手动 Cookie** | 不需要 | 无 | ✅ **200 PDF**（推荐） |
| **B. jsdom 模拟执行挑战** | 不需要 | `npm i jsdom` + `canvas` | ❌ 400，实测失败 |
| **C. headless Chrome + CDP** | headless | 无 | ✅ 200 PDF（Cookie 补取用） |

---

## 二、路线 B 为什么失败（值得记录的负面结论）

尝试用 `jsdom` 在纯 Node 环境里执行瑞数挑战 JS，彻底不碰浏览器。日志：

```
[1] 首次请求拿挑战页 + 种子 Cookie
    status 412 len 2894
[2] 下载挑战 JS
    len 232730
[3] 在 jsdom 中执行挑战
    [jsdomError] Uncaught [ReferenceError: _$kZ is not defined]
    [jsdomError] Not implemented: HTMLCanvasElement's getContext() method
[4] Cookie 数量 3
    名称: gizqLgxJ4gkhO, enable_gizqLgxJ4gkh, gizqLgxJ4gkhP
[5] 用 jsdom 拿到的 Cookie 重放
    HTTP 400 text/html 6 字节
```

三个致命问题：

1. **`_$kZ is not defined`** —— 混淆代码依赖真实的 `window` 属性顺序与 `document` 初始化时序，jsdom 的执行环境对不上，函数定义链断掉。
2. **Canvas 指纹缺失** —— 瑞数用 `getContext('2d')` 画图再读像素做浏览器指纹。jsdom 不实现，必须额外装原生 `canvas` 包（需要编译，跨平台易失败）。
3. **生成的 Cookie 结构不完整** —— 只有 3 个 Cookie，且含 `enable_` 前缀这种异常项；真实浏览器产出 4 个（`gizqLgxJ4gkhO` / `gizqLgxJ4gkhP` / `lzkqow39189` / `DTSwUOYx7MiWN`）。服务端校验时发现指纹链断裂，直接返 400。

**结论**：瑞数的挑战不止是「算个值」，而是把浏览器指纹编进 Cookie。jsdom 这类模拟环境过不了关，除非把挑战 JS 反混淆后自己实现整套指纹生成——成本远高于「装个 Chrome 跑一次」。**不建议在生产里走这条路。**

---

## 三、路线 A：推荐的纯 HTTP 用法

### 一次性准备（**必须在 1~3 分钟内用掉**）

```bash
node fetch-invoice.js --cookie-only "<任意该站点的URL>" | grep '^Cookie:' | sed 's/^Cookie: //' > waf_cookie.txt
```

> ⚠️ 采集后请**立即**使用。Cookie 过期后再用只会拿到 412。

### 日常下载（纯 HTTP，全程零浏览器）

```bash
node http-client.js "<URL>" invoice.pdf
node http-client.js --url-from-file list.txt      # 批量
node http-client.js "<URL>" --check               # 只探测
```

`http-client.js` 内置 **412 自愈**：一旦收到 412，会自动调用同目录的 `fetch-invoice.js` 现场重取 Cookie 再重试（有界，不会死循环）。`--no-heal` 可禁用。

Python 版：

```bash
export WAF_COOKIE="$(cat waf_cookie.txt)"
python http_client.py "<URL>" invoice.pdf
```

### 实测输出

```
[Cookie] waf_cookie.txt  (608 字符)
批量模式：2 条
  ✓ out_001.pdf  151897 字节
  ✓ out_002.pdf  151896 字节
成功 2/2
```

Cookie 过期时的行为：

```
  ✗ [1/2] HTTP 412 —— Cookie 无效或已过期。
成功 0/2
提示：Cookie 已失效，重取后重跑。
```

---

## 四、Cookie 时效的精确实测

> 下表是**早期**的测量结果，当时得出「8~15 分钟」的有效期。**后续更严格的时间实验推翻了这个结论**，实际有效期是 **1~3 分钟**（[DOCKER.md](DOCKER.md) 第一节有完整实验记录）。

| 场景 | 结果 |
|---|---|
| 取 Cookie 后立即用 | 200 PDF |
| 同一 Cookie 连续 2 次请求 | 200 / 200（不复用状态） |
| 约 8 分钟后复用（先前成功的同一 Cookie） | **412** |
| 重取后立即批量 2 条 | 200 / 200 |

关键结论：

- Cookie **约 8~15 分钟**失效（瑞数服务端签名带时间窗），不是固定的 15 分钟。 ← **已被后续实测修正为 1~3 分钟**
- 有效期内可**跨 URL 复用**，同站点多个接口通用。
- 有效期内可**并发/连续**请求，不是一次一换。
- 批量任务务必在**一次会话内**完成，别把 Cookie 落盘隔天再用。

---

## 五、推荐的生产架构

**当前架构（随用随取）：**

```
              ┌──────────────────────────────────────┐
   业务请求   │  FastAPI 服务 /fetch?url=...          │
              │  ① 直接 GET（不带 Cookie）             │
              │  ② 412 → 试该域名内存缓存的 Cookie      │
              │  ③ 仍 412 → 现场采集一次 → 重放        │
              │  ④ 还 412 → 放弃，不重试（防死循环）    │
              └──────────────┬───────────────────────┘
                             │ 仅在 412 时
                    ┌────────▼─────────┐
                    │ fetch-invoice.js │ ← 需要 Chrome
                    │  --cookie-only   │
                    └──────────────────┘
```

要点：

- **不做定时预采集**。固定周期反复访问同一域名容易被服务端识别为爬虫而加黑。
- 采集到的 Cookie **按域名单独缓存在内存**，下次访问该域名直接复用；失效立即丢弃。
- 采集与使用的时间差 < 1 秒，必然在有效期内。
- 全程不落盘，容器可写层不随调用次数增长。

> 早期版本曾用「每 10 分钟刷新 Cookie 供应端 + 业务端纯 HTTP」的架构（浏览器只做 Cookie 供应）。**该方案已被实测否决** —— 1~3 分钟的有效期远短于任何合理的刷新周期，业务请求总落在空窗期。下方旧架构图仅作历史记录保留。

<details>
<summary>（历史）已被否决的定时供应架构</summary>

```
              ┌─────────────────────────────┐
   每 10 分钟 │ fetch-invoice.js --cookie-only│  ← 需要 Chrome，仅一次
              └──────────┬──────────────────┘
                         │ 写入
                    waf_cookie.txt
                         │ 读取
              ┌──────────▼──────────────────┐
   业务请求   │  http-client.js  /  http_client.py │  ← 纯 HTTP，可任意扩容
              └─────────────────────────────┘
```

</details>

---

## 六、如果确实要「一条命令搞定」

在业务机上装 Chrome，用 `fetch-invoice.js`（路线 C）即可，无需本文档。两条路的选择：

| 场景 | 选择 |
|---|---|
| 人工取数、临时排查 | `fetch-invoice.js`（一条命令） |
| 对外提供 HTTP 接口 | **FastAPI 服务**（`api.py`，见 [API.md](API.md)） |
| 容器内一次性批处理 | `selfheal` 服务（采集 + 下载一体，Dockerfile 的 `selfheal` stage） |
| 完全不装浏览器 | 做不到。jsdom 路线实测失败 |