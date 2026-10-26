#!/usr/bin/env python3
"""Regression checks for artifact invalidation and restoration."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from ci_wasm_artifacts import BINDINGS, EXTENSIONS, cache_key, restore, stage


class WasmArtifactCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Cache test")
        self.git("config", "user.email", "cache-test@example.invalid")
        for name in (".gitmodules", "Makefile", "yarn.lock", "extension_config_wasm.cmake",
                     "lib/src/engine.cc", "patches/duckdb/static.patch", "scripts/build.sh",
                     ".github/workflows/main.yml", "packages/duckdb-wasm/src/api.ts", "README.md"):
            self.write(name, "original\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.env = {"HAYBARN_WASM_CI_IMAGE": "image@sha256:" + "a" * 64,
                    "OVERRIDE_GIT_DESCRIBE": "v2.0.0"}
        self.key = self.key_for()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def write(self, name, content):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def key_for(self, variant="base", env=None):
        return cache_key(self.root, variant, self.env if env is None else env)

    def commit_change(self, name):
        self.write(name, "changed\n")
        self.git("add", name)
        self.git("commit", "-qm", "change input")

    def test_javascript_and_docs_reuse_native_outputs(self):
        self.commit_change("packages/duckdb-wasm/src/api.ts")
        # README is conservatively included as a root configuration file; docs
        # in their own directory and package code do not affect native inputs.
        self.commit_change("docs/guide.md")
        self.assertEqual(self.key, self.key_for())

    def test_all_native_input_categories_invalidate(self):
        for name in ("Makefile", "yarn.lock", ".gitmodules", "extension_config_wasm.cmake",
                     "lib/src/engine.cc", "patches/duckdb/static.patch", "scripts/build.sh",
                     ".github/workflows/main.yml"):
            with self.subTest(name=name):
                before = self.key_for()
                self.commit_change(name)
                self.assertNotEqual(before, self.key_for())

    def test_engine_and_extension_gitlinks_invalidate(self):
        for name in ("submodules/duckdb", "submodules/duckdb-nanoarrow"):
            with self.subTest(name=name):
                before = self.key_for()
                self.git("update-index", "--add", "--cacheinfo", f"160000,{'a' * 40},{name}")
                self.git("commit", "-qm", "pin submodule")
                pinned = self.key_for()
                self.assertNotEqual(before, pinned)
                self.git("update-index", "--cacheinfo", f"160000,{'b' * 40},{name}")
                self.git("commit", "-qm", "update submodule")
                self.assertNotEqual(pinned, self.key_for())

    def test_toolchain_flags_version_and_variant_invalidate(self):
        for name in ("HAYBARN_WASM_CI_IMAGE", "OVERRIDE_GIT_DESCRIBE", "DUCKDB_WASM_VERSION",
                     "DEFAULT_USE_GENERATED_EXPORTED_LIST", "EXTRA_CMAKE_FLAGS", "EXTRA_LINK_FLAGS",
                     "CFLAGS", "CXXFLAGS", "LDFLAGS"):
            with self.subTest(name=name):
                self.assertNotEqual(self.key, self.key_for(env={**self.env, name: self.env.get(name, "") + "changed"}))
        self.assertEqual(4, len({self.key_for(v) for v in ("base", "threads", "base-loadable", "threads-loadable")}))
        with self.assertRaises(ValueError):
            self.key_for(env={**self.env, "HAYBARN_WASM_CI_IMAGE": "image:latest"})

    def make_artifacts(self, variant="base"):
        bundle = variant.split("-")[0]
        for suffix in ("js", "wasm"):
            self.write(f"{BINDINGS}duckdb-{bundle}.{suffix}", "artifact " + suffix)
        if variant.endswith("-loadable"):
            self.write(EXTENSIONS + "v2.0.0/wasm_eh/httpfs.duckdb_extension.wasm", "extension")
        cache = Path(self.temp.name) / "cache"
        stage(self.root, cache, variant, self.key_for(variant))
        return cache

    def test_round_trip_with_extensions(self):
        cache = self.make_artifacts("threads-loadable")
        output = Path(self.temp.name) / "restored"
        restore(output, cache, "threads-loadable", self.key_for("threads-loadable"))
        for name in json.loads((cache / "manifest.json").read_text())["files"]:
            self.assertEqual((self.root / name).read_bytes(), (output / name).read_bytes())

    def test_tampered_cache_is_rejected_before_copy(self):
        cache = self.make_artifacts()
        (cache / (BINDINGS + "duckdb-base.wasm")).write_text("corrupt")
        output = Path(self.temp.name) / "restored"
        with self.assertRaises(ValueError):
            restore(output, cache, "base", self.key)
        self.assertFalse(output.exists())

    def test_wrong_inputs_and_missing_files_are_rejected(self):
        cache = self.make_artifacts()
        output = Path(self.temp.name) / "restored"
        with self.assertRaises(ValueError):
            restore(output, cache, "base", "different-inputs")
        manifest = json.loads((cache / "manifest.json").read_text())
        del manifest["files"][BINDINGS + "duckdb-base.wasm"]
        (cache / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            restore(output, cache, "base", self.key)

    def test_paths_outside_artifact_directories_are_rejected(self):
        cache = self.make_artifacts()
        manifest = json.loads((cache / "manifest.json").read_text())
        manifest["files"]["../../outside"] = "bad"
        (cache / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            restore(Path(self.temp.name) / "restored", cache, "base", self.key)


if __name__ == "__main__":
    unittest.main()
