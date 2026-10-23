#!/usr/bin/env python3
"""匿名校验远端镜像：拉 manifest -> 校验 config/层 blob 存在 -> 抽查层内容 sha256"""
import argparse, hashlib, json, sys, urllib.request, urllib.error

REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token"
MT = "application/vnd.docker.distribution.manifest.v2+json"


def http(method, url, headers=None, data=None, timeout=300):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is None and method in ("PUT", "POST", "PATCH"):
        req.add_header("Content-Length", "0")
        req.data = b""
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def anon_token(repo):
    st, _, body = http("GET", f"{AUTH}?service=registry.docker.io&scope=repository:{repo}:pull")
    if st != 200:
        raise RuntimeError(f"token HTTP {st}")
    return json.loads(body)["token"]


def check(repo, tag, sample):
    print(f"=== {repo}:{tag} ===")
    token = anon_token(repo)
    h = {"Authorization": f"Bearer {token}"}
    st, _, body = http("GET", f"{REGISTRY}/v2/{repo}/manifests/{tag}", headers={**h, "Accept": MT})
    if st != 200:
        print(f"  ✗ 拉取 manifest 失败 HTTP {st}")
        return False
    mf = json.loads(body)
    print(f"  ✓ manifest 可读, layers={len(mf['layers'])}, config={mf['config']['digest'][:20]}")

    ok = True
    targets = [(mf["config"]["digest"], "config")] + [(l["digest"], "layer") for l in mf["layers"]]
    for dg, kind in targets:
        st, _, _ = http("HEAD", f"{REGISTRY}/v2/{repo}/blobs/{dg}", headers=h)
        if st != 200:
            print(f"  ✗ {kind} {dg[:24]} HTTP {st}")
            ok = False
    if ok:
        print(f"  ✓ {len(targets)} 个 blob 全部存在")

    # 抽查内容哈希（只抽查能完整下载的小 blob）
    for l in mf["layers"]:
        if l["size"] > sample:
            continue
        st, _, data = http("GET", f"{REGISTRY}/v2/{repo}/blobs/{l['digest']}", headers=h)
        if st != 200:
            print(f"  ✗ 下载层失败 {l['digest'][:20]} HTTP {st}")
            ok = False
            continue
        calc = "sha256:" + hashlib.sha256(data).hexdigest()
        match = calc == l["digest"]
        print(f"  {'✓' if match else '✗'} 层内容校验 {l['digest'][:20]} ({l['size']} B) -> {'一致' if match else '不一致'}")
        if not match:
            ok = False
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repos", nargs="+", required=True)
    ap.add_argument("--tag", default="latest")
    ap.add_argument("--sample", type=int, default=2 * 1024 * 1024)
    args = ap.parse_args()
    allok = True
    for r in args.repos:
        allok &= check(r, args.tag, args.sample)
    print("\n=== 总结 ===")
    print("全部通过" if allok else "存在失败项")
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
