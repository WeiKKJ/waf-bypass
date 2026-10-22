"""
瑞数 WAF 发票抓取 —— FastAPI 服务

核心策略（随用随取，不做定时预采集）：
    1. 先直接发普通 GET 请求（不带 Cookie）
    2. 返回 412 时，先试**该域名已缓存的 Cookie**
    3. 仍 412 时，才调用浏览器采集一次新 Cookie 并重放
    4. 新 Cookie 若仍是 412，**直接放弃**，不再重试（避免死循环）

    定时预采集被刻意去掉：固定周期地反复访问同一域名，
    容易被服务端识别为爬虫行为而加黑，反而害了正常请求。

Cookie 缓存按**域名**隔离（不同站点的挑战 Cookie 互不通用），
纯内存存储，不落盘。

【无落盘保证】
    本服务**不向磁盘写入任何文件**：
      - 不保存 PDF（PDF 仅在内存中，流式返回给调用方）
      - 不写 Cookie 文件（Cookie 缓存在进程内存中，随进程释放）
    因此容器可写层不会随调用次数增长。

环境变量：
    WAF_UA            自定义 User-Agent
    WAF_HEAL_TIMEOUT  浏览器采集超时秒数（默认 120）
"""

import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
SCRIPT = BASE_DIR / "fetch-invoice.js"
HEAL_TIMEOUT = int(os.environ.get("WAF_HEAL_TIMEOUT", "120"))

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")

# 按域名隔离的 Cookie 缓存（纯内存，不落盘）。
# 结构: { "host": {"cookie": str, "at": float} }
# 只在遇到 412 时才写入 —— 随用随取，不做定时预采集。
_domain_cache: dict = {}
_cache_lock = threading.Lock()

# 同一域名的并发请求串行化，避免同时启动多个 Chromium 采集同一站点
_domain_locks: dict = {}
_domain_locks_guard = threading.Lock()


def domain_lock(domain: str) -> threading.Lock:
    with _domain_locks_guard:
        lk = _domain_locks.get(domain)
        if lk is None:
            lk = threading.Lock()
            _domain_locks[domain] = lk
        return lk

app = FastAPI(
    title="瑞数 WAF 发票抓取服务",
    version="1.1.0",
    description="先直接 GET，收到 412 时自动用浏览器采集 Cookie 自愈重试。全程不落盘。",
)


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------
def origin_of(url: str) -> str:
    parts = url.split("/")
    if len(parts) < 3:
        raise ValueError("URL 格式不正确")
    return f"{parts[0]}//{parts[2]}"


def get_cached_cookie(domain: str) -> str:
    with _cache_lock:
        entry = _domain_cache.get(domain)
        return entry["cookie"] if entry else ""


def set_cached_cookie(domain: str, cookie: str) -> None:
    with _cache_lock:
        _domain_cache[domain] = {"cookie": cookie, "at": time.time()}


def drop_cached_cookie(domain: str) -> None:
    with _cache_lock:
        _domain_cache.pop(domain, None)


def domain_of(url: str) -> str:
    """按 host（含端口）维度隔离 Cookie。"""
    return url.split("/")[2].lower()


def refresh_cookie_via_browser(url: str) -> str:
    """412 后调用 fetch-invoice.js 采集新 Cookie（复用已验证的自愈路径）。"""
    if not SCRIPT.exists():
        print("[warn] 同目录下未找到 fetch-invoice.js，无法自动采集")
        return ""
    print("  ↻ 收到 412，正在自动重新采集 Cookie ...")
    try:
        proc = subprocess.run(
            ["node", str(SCRIPT), "--cookie-only", url],
            capture_output=True, text=True, timeout=HEAL_TIMEOUT, cwd=str(BASE_DIR),
        )
    except subprocess.TimeoutExpired:
        print(f"  ✗ 自动采集超时（{HEAL_TIMEOUT}s）")
        return ""
    except Exception as e:
        print(f"  ✗ 自动采集失败: {e}")
        return ""

    m = re.search(r"^Cookie:\s*(.+)$", proc.stdout, re.M)
    if not m:
        detail = (proc.stderr or "").strip().splitlines()[-1:] or ["无输出"]
        print(f"  ✗ 自动采集失败: {detail[0]}")
        return ""

    cookie = m.group(1).strip()
    print(f"  ↻ 已获取新 Cookie ({len(cookie)} 字符)")
    return cookie


def is_pdf(resp: httpx.Response) -> bool:
    return resp.content[:5] == b"%PDF-"


def do_get(client: httpx.Client, url: str, cookie: str = "") -> httpx.Response:
    headers = {
        "User-Agent": os.environ.get("WAF_UA", DEFAULT_UA),
        "Accept": "application/pdf,application/octet-stream,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": origin_of(url) + "/",
    }
    if cookie:
        headers["Cookie"] = cookie
    return client.get(url, headers=headers)


# --------------------------------------------------------------------------
# 核心抓取流程
# --------------------------------------------------------------------------
class FetchResult:
    def __init__(self, resp, steps, cookie_len=0, domain=""):
        self.resp = resp
        self.steps = steps
        self.cookie_len = cookie_len
        self.domain = domain


