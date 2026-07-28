#!/usr/bin/env python3
"""Validate test inventory against expected targets.

Checks that every test target in buck2/test-inventory.toml has a corresponding
entry in buck2/expected-targets.toml, and vice versa. Rejects undeclared entries.
"""

import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
INVENTORY_PATH = REPO_ROOT / "buck2" / "test-inventory.toml"
MANIFEST_PATH = REPO_ROOT / "buck2" / "expected-targets.toml"


def load_toml(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


def main():
    inventory = load_toml(INVENTORY_PATH)
    manifest = load_toml(MANIFEST_PATH)

    inventory_tests = {t["label"] for t in inventory.get("tests", [])}
    manifest_tests = {t["label"] for t in manifest.get("targets", []) if t.get("test", False)}

    missing_in_manifest = inventory_tests - manifest_tests
    missing_in_inventory = manifest_tests - inventory_tests

    if missing_in_manifest:
        print("ERROR: Test inventory has targets not in expected-target manifest:", file=sys.stderr)
        for t in sorted(missing_in_manifest):
            print(f"  NOT IN MANIFEST: {t}", file=sys.stderr)

    if missing_in_inventory:
        print("ERROR: Expected-target manifest has test targets not in inventory:", file=sys.stderr)
        for t in sorted(missing_in_inventory):
            print(f"  NOT IN INVENTORY: {t}", file=sys.stderr)

    if missing_in_manifest or missing_in_inventory:
        sys.exit(1)

    print(f"OK: {len(inventory_tests)} test targets match between inventory and manifest.")


if __name__ == "__main__":
    main()
