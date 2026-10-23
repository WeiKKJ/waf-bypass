#!/usr/bin/env python3
"""
镜像敏感信息扫描 —— 推送/导出前必跑。

检查每个镜像的 config（ENV / CMD / Entrypoint）与文件层里是否含：
  - 真实目标 URL（含发票号参数 Fphm= / Jym= 等）
  - 瑞数挑战 Cookie（gizqLgxJ4gkhO / lzkqow39189 / DTSwUOYx7MiWN 等）
  - 硬编码的 .env 配置

用法：
  python tools/scan_image_secrets.py waf-api:latest waf-selfheal:latest waf-http:latest
  python tools/scan_image_secrets.py --all          # 扫描所有 waf-* 镜像

退出码：0 = 干净；1 = 发现泄露
"""
import argparse
import json
import re
import subprocess
import sys

# 真实发票 URL 的特征参数（税务系统导出接口）
URL_SIGNATURES = [
    "exportDzfpwjEwm",      # 发票导出接口路径
    "Fphm=",                # 发票号码参数
    "Jym=",                 # 校验码参数
    "Czsj=",                # 操作时间参数
    "Kprq=",                # 开票日期参数
]

# 瑞数挑战 Cookie 名
COOKIE_SIGNATURES = [
    "gizqLgxJ4gkhO",
    "gizqLgxJ4gkhP",
    "lzkqow39189",
    "lzkqow38189",
    "DTSwUOYx7MiWN",
    "MKls83gqduGS",
]

# 敏感配置项（值里含真实 URL 时命中）
ENV_KEYS = ["TARGET_URL", "WAF_COOKIE", "COOKIE"]


def sh(args):
    p = subprocess.run(args, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def scan_config(image):
    """扫描镜像 config —— ENV / Cmd / Entrypoint / Labels"""
    rc, out, err = sh(["docker", "image", "inspect", image, "--format", "{{json .Config}}"])
    if rc != 0:
        return [f"无法 inspect: {err.strip()[:200]}"]
    try:
        cfg = json.loads(out)
    except json.JSONDecodeError as e:
        return [f"config 解析失败: {e}"]

    hits = []
    envs = cfg.get("Env") or []
    for e in envs:
        key, _, val = e.partition("=")
        for sig in URL_SIGNATURES:
            if sig in val:
                hits.append(f"ENV {key} 含目标 URL 特征 '{sig}'（值前 60 字符: {val[:60]}...）")
        for sig in COOKIE_SIGNATURES:
            if sig in val:
                hits.append(f"ENV {key} 含瑞数 Cookie 名 '{sig}'")
        if key in ENV_KEYS and val.strip():
            hits.append(f"ENV {key} 被固化进镜像（应改为运行时传入）")

    for field in ("Cmd", "Entrypoint"):
        s = json.dumps(cfg.get(field) or [], ensure_ascii=False)
        for sig in URL_SIGNATURES + COOKIE_SIGNATURES:
            if sig in s:
                hits.append(f"{field} 含 '{sig}'")

    return hits


def scan_layers(image):
    """扫描镜像内文件 —— 查 waf_cookie.txt 之类的凭据文件"""
    hits = []
    # 注意：命令通过 subprocess 传参，不经过 shell。
    # 容器内 /bin/sh 可能是 dash，语法与 bash 不同 —— find 的括号组需用
    # 反斜杠转义（dash 也接受），且不能用 bash 专属的 [[ ]] 等语法。
    find_cmd = (
        r"find / -xdev -type f \( -name 'waf_cookie.txt' -o -name '.env' "
        r"-o -name '*.cookie' \) 2>/dev/null"
    )
    rc, out, _ = sh(["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", find_cmd])
    # 注意：find 即使找到结果也可能返回非 0（如 /proc 下的权限错误），
    # 因此不能拿 rc 判断成败，只要 stdout 有内容就继续分析。
    if not out.strip():
        return hits
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        hits.append(f"镜像内存在敏感文件: {line}")
        # 若文件里有 Cookie 或 URL，一并报出
        rc2, out2, _ = sh(["docker", "run", "--rm", "--entrypoint", "sh", image,
                            "-c", f"head -c 400 '{line}' 2>/dev/null"])
        for sig in URL_SIGNATURES + COOKIE_SIGNATURES:
            if sig in out2:
                hits.append(f"  └─ 该文件内容含 '{sig}'")
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="*")
    ap.add_argument("--all", action="store_true", help="扫描所有 waf-* 镜像")
    args = ap.parse_args()

    images = list(args.images)
    if args.all:
        rc, out, _ = sh(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"])
        images += [l for l in out.splitlines()
                   if l.startswith("waf-") or ":waf-" in l or "/waf-" in l]
    if not images:
        print("请指定镜像名，或用 --all")
        return 1

    print("扫描敏感信息...")
    print("=" * 60)
    bad = 0
    for img in dict.fromkeys(images):
        hits = scan_config(img) + scan_layers(img)
        if hits:
            bad += 1
            print(f"✗ {img}")
            for h in hits:
                print(f"    {h}")
        else:
            print(f"✓ {img}  干净")
    print("=" * 60)
    if bad:
        print(f"发现 {bad} 个镜像存在敏感信息泄露，禁止推送/导出！")
        return 1
    print("全部镜像干净，可以推送。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
