#!/usr/bin/env python3
"""
瑞数 WAF —— 纯 HTTP 发票下载（Python 版）

零浏览器依赖，只需 requests + 一个有效 Cookie。
配合 Node 版取 Cookie：
    node fetch-invoice.js --cookie-only "<URL>" > waf_cookie.txt

环境变量：
    WAF_COOKIE   直接内联 Cookie 字符串
    WAF_UA       自定义 User-Agent

用法：
    python http_client.py "<URL>" [输出.pdf]
    python http_client.py "<URL>" --check
    python http_client.py --url-from-file list.txt
"""

import os
import re
import subprocess
import sys
import time
import requests

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")

HINT = """未找到有效 Cookie。

先取一次 Cookie（需要浏览器执行挑战 JS）：
    node fetch-invoice.js --cookie-only "<URL>"

然后设置环境变量：
    WAF_COOKIE="<整行 Cookie>" python http_client.py "<URL>"
或写入同目录 waf_cookie.txt
"""


def load_cookie() -> str:
    c = os.environ.get("WAF_COOKIE")
    if c:
        return c.strip()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "waf_cookie.txt")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    sys.exit(HINT)


def download(session: requests.Session, url: str, out: str | None) -> bytes:
    origin = f"{url.split('/')[0]}//{url.split('/')[2]}"
    r = session.get(url, headers={
        "Accept": "application/pdf,application/octet-stream,*/*",
        "Referer": origin + "/",
    }, timeout=60)

    if r.status_code in (400, 412):
        raise RuntimeError(f"HTTP {r.status_code} —— Cookie 无效或已过期，请重取")
    r.raise_for_status()

    body = r.content
    if not body.startswith(b"%PDF-"):
        raise RuntimeError(f"不是 PDF（{r.headers.get('Content-Type')}，{len(body)} 字节）")

    if out:
        with open(out, "wb") as f:
            f.write(body)
        print(f"  ✓ {out}  {len(body)} 字节")
    return body


def refresh_cookie_via_browser(url: str) -> str:
    """412 后自动调用 fetch-invoice.js 重新采集 Cookie。

    与 Node 版 http-client.js 行为一致：瑞数 Cookie 有效期仅 1~3 分钟，
    独立维护 Cookie 不可靠，必须能在失效时立即自愈。
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fetch-invoice.js")
    if not os.path.exists(script):
        print("  ✗ 同目录下未找到 fetch-invoice.js，无法自动采集")
        return ""

    print("  ↻ 收到 412，正在自动重新采集 Cookie ...")
    try:
        r = subprocess.run(
            ["node", script, "--cookie-only", url],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:
        print(f"  ✗ 自动采集失败: {e}")
        return ""

    m = re.search(r"^Cookie:\s*(.+)$", r.stdout, re.M)
    if not m:
        detail = (r.stderr or "").strip().splitlines()[-1:] or ["无输出"]
        print(f"  ✗ 自动采集失败: {detail[0]}")
        return ""

    cookie = m.group(1).strip()
    print(f"  ↻ 已获取新 Cookie ({len(cookie)} 字符)")
    return cookie


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    list_file = None
    if "--url-from-file" in sys.argv:
        list_file = sys.argv[sys.argv.index("--url-from-file") + 1]
        args = [a for a in args if a != list_file]
    check_only = "--check" in sys.argv

    # 用 list 包裹，便于在闭包中替换 Cookie（str 不可变）
    cookie = [load_cookie()]
    ua = os.environ.get("WAF_UA", DEFAULT_UA)
    print(f"[Cookie] {len(cookie[0])} 字符")
    s = requests.Session()
    s.headers.update({"User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9"})

    def do(url: str, out: str | None, depth: int = 0) -> int:
        origin = f"{url.split('/')[0]}//{url.split('/')[2]}"
        r = s.get(url, headers={
            "Cookie": cookie[0],
            "Accept": "application/pdf,application/octet-stream,*/*",
            "Referer": origin + "/",
        }, timeout=60)
        if r.status_code in (400, 412):
            if depth == 0:
                fresh = refresh_cookie_via_browser(url)
                if fresh:
                    cookie[0] = fresh
                    return do(url, out, depth + 1)
            print(f"  ✗ HTTP {r.status_code} Cookie 过期")
            return 0
        r.raise_for_status()
        if not r.content.startswith(b"%PDF-"):
            print(f"  ✗ 非 PDF 响应 {len(r.content)} 字节")
            return 0
        if out:
            with open(out, "wb") as f:
                f.write(r.content)
        print(f"  ✓ {out or '(check)'}  {len(r.content)} 字节")
        return 1

    if list_file:
        with open(list_file, encoding="utf-8") as f:
            urls = [ln.strip() for ln in f if ln.strip()]
        print(f"批量模式：{len(urls)} 条\n")
        ok = 0
        for i, u in enumerate(urls, 1):
            out = None if check_only else f"out_{i:03d}.pdf"
            if not do(u, out):
                print(f"  （第 {i} 条失败，后续必然同样失败，已中止）")
                break
            ok += 1
            time.sleep(0.3)
        print(f"\n成功 {ok}/{len(urls)}")
        return

    if not args:
        print(__doc__)
        sys.exit(0)

    url = args[0]
    out = None if check_only else (args[1] if len(args) > 1 else "invoice.pdf")
    do(url, out)


if __name__ == "__main__":
    main()