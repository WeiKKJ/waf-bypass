#!/usr/bin/env python3
"""跨仓库挂载 blob（Docker Hub cross-repository mount）"""
import argparse, base64, json, sys, urllib.request, urllib.error

REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token"


def http(method, url, headers=None, data=None, timeout=300):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is None and method in ("PUT", "POST", "PATCH"):
        req.add_header("Content-Length", "0")
        req.data = b""
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def get_token(repo, pat, user="weikkj", extra_scopes=()):
    scope = f"repository:{repo}:pull,push"
    for s in extra_scopes:
        scope += f" repository:{s}:pull"
    scope = scope.replace(" ", "%20")
    cred = base64.b64encode(f"{user}:{pat}".encode()).decode()
    st, _, body = http("GET", f"{AUTH}?service=registry.docker.io&scope={scope}",
                       headers={"Authorization": f"Basic {cred}"})
    if st != 200:
        raise RuntimeError(f"token HTTP {st}: {body[:300]}")
    return json.loads(body)["token"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="目标仓库")
    ap.add_argument("--from", dest="src", required=True, help="源仓库")
    ap.add_argument("--digest", required=True)
    ap.add_argument("--pat", required=True)
    args = ap.parse_args()

    token = get_token(args.repo, args.pat, extra_scopes=[args.src])
    url = (f"{REGISTRY}/v2/{args.repo}/blobs/uploads/"
           f"?mount={args.digest}&from={args.src}")
    st, hdrs, body = http("POST", url, headers={"Authorization": f"Bearer {token}"})
    print(f"POST mount -> HTTP {st}")
    if st == 201:
        loc = hdrs.get("Location") or hdrs.get("Docker-Content-Digest")
        print(f"  ✓ 挂载成功: {loc}")
        return 0
    print(f"  body: {body[:400]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
