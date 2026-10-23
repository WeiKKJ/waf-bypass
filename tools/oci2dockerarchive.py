#!/usr/bin/env python3
"""
OCI layout tar  ->  传统 docker-archive tar 转换器

背景：
  Docker 25+ 的 `docker save` 默认输出 OCI layout（blobs/sha256/*），
  老版本 Docker（< 25.0）无法 `docker load` 这种格式。
  本脚本把 OCI layout 转成 docker-archive（manifest.json + <hash>/layer.tar），
  兼容 Docker 19.03 ~ 29.x 全系。

特性：
  - 层去重：多个镜像共享的层只写一份（与 docker save 行为一致）
  - 层内 gzip 解压：docker-archive 期望的是未压缩 tar
  - 保留 RepoTags，目标端 docker load 后镜像名不变
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile


def log(msg):
    print(f"  {msg}", flush=True)


def read_json(tf, name):
    return json.loads(tf.extractfile(name).read())


def collect(tf):
    """
    解析出 [{tags, config_blob, layers}]
    顶层 index.json 的 entry 可能指向：
      a) 另一个 index（带 annotations.io.containerd.image.name）—— 需再钻一层
      b) 直接的 image manifest（带 config + layers）
    按内容判断，不能只看字段名。
    """
    idx = read_json(tf, "index.json")
    resolved = []

    def blob_path(digest):
        return "blobs/sha256/" + digest.split(":")[1]

    def handle_manifest(digest, tag_hint):
        md = read_json(tf, blob_path(digest))
        if "config" in md and "layers" in md:
            # 真实 image manifest
            cfg = read_json(tf, blob_path(md["config"]["digest"]))
            tags = cfg.get("RepoTags") or ([tag_hint] if tag_hint else [])
            resolved.append(
                {
                    "tags": tags,
                    "config_blob": blob_path(md["config"]["digest"]),
                    "layers": [blob_path(l["digest"]) for l in md["layers"]],
                }
            )
        else:
            # 还是个 index，继续往下钻
            for sub in md.get("manifests", []):
                ann = sub.get("annotations", {})
                if "attestation" in str(ann):
                    continue  # 跳过 SBOM / attestation 附件
                plat = sub.get("platform")
                if plat and plat.get("architecture") not in (None, "amd64"):
                    continue
                handle_manifest(sub["digest"], tag_hint)

    for entry in idx.get("manifests", []):
        ann = entry.get("annotations", {})
        tag_hint = ann.get("io.containerd.image.name", "")
        handle_manifest(entry["digest"], tag_hint)

    return resolved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="OCI layout tar")
    ap.add_argument("dst", help="输出 docker-archive tar")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        print(f"源文件不存在: {args.src}", file=sys.stderr)
        return 1

    print(f"读取源: {args.src}")
    tf = tarfile.open(args.src, "r")
    images = collect(tf)

    total_layers = sum(len(i["layers"]) for i in images)
    unique_layers = set()
    for i in images:
        unique_layers.update(i["layers"])

    print(f"  镜像 {len(images)} 个，层引用 {total_layers} 个，去重后 {len(unique_layers)} 个")

    tmpdir = tempfile.mkdtemp(prefix="oci2dock_")
    try:
        # ---- 1. 展开所有需要的 blob 到临时目录，解压层 ----
        log("展开 blob ...")
        layer_dirs = {}   # blob_name -> 目录名（docker-archive 用 diff_id 作为目录名）
        blob_dir = os.path.join(tmpdir, "blobs")
        for name in tf.getnames():
            if name.startswith("blobs/sha256/") and "/" not in name[len("blobs/sha256/"):]:
                dest = os.path.join(blob_dir, "sha256", os.path.basename(name))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with tf.extractfile(name) as fin, open(dest, "wb") as fout:
                    shutil.copyfileobj(fin, fout, length=4 * 1024 * 1024)

        # ---- 2. 处理层：gzip -> tar，目录名用 diff_id ----
        log("解压并去重层 ...")
        for i in images:
            new_layers = []
            for blob in i["layers"]:
                bpath = os.path.join(blob_dir, "sha256", os.path.basename(blob))
                # diff_id = 解压后 tar 的 sha256
                h = hashlib.sha256()
                with gzip.open(bpath, "rb") as fin:
                    while True:
                        chunk = fin.read(4 * 1024 * 1024)
                        if not chunk:
                            break
                        h.update(chunk)
                diff_id = h.hexdigest()
                ldir = os.path.join(tmpdir, diff_id)
                if not os.path.exists(ldir):
                    os.makedirs(ldir, exist_ok=True)
                    with gzip.open(bpath, "rb") as fin, open(os.path.join(ldir, "layer.tar"), "wb") as fout:
                        shutil.copyfileobj(fin, fout, length=4 * 1024 * 1024)
                layer_dirs[blob] = diff_id
                new_layers.append(diff_id + "/layer.tar")
            i["new_layers"] = new_layers

        # ---- 3. 处理 config ----
        log("处理 config ...")
        manifest_entries = []
        for i in images:
            cpath = os.path.join(blob_dir, "sha256", os.path.basename(i["config_blob"]))
            cfg = json.load(open(cpath, "r", encoding="utf-8"))
            # docker-archive 的 config 里 rootfs.diff_ids 需与实际层对应
            # OCI config 已有 diff_ids，保持不变即可
            cfg_hash = hashlib.sha256(open(cpath, "rb").read()).hexdigest()
            cfg_name = cfg_hash + ".json"
            cfg_dir = os.path.join(tmpdir, cfg_hash)
            os.makedirs(cfg_dir, exist_ok=True)
            shutil.copyfile(cpath, os.path.join(cfg_dir, "config.json"))
            manifest_entries.append(
                {
                    "Config": cfg_hash + ".json",
                    "RepoTags": i["tags"],
                    "Layers": i["new_layers"],
                }
            )

        # ---- 4. 写出 manifest.json ----
        log("生成 manifest.json ...")
        mpath = os.path.join(tmpdir, "manifest.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest_entries, f)

        # ---- 5. 打包 ----
        log(f"打包 -> {args.dst}")
        with tarfile.open(args.dst, "w") as out:
            out.add(mpath, arcname="manifest.json")
            for e in manifest_entries:
                # config 必须放在 tar 根目录，文件名 = <sha256>.json
                cid = e["Config"].replace(".json", "")
                out.add(
                    os.path.join(tmpdir, cid, "config.json"),
                    arcname=e["Config"],
                )
                for l in e["Layers"]:
                    lid = l.split("/")[0]
                    out.add(
                        os.path.join(tmpdir, lid, "layer.tar"),
                        arcname=l,
                    )
        log("完成")
    finally:
        tf.close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
