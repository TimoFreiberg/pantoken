#!/usr/bin/env python3
"""Validate test inventory against expected targets.

Checks that every test target in buck2/test-inventory.toml has a corresponding
entry in buck2/expected-targets.toml, and vice versa. Rejects undeclared entries.
"""

import re
import sys
try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 and older
    import tomli as tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
INVENTORY_PATH = REPO_ROOT / "buck2" / "test-inventory.toml"
MANIFEST_PATH = REPO_ROOT / "buck2" / "expected-targets.toml"


def load_toml(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


def buck_declarations(label):
    package, name = label[2:].split(":", 1)
    path = REPO_ROOT / package / "BUCK"
    text = path.read_text()
    match = re.search(rf'(?:rust_test|rust_binary)\(\s*name = "{re.escape(name)}"(?P<body>.*?)(?:^\))', text, re.MULTILINE | re.DOTALL)
    if not match:
        raise ValueError(f"{label}: declaration not found in {path}")
    return match.group("body")


def validate_declarations(inventory):
    errors = []
    for entry in inventory.get("tests", []):
        label = entry["label"]
        if not label.startswith("//server-rs/") or ":" not in label:
            continue
        try:
            body = buck_declarations(label)
        except ValueError as error:
            errors.append(str(error))
            continue
        resources_match = re.search(r"resources\s*=\s*\[(.*?)\]", body, re.DOTALL)
        run_env_match = re.search(r"run_env\s*=\s*\{(.*?)\}", body, re.DOTALL)
        resources = set(re.findall(r'"((?://|:)[^" ]+)"', resources_match.group(1))) if resources_match else set()
        run_env = set(re.findall(r'"([A-Z][A-Z0-9_]+)"\s*:', run_env_match.group(1))) if run_env_match else set()
        package_prefix = "//" + label[2:].split(":", 1)[0]
        normalized_resources = {
            resource if resource.startswith("//") else package_prefix + resource
            for resource in resources
        }
        declared_data = set(entry.get("data", []))
        declared_executables = set(entry.get("executables", []))
        if declared_data - normalized_resources:
            errors.append(f"{label}: inventory data is not declared in resources: {sorted(declared_data - normalized_resources)}")
        if declared_executables - normalized_resources:
            errors.append(f"{label}: inventory executables are not declared in resources: {sorted(declared_executables - normalized_resources)}")
        declared_env = set(entry.get("env_set", [])) | set(entry.get("env_clear", []))
        if normalized_resources - (declared_data | declared_executables):
            errors.append(f"{label}: BUCK resources missing from inventory data/executables: {sorted(normalized_resources - (declared_data | declared_executables))}")
        if label.endswith(":server_lib_unit_tests"):
            # Compile-time env is represented by BUCK `env`, not runtime run_env.
            declared_env.discard("PANTOKEN_BUILD_SHA")
            declared_env.discard("PANTOKEN_RELEASE_BUILD")
        if (declared_data | declared_executables) - normalized_resources:
            errors.append(f"{label}: inventory data/executables missing from BUCK resources: {sorted((declared_data | declared_executables) - normalized_resources)}")
        if run_env - declared_env:
            errors.append(f"{label}: BUCK run_env missing from inventory env policy: {sorted(run_env - declared_env)}")
        if declared_env - run_env:
            errors.append(f"{label}: inventory env policy missing from BUCK run_env: {sorted(declared_env - run_env)}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)


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

    validate_declarations(inventory)
    print(f"OK: {len(inventory_tests)} test targets match between inventory and manifest.")


if __name__ == "__main__":
    main()
