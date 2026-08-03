#!/usr/bin/env python3
"""Validate that Buck2 targets match the expected-target manifest.

Compares the actual Buck2 targets (from `buck2 uquery`) against the
checked-in expected-target manifest in buck2/expected-targets.toml.
Fails on omissions or unexpected targets, including desktop/frontend targets.
"""

import os
import subprocess
import sys
try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 and older
    import tomli as tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MANIFEST_PATH = REPO_ROOT / "buck2" / "expected-targets.toml"


def get_expected_targets():
    with open(MANIFEST_PATH, "rb") as f:
        data = tomllib.load(f)
    return {t["label"] for t in data.get("targets", [])}


def get_actual_targets():
    # Query all rust_library, rust_binary, rust_test, filegroup, genrule, sh_test targets.
    # .workspaces/ and other dirs are excluded via [project] ignore in .buckconfig.
    result = subprocess.run(
        [os.environ.get("BUCK2", "buck2"), "uquery",
         "kind(rust_library, //...) + kind(rust_binary, //...) + kind(rust_test, //...) + kind(filegroup, //server/...) + kind(genrule, //...) + kind(sh_test, //...)"],
        capture_output=True, text=True, cwd=REPO_ROOT,
        env={**os.environ, "HOME": str(Path.home())},
    )
    if result.returncode != 0:
        print(f"ERROR: buck2 uquery failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    # Parse output lines, stripping log lines and normalizing labels.
    # Buck2 uquery returns labels with a cell prefix (e.g. "root//server/...")
    # but the manifest uses plain "//server/..." labels. Strip the prefix.
    targets = set()
    for line in result.stdout.strip().split("\n"):
        line = line.strip()
        if line and not line.startswith("[") and not line.startswith("Command"):
            # Normalize: "root//foo:bar" -> "//foo:bar"
            if line.startswith("root//"):
                line = line[4:]  # remove "root"
            targets.add(line)
    return targets


def main():
    expected = get_expected_targets()
    actual = get_actual_targets()

    missing = expected - actual
    unexpected = actual - expected

    # Filter out third-party targets and internal helper targets (they're
    # intermediate genrules/filegroups used by the archive assembly, not POC deliverables)
    _INTERNAL_PREFIXES = ("//third-party:",)
    _INTERNAL_TARGETS = {"//:version_file", "//:build_sha_file"}
    unexpected = {t for t in unexpected
                  if not any(t.startswith(p) for p in _INTERNAL_PREFIXES)
                  and t not in _INTERNAL_TARGETS}

    if missing:
        print("ERROR: Expected targets not found in Buck2 graph:", file=sys.stderr)
        for t in sorted(missing):
            print(f"  MISSING: {t}", file=sys.stderr)

    if unexpected:
        print("ERROR: Unexpected targets in Buck2 graph (not in manifest):", file=sys.stderr)
        for t in sorted(unexpected):
            print(f"  UNEXPECTED: {t}", file=sys.stderr)

    if missing or unexpected:
        sys.exit(1)

    print(f"OK: All {len(expected)} expected targets match Buck2 graph.")


if __name__ == "__main__":
    main()
