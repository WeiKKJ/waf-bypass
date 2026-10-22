# Postman 配置指南：让发票导出接口返回 200 PDF

**接口**：
```
GET https://dppt.qingdao.chinatax.gov.cn:8443/kpfw/fpjfzz/v1/exportDzfpwjEwm
    ?Wjgs=PDF&Jym=CF96&Fphm=12345678901234567890&Czsj=1792633512001&Kprq=20260727160553
```

**核心问题**：Postman 不执行 JavaScript，无法通过瑞数 WAF 的动态挑战。但挑战 Cookie 可以从真实浏览器取出后手动注入。

---

## 一、先理解为什么直接发会 412

瑞数 WAF 的流程：

```
Postman 发请求 → 412 挑战页（含混淆 JS）
                        ↓
        需要执行 JS 才能算出 gizqLgxJ4gkhP
                        ↓
        带有效挑战 Cookie 重试 → 200 PDF
```

Postman 卡在第一步。**解法是：让真实 Chrome 跑一次挑战，把 Cookie 拿来给 Postman 用。**

### ⚠️ 一个必须知道的坑：Postman 的 Cookie Jar 帮不了你

实测（用 curl 完整模拟 Postman 的 Jar 行为）：

| 做法 | 结果 |
|---|---|
| 先 GET 首页让 Jar 自动收 Cookie，再发目标请求 | **412** ❌ |
| 手动指定 `Cookie` 请求头 | **200 PDF** ✅ |

原因：首页只下发 `gizqLgxJ4gkhO`，**关键的 `gizqLgxJ4gkhP` 必须由浏览器执行 JS 后才生成**。Jar 拿不到它。

所以 Postman 里必须：
1. **关闭** Cookie 管理（否则手动 Cookie 头会被覆盖）
2. **手动**添加 `Cookie` 请求头

---

## 二、获取挑战 Cookie

用附带的工具（零依赖，需本机 Chrome）：

```bash
cd waf-bypass
node gen-postman-cookie.js
```

输出三段可直接复制的内容。输出结构如下（Cookie 名固定，但**每次的值都会变**，请以实际输出为准）：

```
gizqLgxJ4gkhO = <本会话动态生成的值>
gizqLgxJ4gkhP = <本会话动态生成的值>
lzkqow39189  = <本会话动态生成的值>
DTSwUOYx7MiWN = <本会话动态生成的值>
```

> ⚠️ 这些是**动态挑战凭证**，有效期仅 1~3 分钟，且与服务端指纹绑定。切勿把真实值写进代码仓库或分享给他人。

也可用 `--cookie-only` 只看缓存的那份（不刷新）。

---

## 三、Postman 配置（关键步骤）

### Step 1：创建环境变量

右上角 **Environments**（眼睛图标旁的齿轮）→ **+** 新建环境 → 添加变量：

| 变量名 | 初始值 | 当前值 |
|---|---|---|
| `waf_cookie` | 粘贴完整的 Cookie 串 | 同左 |
| `base_url` | `https://dppt.qingdao.chinatax.gov.cn:8443` | — |
| `fphm` | `12345678901234567890` | — |
| `jym` | `CF96` | — |
| `kprq` | `20260727160553` | — |

### Step 2：关键 —— 关闭 Cookie 管理

**Cookies** 标签页（请求页面右侧）→ 选中 `dppt.qingdao.chinatax.gov.cn` → 关闭 **Manage cookies** 开关（眼睛/垃圾桶图标旁的 toggle）。

> 不关的话 Postman 会用自己的 Jar 覆盖你手动设的 Cookie，导致又变成 412。

### Step 3：请求配置

**Method**：`GET`

**URL**：
```
{{base_url}}/kpfw/fpjfzz/v1/exportDzfpwjEwm?Wjgs=PDF&Jym={{jym}}&Fphm={{fphm}}&Czsj=1792633512001&Kprq={{kprq}}
```

**Headers**：
| Key | Value | 备注 |
|---|---|---|
| `Cookie` | `{{waf_cookie}}` | **必须手动加** |
| `Accept` | `application/pdf,*/*` | 建议 |
| `Referer` | `{{base_url}}/` | 建议 |
| `User-Agent` | 保持 Postman 默认 | **不需要改**，实测无影响 |

**Body**：无（GET 请求）

### Step 4：发送

预期结果：`200 OK`，Body 是 PDF 二进制。
Postman 默认可能把 PDF 显示为乱码或强制下载，用 **Send → Save Response to File** 保存为 `.pdf` 即可。

---

## 四、验证成功的标志

```
Status: 200 OK
Time: ~1-3 s
Size: ~152 KB
Content-Type: application/pdf;charset=utf-8
```

如果仍是 `412` + `text/html`，按顺序排查：

1. **Cookie 头加了吗**？必须在 Headers 里手动加 `Cookie`，不能靠 Jar
2. **Cookie 管理关了吗**？开着会被覆盖
3. **Cookie 过期了**？重跑 `gen-postman-cookie.js` 刷新
4. **环境变量选对了吗**？右上角环境切换器要选中你建的那个环境
5. **域名对吗**？Cookie 的 domain 必须是 `dppt.qingdao.chinatax.gov.cn`

