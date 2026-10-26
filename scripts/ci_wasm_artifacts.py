#!/usr/bin/env python3
"""Key and verify reusable native Wasm outputs; JavaScript is always rebuilt/tested."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


VARIANTS = ("base", "threads", "base-loadable", "threads-loadable")
BINDINGS = "packages/duckdb-wasm/src/bindings/"
EXTENSIONS = "build/extension_repository/"


def cache_key(root, variant, env):
    image = env["HAYBARN_WASM_CI_IMAGE"]
    if "@sha256:" not in image:
        raise ValueError("Wasm artifact caching requires a digest-pinned toolchain image")
    # Include every gitlink, native source, patch, script, CI definition and root
    # configuration file. In particular, the engine gitlink pins httpfs's revision
    # and the nanoarrow gitlink pins its transitive dependencies. Package JS/TS and
    # documentation edits can reuse these outputs; changing build logic cannot.
    tree = subprocess.check_output(["git", "ls-tree", "-rz", "HEAD"], cwd=root)
    entries = []
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        if (metadata.startswith(b"160000 ") or b"/" not in name
                or name.startswith((b"lib/", b"patches/", b"scripts/", b".github/"))):
            entries.append(entry.decode())
    settings = {name: env.get(name, "") for name in (
        "HAYBARN_WASM_CI_IMAGE", "OVERRIDE_GIT_DESCRIBE", "DUCKDB_WASM_VERSION",
        "DEFAULT_USE_GENERATED_EXPORTED_LIST", "EXTRA_CMAKE_FLAGS", "EXTRA_LINK_FLAGS",
        "CFLAGS", "CXXFLAGS", "LDFLAGS",
    )}
    payload = json.dumps([variant, settings, entries], sort_keys=True).encode()
    return f"wasm-artifacts-v1-{variant}-{hashlib.sha256(payload).hexdigest()}"


def required_files(variant):
    bundle = variant.split("-")[0]
    return {f"{BINDINGS}duckdb-{bundle}.{suffix}" for suffix in ("js", "wasm")}


def allowed_file(name, variant):
    bundle = variant.split("-")[0]
    return (name in required_files(variant)
            or (bundle == "threads" and name == f"{BINDINGS}duckdb-threads.pthread.js")
            or (variant.endswith("-loadable") and name.startswith(EXTENSIONS)))


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def validate_file_list(files, variant):
    if not required_files(variant).issubset(files):
        raise ValueError("Cached Wasm bundle is incomplete")
    if variant.endswith("-loadable") and not any(
            name.startswith(EXTENSIONS) and name.endswith(".wasm") for name in files):
        raise ValueError("Cached loadable bundle has no extension repository")
    for name in files:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or not allowed_file(name, variant):
            raise ValueError(f"Unexpected cache path: {name}")


def stage(root, cache, variant, key):
    files = set(required_files(variant))
    pthread = f"{BINDINGS}duckdb-threads.pthread.js"
    if variant.startswith("threads") and (root / pthread).is_file():
        files.add(pthread)
    if variant.endswith("-loadable"):
        files.update(str(p.relative_to(root)) for p in (root / EXTENSIONS).rglob("*") if p.is_file())
    validate_file_list(files, variant)
    cache.mkdir(parents=True, exist_ok=False)
    hashes = {}
    for name in sorted(files):
        source = root / name
        if source.is_symlink() or not source.is_file() or not source.stat().st_size:
            raise ValueError(f"Missing or invalid artifact: {name}")
        target = cache / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        hashes[name] = digest(target)
    (cache / "manifest.json").write_text(json.dumps({
        "key": key, "variant": variant, "files": hashes,
    }, sort_keys=True, indent=2) + "\n")


def restore(root, cache, variant, key):
    manifest = json.loads((cache / "manifest.json").read_text())
    if manifest["key"] != key or manifest["variant"] != variant:
        raise ValueError("Cached Wasm build inputs do not match this job")
    files = manifest["files"]
    validate_file_list(files, variant)
    # Verify the entire manifest before copying anything into the checkout.
    for name, expected in files.items():
        source = cache / name
        if (source.is_symlink() or not source.resolve().is_relative_to(cache.resolve())
                or digest(source) != expected):
            raise ValueError(f"Cached artifact failed integrity verification: {name}")
    for name in files:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cache / name, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("key", "stage", "restore"))
    parser.add_argument("variant", choices=VARIANTS)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--key")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.command == "key":
        print(cache_key(root, args.variant, os.environ))
    else:
        if not args.cache or not args.key:
            parser.error("stage/restore require --cache and --key")
        {"stage": stage, "restore": restore}[args.command](root, args.cache, args.variant, args.key)


if __name__ == "__main__":
    main()
