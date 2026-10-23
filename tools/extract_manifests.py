#!/usr/bin/env python3
"""
从 OCI layout tar 中提取各镜像的 Docker manifest v2 JSON（供 push_manifest.py 使用）

用法：
  python extract_manifests.py <oci-tar> <输出目录>
"""
import json
import os
import sys
import tarfile

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"


def main():
    if len(sys.argv) < 3:
        print("用法: python extract_manifests.py <oci-tar> <输出目录>", file=sys.stderr)
        return 1
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    tf = tarfile.open(src)

    def read_json(name):
        return json.loads(tf.extractfile(name).read())

    idx = read_json("index.json")
    results = []

    def dig(digest):
        return read_json("blobs/sha256/" + digest.split(":")[1])

    for entry in idx.get("manifests", []):
        name = entry.get("annotations", {}).get("io.containerd.image.name", "")
        repo = name.replace("docker.io/library/", "") if name else ""
        d = dig(entry["digest"])
        cands = [
            x for x in d.get("manifests", [])
            if "attestation" not in str(x.get("annotations", {}))
            and (x.get("platform") or {}).get("architecture") in (None, "amd64")
        ]
        if not cands:
            continue
        md = dig(cands[0]["digest"])

        # 统一转成 Docker manifest v2 结构（字段名相同，mediaType 改掉即可）
        layers = []
        for l in md["layers"]:
            layers.append({
                "mediaType": l["mediaType"],
                "size": l["size"],
                "digest": l["digest"],
            })
        mfv2 = {
            "schemaVersion": 2,
            "mediaType": DOCKER_MANIFEST,
            "config": md["config"],
            "layers": layers,
        }
        repo_name = repo.split(":")[0] if repo else "unknown"
        fname = os.path.join(outdir, f"{repo_name.replace('/', '_')}.manifest.json")
        with open(fname, "w", encoding="utf-8") as f:
            json.dump(mfv2, f, indent=2)
        results.append((repo, fname, len(layers)))
        print(f"  {repo:40s} layers={len(layers):2d}  -> {os.path.basename(fname)}")

    print(f"\n共提取 {len(results)} 个 manifest 到 {outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