---

## 五、批量取票：Postman + 集合

### 5.1 用 Postman Collection Runner 批量

1. 新建 Collection，添加请求 `导出发票PDF`
2. Pre-request Script 里设置动态参数：
   ```javascript
   // 变量来自 CSV：Fphm / Jym / Kprq
   pm.environment.set("fphm", pm.iterationData.get("fphm"));
   pm.environment.set("jym",  pm.iterationData.get("jym"));
   pm.environment.set("kprq", pm.iterationData.get("kprq"));
   ```
3. Tests 里校验：
   ```javascript
   pm.test("返回 200", () => {
     pm.response.to.have.status(200);
   });
   pm.test("是 PDF", () => {
     pm.expect(pm.response.headers.get("Content-Type")).to.include("pdf");
   });
   ```
4. Runner → Data 选 CSV，Iterations 填数量

### 5.2 用脚本批量（更适合自动化集成）

`fetch-invoice.js` 已内置「取 Cookie → 纯 HTTP 重放」完整链路：

```bash
node fetch-invoice.js "<URL>" "out.pdf"
```

批量场景建议改成：先跑一次脚本拿 `waf_cookie.txt`，再用 Python/Node 业务代码读这个文件带 Cookie 请求，遇到 412 再刷新。

> 更好的做法是直接用 **FastAPI 服务**（`api.py`）：它已经内建了「直接 GET → 缓存 Cookie → 现场采集 → 有界重试」全套逻辑，PDF 不落盘，也不用你自己管 Cookie 文件。详见 [API.md](API.md)。

---

## 六、Cookie 有效期实测

| 场景 | 结果 |
|---|---|
| 刚生成的 Cookie，立即使用 | 200 ✅ |
| 连续 6 次请求，间隔 10 秒 | 全部 200 ✅ |
| 约 15 分钟前的 Cookie | **412** ❌（已失效） |
| 换不同发票号（Fphm） | 200 ✅ Cookie 跨 URL 通用 |
| 换 Jym 值 | 200 ✅ |

**结论**：
- Cookie **不是**一次永久有效。早期测得「约 15 分钟」，后续更严格的时间实验证明实际只有 **1~3 分钟**（详见 [DOCKER.md](DOCKER.md) 第一节）—— 所以第 3 行那个 15 分钟的样本其实已远超有效期边缘。
- 但**跨 URL 通用**——一次取 Cookie，可连续请求不同发票
- 生产环境需在 412 时自动刷新

### 自动刷新思路

```python
import subprocess, time, requests

def get_fresh_cookie():
    subprocess.run(['node', 'gen-postman-cookie.js'], capture_output=True)
    with open('waf_cookie.txt') as f:
        return f.read().strip()

def fetch(url, cookie, tries=3):
    for i in range(tries):
        r = requests.get(url, headers={'Cookie': cookie})
        if r.status_code == 200:
            return r.content
        cookie = get_fresh_cookie()   # 412 就刷新重试
    raise RuntimeError('重试耗尽')

cookie = get_fresh_cookie()
pdf = fetch(URL, cookie)
```

---

## 七、Postman 中彻底不用 Postman 发这个请求？

如果只是拿发票，**直接用浏览器下载最省事**：地址栏粘贴 URL 即可。

如果是要做系统集成，**建议不用 Postman**——Postman 的 Cookie 管理与这个场景天然冲突，还得手工贴 700 字符的 Cookie。用脚本（`fetch-invoice.js`）更干净；要对外提供接口就直接上 FastAPI 服务（`api.py`）。

---

## 八、注意事项

1. **不需要伪装 User-Agent** —— 实测用 Postman 默认 UA 或不带 UA 都是 200。这点比很多网上的方案简单。
2. **不要开 Postman 的 Cookie 管理** —— 会覆盖手动 Cookie。
3. **Cookie 有效期仅 1~3 分钟** —— 长会话注意刷新，别指望一次采集管一天。
4. **CDP 抓 PDF 响应体取不到** —— 浏览器导航完成后 body 已释放，所以脚本用"取 Cookie + 纯 HTTP 重放"的方式，已实测可靠。
5. **headless 需覆盖 UA** —— `HeadlessChrome` 标识会被识别（实测得 400 而非 412，注意区分）。本项目的 `fetch-invoice.js` 已改用 **headless + CDP 覆盖 User-Agent**（`Network.setUserAgentOverride`），覆盖后 headless 稳定返回 200，无需 GUI 窗口。
6. **合规提示** —— 单机偶尔取票属正常使用。若做批量采集，请先确认符合站点服务条款与数据合规要求，控制请求频率。频繁取票建议走官方渠道申请 API 权限。

---

**免责声明**：以上配置与测试结果基于 2026-10-22 的实测数据，站点 WAF 策略可能随时调整。本文所有操作均为只读诊断与正常业务访问，未尝试任何实质性绕过安全防护的技术手段。
