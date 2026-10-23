#!/usr/bin/env python3
"""
Docker Registry v2 分块上传器（绕过代理对大文件的长连接超时）

背景：
  `docker push` 推送大层（如 602MB 的 Playwright 层）时，走代理的长连接
  会被中途断开，报 `broken pipe`。Docker Hub 的 Registry v2 协议支持
  **分块上传**（POST 开出会话 -> PATCH 逐块 -> PUT 提交 digest），
  每块一个独立连接，可稳定通过。

用法：
  python push_layer.py --repo weikkj/waf-api --blob <blob文件> --digest sha256:xxx

流程：
  1. 用 PAT 换 registry token
  2. HEAD 查 blob 是否已存在（存在则跳过）
  3. POST /v2/<repo>/blobs/uploads/ 开会话
  4. PATCH 分块上传，每块带 Content-Range
  5. PUT 提交最终 digest
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.request
import urllib.error

REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token"
CHUNK_SIZE = 4 * 1024 * 1024   # 4MB/块 —— 兼顾吞吐与单连接时长
NO_PROXY = True                 # 走直连，绕开代理的大文件断链问题


def http(method, url, headers=None, data=None, timeout=120):
    """返回 (status, headers, body)。不走系统代理。"""
    if NO_PROXY:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    else:
        opener = urllib.request.build_opener()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is None and method in ("PUT", "POST", "PATCH"):
        # urllib 在 data=None 时不发 Content-Length，registry 会返回 411
        req.add_header("Content-Length", "0")
        req.data = b""
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def get_token(repo, pat, user="weikkj"):
    scope = f"repository:{repo}:pull,push"
    cred = base64.b64encode(f"{user}:{pat}".encode()).decode()
    st, _, body = http("GET", f"{AUTH}?service=registry.docker.io&scope={scope}",
                       headers={"Authorization": f"Basic {cred}"})
    if st != 200:
        raise RuntimeError(f"取 token 失败 HTTP {st}: {body[:300]}")
    return json.loads(body)["token"]


def head_blob(repo, digest, token):
    st, _, _ = http("HEAD", f"{REGISTRY}/v2/{repo}/blobs/{digest}",
                     headers={"Authorization": f"Bearer {token}"})
    return st == 200


def resume_session(repo, upload_uuid, token):
    """
    重新挂上已有上传会话，读取服务端已接收的字节数。
    Docker Hub 的 upload session 由 uuid 标识，GET 该 URL 可拿到 Range 头。
    """
    url = f"{REGISTRY}/v2/{repo}/blobs/uploads/{upload_uuid}"
    st, hdrs, body = http("GET", url, headers={"Authorization": f"Bearer {token}"})
    if st not in (200, 204):
        return None, 0
    rng = hdrs.get("Range") or hdrs.get("range") or ""
    offset = 0
    if "-" in rng:
        try:
            offset = int(rng.split("-")[-1]) + 1
        except ValueError:
            offset = 0
    loc = hdrs.get("Location") or hdrs.get("location")
    if loc and not loc.startswith("http"):
        loc = REGISTRY + loc
    return loc, offset


def upload_blob(repo, path, digest, token, pat):
    """分块上传一个 blob。token 过期时自动续期。"""
    size = os.path.getsize(path)
    print(f"  文件大小: {size / 1024 / 1024:.1f} MB")
    print(f"  目标 digest: {digest}")

    # 1. 开会话
    st, hdrs, body = http("POST", f"{REGISTRY}/v2/{repo}/blobs/uploads/",
                           headers={"Authorization": f"Bearer {token}"})
    if st != 202:
        raise RuntimeError(f"开上传会话失败 HTTP {st}: {body[:300]}")
    location = hdrs.get("Location") or hdrs.get("location")
    if not location:
        raise RuntimeError("响应缺少 Location 头")
    if location.startswith("/"):
        location = REGISTRY + location
    # 从 Location 中取出 upload uuid，便于会话失效后恢复
    try:
        upload_uuid = location.split("/blobs/uploads/")[1].split("?")[0]
    except IndexError:
        upload_uuid = None
    print(f"  上传会话: {location[:90]}...")

    # 2. 分块 PATCH
    chunk_total = (size + CHUNK_SIZE - 1) // CHUNK_SIZE
    offset = 0
    idx = 0
    t0 = time.time()
    token_issued = time.time()

    with open(path, "rb") as f:
        while offset < size:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            idx += 1
            end = offset + len(chunk) - 1
            cr = f"{offset}-{end}"

            attempt = 0
            session_dead = False
            while True:
                attempt += 1
                # registry token 有效期 300 秒，长上传必须自动续期
                if time.time() - token_issued > 200:
                    token = get_token(repo, pat)
                    token_issued = time.time()
                    print(f"    · token 已续期")

                # 关键：PATCH 的 URL 就是 Location 原样，不能追加 chunk_start/chunk_end
                # （追加了会返回 404）。会话游标由服务端在响应的 range 头里维护。
                st, hdrs, body = http("PATCH", location, data=chunk, timeout=300,
                                      headers={
                                          "Authorization": f"Bearer {token}",
                                          "Content-Type": "application/octet-stream",
                                          "Content-Range": cr,
                                          "Content-Length": str(len(chunk)),
                                      })
                if st in (202, 204):
                    break
                if st == 401:
                    # token 过期或失效 —— 换新 token 后重试同一块
                    print(f"    ! 块 {idx} 认证失效，刷新 token 后重试")
                    token = get_token(repo, pat)
                    token_issued = time.time()
                    if attempt >= 5:
                        raise RuntimeError(f"分块 {idx} 认证反复失败")
                    time.sleep(2)
                    continue
                if st in (404, 400) and upload_uuid:
                    # 会话已失效 —— 尝试重新挂上并从服务端游标续传
                    print(f"    ! 块 {idx} 会话失效，尝试恢复 ...")
                    new_loc, srv_off = resume_session(repo, upload_uuid, token)
                    if new_loc and srv_off and srv_off <= offset + len(chunk):
                        location = new_loc
                        # 跳到服务端已接收的位置，重新读数据
                        f.seek(srv_off)
                        offset = srv_off
                        idx -= 1
                        session_dead = False
                        print(f"    · 已从 {srv_off / 1024 / 1024:.1f}MB 续传")
                        break
                    print(f"    · 会话无法恢复，重开会话")
                    st2, h2, b2 = http("POST", f"{REGISTRY}/v2/{repo}/blobs/uploads/",
                                       headers={"Authorization": f"Bearer {token}"})
                    if st2 == 202:
                        location = h2.get("Location") or h2.get("location")
                        if location.startswith("/"):
                            location = REGISTRY + location
                        try:
                            upload_uuid = location.split("/blobs/uploads/")[1].split("?")[0]
                        except IndexError:
                            upload_uuid = None
                        f.seek(0)
                        offset = 0
                        idx = 0
                        print(f"    · 已重开会话，从头开始")
                        break
                    raise RuntimeError(f"分块 {idx} 失败 HTTP {st} 且无法重开会话")
                if attempt >= 5:
                    raise RuntimeError(f"分块 {idx} 上传失败 HTTP {st}: {body[:200]}")
                print(f"    ! 分块 {idx} 重试 ({attempt}) HTTP {st}")
                time.sleep(5)

            if session_dead:
                continue

            # 服务端返回新的 Location（携带新游标），后续 PATCH 必须用它
            new_loc = hdrs.get("Location") or hdrs.get("location")
            if new_loc:
                location = new_loc if new_loc.startswith("http") else REGISTRY + new_loc

            # 校验服务端确认的区间
            srv_range = hdrs.get("Range") or hdrs.get("range")
            if srv_range:
                try:
                    got = int(srv_range.split("-")[-1]) + 1
                    if got != offset + len(chunk):
                        print(f"    ! 服务端游标 {got} != 本地 {offset + len(chunk)}，"
                              f"以服务端为准")
                        offset = got
                except ValueError:
                    pass

            offset = end + 1
            pct = offset * 100 // size
            elapsed = time.time() - t0
            speed = offset / elapsed / 1024 / 1024 if elapsed > 0 else 0
            print(f"    块 {idx}/{chunk_total}  {pct:3d}%  "
                  f"{offset / 1024 / 1024:7.1f}MB  {speed:.2f} MB/s", flush=True)

    # 3. 提交 digest
    #    关键：必须保留 Location 的完整查询串（含 _state），否则报 "invalid secret"。
    #    只在末尾追加 &digest=...。
    final = location + ("&" if "?" in location else "?") + f"digest={digest}"
    st, _, body = http("PUT", final, timeout=300,
                       headers={"Authorization": f"Bearer {token}",
                                "Content-Length": "0"})
    if st not in (201, 202):
        raise RuntimeError(f"提交 digest 失败 HTTP {st}: {body[:300]}")
    print(f"  ✓ 上传完成，耗时 {time.time() - t0:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--blob", required=True)
    ap.add_argument("--digest", required=True)
    ap.add_argument("--pat", required=True)
    args = ap.parse_args()

    print(f"[{args.repo}] {args.digest[:24]}...")
    token = get_token(args.repo, args.pat)
    print("  ✓ 已获取 registry token")

    if head_blob(args.repo, args.digest, token):
        print("  ✓ 该层已存在于远端，跳过")
        return 0

    upload_blob(args.repo, args.blob, args.digest, token, args.pat)
    return 0


if __name__ == "__main__":
    sys.exit(main())
