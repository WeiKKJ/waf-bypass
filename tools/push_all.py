#!/usr/bin/env python3
"""
一键推送镜像到 Docker Hub（层上传 + 跨仓库 mount + manifest 提交）。

用法：
  python push_all.py --manifests <manifest目录> --blobs <blob目录> --pat <PAT>

流程（每个 repo 独立）：
  1. HEAD 检查每个层，已存在则跳过（Docker Hub 全局去重，重复推送极快）
  2. 缺失的层用 4MB 分块上传（绕开代理长连接断链）
  3. 跨仓库共享层用 mount API 挂载
  4. 提交 manifest（提交前再校验一次层齐全）
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token"
CHUNK_SIZE = 4 * 1024 * 1024


def http(method, url, headers=None, data=None, timeout=300):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is None and method in ("PUT", "POST", "PATCH", "DELETE"):
        req.add_header("Content-Length", "0")
        req.data = b""
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def get_token(repo, pat, extra_pull=()):
    scope = f"repository:{repo}:pull,push"
    for s in extra_pull:
        scope += f" repository:{s}:pull"
    scope = scope.replace(" ", "%20")
    cred = base64.b64encode(f"weikkj:{pat}".encode()).decode()
    st, _, body = http("GET", f"{AUTH}?service=registry.docker.io&scope={scope}",
                       headers={"Authorization": f"Basic {cred}"})
    if st != 200:
        raise RuntimeError(f"取 token 失败 HTTP {st}: {body[:200]}")
    return json.loads(body)["token"]


def get_header(headers, name):
    """大小写不敏感地取响应头。
    HTTP/2 会把头名小写化（location 而非 Location），
    dict(r.headers) 的键不保证大小写，直接取会拿到 None。"""
    if not headers:
        return None
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return None


def abs_url(loc):
    """Location 可能是相对路径（/v2/...），补全成绝对 URL"""
    if not loc:
        return None
    if loc.startswith("http://") or loc.startswith("https://"):
        return loc
    return REGISTRY + (loc if loc.startswith("/") else "/" + loc)


def head_blob(repo, digest, token):
    st, _, _ = http("HEAD", f"{REGISTRY}/v2/{repo}/blobs/{digest}",
                    headers={"Authorization": f"Bearer {token}"})
    return st == 200


def upload_blob(repo, path, digest, pat):
    """分块上传单个 blob"""
    token = get_token(repo, pat)
    st, hdrs, body = http("POST", f"{REGISTRY}/v2/{repo}/blobs/uploads/",
                           headers={"Authorization": f"Bearer {token}"})
    if st != 202:
        raise RuntimeError(f"发起上传失败 HTTP {st}: {body[:200]}")
    location = abs_url(get_header(hdrs, "Location"))
    token_issued = time.time()

    total = os.path.getsize(path)
    offset = 0
    with open(path, "rb") as f:
        while offset < total:
            if time.time() - token_issued > 200:
                token = get_token(repo, pat)
                token_issued = time.time()
            chunk = f.read(CHUNK_SIZE)
            end = offset + len(chunk) - 1
            st, hdrs, body = http(
                "PATCH", location,
                data=chunk,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/octet-stream",
                    "Content-Range": f"{offset}-{end}",
                    "Content-Length": str(len(chunk)),
                },
            )
            if st == 401:
                token = get_token(repo, pat)
                token_issued = time.time()
                st, hdrs, body = http(
                    "PATCH", location, data=chunk,
                    headers={"Authorization": f"Bearer {token}",
                             "Content-Type": "application/octet-stream",
                             "Content-Range": f"{offset}-{end}",
                             "Content-Length": str(len(chunk))})
            if st != 202:
                raise RuntimeError(f"PATCH 失败 HTTP {st} @offset {offset}: {body[:200]}")
            location = abs_url(get_header(hdrs, "Location")) or location
            offset = end + 1
            pct = offset * 100 // total
            print(f"    {pct:3d}%  {offset:,}/{total:,}", end="\r")

    # 提交 digest —— 必须保留 Location 的完整查询串（含 _state 游标）
    final = location + ("&" if "?" in location else "?") + f"digest={digest}"
    st, hdrs, body = http("PUT", final,
                           headers={"Authorization": f"Bearer {token}",
                                    "Content-Length": "0"})
    if st not in (201, 202):
        raise RuntimeError(f"提交失败 HTTP {st}: {body[:300]}")
    return total


def mount_from(repo, digest, src_repo, pat):
    """跨仓库挂载共享层"""
    token = get_token(repo, pat, extra_pull=[src_repo])
    st, hdrs, body = http(
        "POST",
        f"{REGISTRY}/v2/{repo}/blobs/uploads/?mount={digest}&from={src_repo}",
        headers={"Authorization": f"Bearer {token}"})
    return st == 201, st


def push_repo(repo, manifest_path, blobs_dir, pat, primary_repo=None):
    print(f"=== {repo} ===")
    mf = json.load(open(manifest_path, "rb"))
    token = get_token(repo, pat)

    # 1. 检查层
    missing = []
    for l in mf["layers"]:
        if not head_blob(repo, l["digest"], token):
            missing.append(l)
    if not head_blob(repo, mf["config"]["digest"], token):
        missing.insert(0, {"digest": mf["config"]["digest"],
                            "size": mf["config"]["size"], "_is_config": True})
    print(f"  层 {len(mf['layers'])} 个，需上传 {len(missing)} 个")

    # 2. 上传缺失层
    for l in missing:
        dg = l["digest"]
        path = os.path.join(blobs_dir, "blob_" + dg.split(":")[-1])
        if not os.path.exists(path):
            print(f"  ✗ 本地缺 blob: {dg[:24]}")
            return False
        # 跨仓库 mount 尝试
        if primary_repo and primary_repo != repo and not l.get("_is_config"):
            ok, st = mount_from(repo, dg, primary_repo, pat)
            if ok:
                print(f"    ✓ mount 自 {primary_repo}: {dg[:20]}")
                continue
        print(f"    ↑ 上传 {dg[:20]}  {l['size']:,} B")
        t0 = time.time()
        n = upload_blob(repo, path, dg, pat)
        print(f"    ✓ 完成 {dg[:20]}  {n:,} B  耗时 {time.time()-t0:.0f}s")

    # 3. 提交 manifest
    token = get_token(repo, pat)
    still = [l["digest"] for l in mf["layers"]
             if not head_blob(repo, l["digest"], token)]
    if still:
        print(f"  ✗ 层仍缺失: {[d[:20] for d in still]}")
        return False
    payload = json.dumps(mf).encode("utf-8")
    st, _, body = http(
        "PUT", f"{REGISTRY}/v2/{repo}/manifests/latest", data=payload,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": mf.get("mediaType",
                                        "application/vnd.docker.distribution.manifest.v2+json"),
                 "Content-Length": str(len(payload))})
    if st not in (201, 202):
        print(f"  ✗ 提交 manifest 失败 HTTP {st}: {body[:300]}")
        return False
    print(f"  ✓ manifest 已提交: {repo}:latest")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifests", required=True)
    ap.add_argument("--blobs", required=True)
    ap.add_argument("--pat", required=True)
    ap.add_argument("--repos", nargs="+", required=True)
    ap.add_argument("--primary", help="跨仓库 mount 的源仓库（通常是第一个）")
    args = ap.parse_args()

    ok = True
    for repo in args.repos:
        fname = "docker.io_" + repo.replace("/", "_") + ".manifest.json"
        path = os.path.join(args.manifests, fname)
        if not os.path.exists(path):
            # 兼容不含 docker.io 前缀的命名
            alt = repo.replace("/", "_") + ".manifest.json"
            path = os.path.join(args.manifests, alt)
        if not os.path.exists(path):
            print(f"=== {repo} ===\n  ✗ 找不到 manifest: {fname}")
            ok = False
            continue
        ok &= push_repo(repo, path, args.blobs, args.pat, args.primary)
        print()

    print("=== 总结 ===")
    print("全部成功" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