def fetch(url: str, client: Optional[httpx.Client] = None) -> FetchResult:
    """先直接 GET → 412 则用该域名缓存的 Cookie → 仍 412 则现场采集一次。

    重试上限固定为「一次缓存 + 一次新采集」，**不做无限重试**：
    拿到新 Cookie 后若仍是 412，直接返回失败，避免死循环。
    """
    owned = client is None
    client = client or httpx.Client(timeout=60.0, follow_redirects=True)
    steps = []
    domain = domain_of(url)
    try:
        # ①  先直接 GET（不带 Cookie）
        r = do_get(client, url)
        steps.append({"step": "direct", "status": r.status_code})
        if r.status_code != 412:
            return FetchResult(r, steps, domain=domain)

        # ②  412 → 试该域名已缓存的 Cookie
        cached = get_cached_cookie(domain)
        if cached:
            r2 = do_get(client, url, cached)
            steps.append({"step": "cached_cookie", "status": r2.status_code})
            if r2.status_code != 412:
                return FetchResult(r2, steps, len(cached), domain)
            # 缓存已失效，丢弃，避免下次又拿它去试
            drop_cached_cookie(domain)

        # ③  仍 412 → 现场采集一次新 Cookie → 重放（最后一次尝试）
        #     同域名并发请求串行化，避免同时起多个 Chromium
        with domain_lock(domain):
            fresh = refresh_cookie_via_browser(url)
            if not fresh:
                return FetchResult(r, steps, domain=domain)
            set_cached_cookie(domain, fresh)

            r3 = do_get(client, url, fresh)
            steps.append({"step": "healed", "status": r3.status_code})

        if r3.status_code == 412:
            # 新 Cookie 仍然 412 —— 到此为止，不再重试
            drop_cached_cookie(domain)
            steps.append({"step": "give_up", "status": r3.status_code,
                          "reason": "新采集的 Cookie 仍被拒（412），已停止重试"})
            return FetchResult(r3, steps, len(fresh), domain)

        return FetchResult(r3, steps, len(fresh), domain)
    finally:
        if owned:
            client.close()


# --------------------------------------------------------------------------
# 接口
# --------------------------------------------------------------------------
class FetchReq(BaseModel):
    url: str = Field(..., description="目标发票 URL")


@app.get("/")
def index():
    return {
        "service": "waf-bypass-api",
        "strategy": "先直接 GET；412 则试该域名缓存的 Cookie；仍 412 则现场采集一次新 Cookie 重放（最多一次，不死循环）",
        "collection": "随用随取，不做定时预采集（避免周期性请求被服务端识别为爬虫而加黑）",
        "persistence": "不落盘：PDF 仅在内存中返回，Cookie 按域名缓存在进程内存",
        "endpoints": {
            "GET /fetch?url=...": "抓取并直接返回 PDF 流（不落盘）",
            "POST /fetch": "JSON 入参 {url}",
            "GET /check?url=...": "只探测状态，不返回文件内容",
            "GET /health": "健康检查",
            "GET /cache": "查看各域名的 Cookie 缓存状态",
            "DELETE /cache": "清空全部 Cookie 缓存",
            "DELETE /cache?domain=...": "清除指定域名的 Cookie 缓存",
        },
    }


@app.get("/health")
def health():
    with _cache_lock:
        cached_domains = list(_domain_cache.keys())
    return {
        "ok": True,
        "script": str(SCRIPT),
        "script_exists": SCRIPT.exists(),
        "cached_domains": cached_domains,
        "disk_write": False,
    }


@app.get("/cache")
def cache_status():
    with _cache_lock:
        items = {
            d: {
                "cookie_len": len(e["cookie"]),
                "age_seconds": round(time.time() - e["at"], 1),
                "at": e["at"],
            }
            for d, e in _domain_cache.items()
        }
    return {"count": len(items), "domains": items}


@app.delete("/cache")
def cache_clear(domain: Optional[str] = Query(None, description="留空则清空全部")):
    if domain:
        drop_cached_cookie(domain.lower())
        with _cache_lock:
            remaining = list(_domain_cache.keys())
        return {"cleared": domain.lower(), "remaining": remaining}
    with _cache_lock:
        _domain_cache.clear()
    return {"cleared": "*", "remaining": []}


@app.get("/check")
def check(url: str = Query(..., description="目标 URL")):
    try:
        res = fetch(url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"请求失败: {e}")
    return {
        "url": url,
        "domain": res.domain,
        "status": res.resp.status_code,
        "content_type": res.resp.headers.get("content-type"),
        "length": len(res.resp.content),
        "is_pdf": is_pdf(res.resp),
        "steps": res.steps,
    }


@app.get("/fetch")
def fetch_get(url: str = Query(..., description="目标 URL")):
    try:
        res = fetch(url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"请求失败: {e}")

    if res.resp.status_code != 200 or not is_pdf(res.resp):
        return JSONResponse(
            status_code=res.resp.status_code if res.resp.status_code >= 400 else 502,
            content={
                "ok": False,
                "status": res.resp.status_code,
                "domain": res.domain,
                "content_type": res.resp.headers.get("content-type"),
                "length": len(res.resp.content),
                "steps": res.steps,
                "hint": "目标未返回 PDF（挑战未通过或 URL 失效）",
            },
        )

    body = res.resp.content
    headers = {
        "X-Waf-Steps": str(res.steps),
        "X-Waf-Status": str(res.resp.status_code),
        "X-Waf-Domain": res.domain,
        "Content-Length": str(len(body)),
    }
    # 仅在内存中流式返回，不写磁盘
    return StreamingResponse(
        iter([body]),
        media_type="application/pdf",
        headers=headers,
    )


@app.post("/fetch")
def fetch_post(req: FetchReq):
    try:
        res = fetch(req.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"请求失败: {e}")

    ok = res.resp.status_code == 200 and is_pdf(res.resp)
    out = {
        "ok": ok,
        "status": res.resp.status_code,
        "domain": res.domain,
        "content_type": res.resp.headers.get("content-type"),
        "length": len(res.resp.content),
        "steps": res.steps,
        "persisted": False,
    }
    if not ok:
        out["hint"] = "目标未返回 PDF（挑战未通过或 URL 失效）"
    return out


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
