#!/usr/bin/env python3
"""
推送镜像 manifest 到 Docker Hub（配合 push_layer.py 使用）

用法：
  python push_manifest.py --repo weikkj/waf-api --manifest <manifest.json> --pat <PAT>

manifest.json 格式（Docker manifest v2）:
  {
    "schemaVersion": 2,
    "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
    "config": {"mediaType": "...config.v2+json", "size": N, "digest": "sha256:..."},
    "layers": [{"mediaType": "...layer.v1.tar+gzip", "size": N, "digest": "sha256:..."}, ...]
  }
"""
import argparse
import base64
import json
import sys
import urllib.request
import urllib.error

REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token"

MANIFEST_TYPES = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}


def http(method, url, headers=None, data=None, timeout=180):
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


def get_token(repo, pat, user="weikkj"):
    scope = f"repository:{repo}:pull,push"
    cred = base64.b64encode(f"{user}:{pat}".encode()).decode()
    st, _, body = http("GET", f"{AUTH}?service=registry.docker.io&scope={scope}",
                       headers={"Authorization": f"Basic {cred}"})
    if st != 200:
        raise RuntimeError(f"取 token 失败 HTTP {st}: {body[:300]}")
    return json.loads(body)["token"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--pat", required=True)
    ap.add_argument("--tag", default="latest")
    args = ap.parse_args()

    mf = json.load(open(args.manifest, "rb"))
    payload = json.dumps(mf).encode("utf-8")

    token = get_token(args.repo, args.pat)
    print(f"[{args.repo}:{args.tag}] 已获取 token")
    print(f"  config: {mf['config']['digest'][:24]}  ({mf['config']['size']} B)")
    print(f"  layers: {len(mf['layers'])}")

    # 先确认所有层都已存在，避免 manifest 引用不存在的 blob
    missing = []
    for l in mf["layers"]:
        st, _, _ = http("HEAD", f"{REGISTRY}/v2/{args.repo}/blobs/{l['digest']}",
                        headers={"Authorization": f"Bearer {token}"})
        if st != 200:
            missing.append((l["digest"], st))
    if missing:
        print("  ✗ 以下层尚未上传完成，无法提交 manifest：")
        for d, st in missing:
            print(f"      {d[:24]}  HTTP {st}")
        return 1
    print("  ✓ 所有层均已存在于远端")

    st, _, body = http(
        "PUT",
        f"{REGISTRY}/v2/{args.repo}/manifests/{args.tag}",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": mf.get("mediaType", "application/vnd.docker.distribution.manifest.v2+json"),
            "Content-Length": str(len(payload)),
        },
    )
    if st not in (201, 202):
        print(f"  ✗ 提交 manifest 失败 HTTP {st}: {body[:400]}")
        return 1
    print(f"  ✓ manifest 已提交: {args.repo}:{args.tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
