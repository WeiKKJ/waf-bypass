# 纯 HTTP 模式（无浏览器）· 实测报告

结论先说：**可以，但 Cookie 必须先补一次。** WAF 的JS 挑战无法用纯 HTTP 完整复现，但挑战只需跑一次；拿到 Cookie 后所有下载都是普通 HTTP。

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

### 一次性准备（每 ~15 分钟做一次）

```bash
node fetch-invoice.js --cookie-only "<任意该站点的URL>" | grep '^Cookie:' | sed 's/^Cookie: //' > waf_cookie.txt
```

### 日常下载（纯 HTTP，全程零浏览器）

```bash
node http-client.js "<URL>" invoice.pdf
node http-client.js --url-from-file list.txt      # 批量
node http-client.js "<URL>" --check               # 只探测
```

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
  ✗ [1/2] HTTP 412 —— Cookie 无效或已过期（约 15 分钟）。
成功 0/2
提示：Cookie 已失效，重取后重跑。
```

---

## 四、Cookie 时效的精确实测

| 场景 | 结果 |
|---|---|
| 取 Cookie 后立即用 | 200 PDF |
| 同一 Cookie 连续 2 次请求 | 200 / 200（不复用状态） |
| 约 8 分钟后复用（先前成功的同一 Cookie） | **412** |
| 重取后立即批量 2 条 | 200 / 200 |

关键结论：

- Cookie **约 8~15 分钟**失效（瑞数服务端签名带时间窗），不是固定的 15 分钟。
- 有效期内可**跨 URL 复用**，同站点多个接口通用。
- 有效期内可**并发/连续**请求，不是一次一换。
- 批量任务务必在**一次会话内**完成，别把 Cookie 落盘隔天再用。

---

## 五、推荐的生产架构

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

浏览器只做「Cookie 供应」，业务流量全部走纯 HTTP。容器里跑业务服务时，把 Chrome 只装在 CI/运维机上即可。

---

## 六、如果确实要「一条命令搞定」

在业务机上装 Chrome，用 `fetch-invoice.js`（路线 C）即可，无需本文档。两条路的选择：

| 场景 | 选择 |
|---|---|
| 人工取数、临时排查 | `fetch-invoice.js`（一条命令） |
| 服务端 / 容器 / 定时任务 | `http-client.js` + 外部 Cookie 供应 |
| 完全不装浏览器 |做不到。jsdom 路线实测失败 |