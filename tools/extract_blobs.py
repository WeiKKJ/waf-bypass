#!/usr/bin/env python3
"""
从 OCI tar 导出层 blob 到本地目录，供 push_layer.py 上传。

用法：
  python extract_blobs.py <oci-tar> <输出目录>

只导出 manifest 里实际引用到的层（跳过未被引用的多余 blob），
文件名格式 blob_<digest>，与 push_layer.py --blob 对应。
"""
import json
import os
import sys
import tarfile

DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
INDEX_TYPES = {
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
}


def main():
    if len(sys.argv) < 3:
        print("用法: python extract_blobs.py <oci-tar> <输出目录>", file=sys.stderr)
        return 1
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    tf = tarfile.open(src)

    def read_json(name):
        f = tf.extractfile(name)
        return json.loads(f.read()) if f else None

    def blob_path(digest):
        return "blobs/sha256/" + digest.split(":")[-1]

    def walk_manifest(digest, want):
        """递归展开 manifest/index，收集 layers 与 config 的 digest"""
        md = read_json(blob_path(digest))
        if not md:
            return
        if "config" in md and "layers" in md:
            want.add(md["config"]["digest"])
            for l in md["layers"]:
                want.add(l["digest"])
            return
        for sub in md.get("manifests", []):
            if "attestation" in str(sub.get("annotations", {})):
                continue
            plat = sub.get("platform")
            if plat and plat.get("architecture") not in (None, "amd64"):
                continue
            walk_manifest(sub["digest"], want)

    # 收集全部被引用的 digest
    want = set()
    idx = read_json("index.json")
    for entry in idx.get("manifests", []):
        walk_manifest(entry["digest"], want)
    print(f"共需导出 {len(want)} 个 blob")

    # 逐个导出
    exported = 0
    for digest in sorted(want):
        name = blob_path(digest)
        try:
            f = tf.extractfile(name)
        except KeyError:
            print(f"  ✗ 缺失 {name}")
            continue
        if f is None:
            print(f"  ✗ 缺失 {name}")
            continue
        data = f.read()
        out = os.path.join(outdir, "blob_" + digest.split(":")[-1])
        with open(out, "wb") as w:
            w.write(data)
        exported += 1
        print(f"  ✓ {digest[:24]}  {len(data):>12,} B")

    print(f"\n已导出 {exported}/{len(want)} 个 blob 到 {outdir}")
    return 0 if exported == len(want) else 1


if __name__ == "__main__":
    sys.exit(main())
