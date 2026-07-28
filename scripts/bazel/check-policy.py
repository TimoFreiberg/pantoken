#!/usr/bin/env python3
"""Static, provider-free checks for Pantoken's additive Bazel policy."""
from __future__ import annotations
import pathlib, re, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
POLICY = ROOT / "docs/bazel-policy.md"
errors: list[str] = []
def require(condition: bool, message: str) -> None:
    if not condition: errors.append(message)
def text(path: pathlib.Path) -> str:
    try: return path.read_text()
    except OSError as exc: errors.append(f"cannot read {path}: {exc}"); return ""
def checked_files() -> list[pathlib.Path]:
    return [ROOT / x for x in (".bazelrc", ".bazelversion", "MODULE.bazel", "BUILD.bazel", "scripts/bazel/BUILD.bazel", "server-rs/pantoken-server/BUILD.bazel", "server-rs/pantoken-protocol/BUILD.bazel", "server-rs/pantoken-remote-layout/BUILD.bazel", "server-rs/pantoken-daemon-types/BUILD.bazel", "server-rs/pantoken-tar-validate/BUILD.bazel")]
policy = text(POLICY); module = text(ROOT / "MODULE.bazel"); bazelrc = text(ROOT / ".bazelrc"); rust = text(ROOT / "rust-toolchain.toml")
require(POLICY.exists(), "canonical policy document is missing")
for heading in ("## Pins and ownership", "## Supported platforms", "## Boundary and non-goals", "## Target conventions", "## Lockfiles and dependency updates", "## Hermeticity and path stability", "## Ownership"):
    require(heading in policy, f"policy heading missing: {heading}")
for path in ("AGENTS.md", "README.md", "docs/toolchain-baseline.md", "docs/bazel-migration-task.md"):
    require("docs/bazel-policy.md" in text(ROOT / path), f"{path} does not link canonical Bazel policy")
require(text(ROOT / ".bazelversion").strip() == "8.7.0", "Bazel pin must be 8.7.0")
require('version = "0.71.3"' in module and 'version = "1.2.0"' in module, "rules pins drifted")
require('channel = "1.97.1"' in rust and '"1.97.1"' in module, "Rust pins drifted")
require('edition = "2024"' in module, "Rust edition pin missing")
require("--enable_bzlmod" in bazelrc and "--enable_workspace" in bazelrc and "--incompatible_strict_action_env" in bazelrc, "required Bazel flags missing")
require("--disk_cache=~/.cache/bazel" not in bazelrc and "--disk_cache=/tmp" not in bazelrc, "machine-local disk cache must not be configured")
all_build = "\n".join(text(p) for p in checked_files())
forbidden = ("$HOME", "${HOME}", "/Users/", "/home/", "C:\\\\Users\\\\", "WORKSPACE_ROOT", "/private/tmp/")
def has_forbidden(value: str) -> bool:
    return "env_inherit" in value or any(pattern in value for pattern in forbidden)
require(not has_forbidden(all_build), "ambient environment or machine path remains in BUILD files")
require(not has_forbidden(policy + module + bazelrc), "ambient environment or machine path remains in Bazel policy/config")
require("bazel_path_stability_test" in text(ROOT / "BUILD.bazel"), "mandatory path stability target missing")
require("server-rs" in policy and "unsigned" in policy and "Vite" in policy and "Playwright" in policy, "boundary markers missing")
require("Cargo.lock" in policy and "pnpm-lock.yaml" in policy and "CARGO_BAZEL_REPIN=1" in policy, "lockfile workflow incomplete")
# Exercise the same predicate against copied negative fixtures without modifying the checkout.
with tempfile.TemporaryDirectory(prefix="bazel-policy-") as td:
    probe = pathlib.Path(td) / "BUILD.bazel"
    probe.write_text(all_build + "\nenv_inherit = [\"HOME\"]\n/Users/example\n")
    require(has_forbidden(probe.read_text()), "negative fixture did not trigger forbidden-input validation")
try:
    q = subprocess.run(["bazel", "query", "//:bazel_path_stability_test"], cwd=ROOT, text=True, capture_output=True, timeout=60)
    require(q.returncode == 0 and q.stdout.strip() == "//:bazel_path_stability_test", "path stability target does not resolve")
except (OSError, subprocess.SubprocessError) as exc:
    errors.append(f"Bazel target query failed: {exc}")
if errors:
    print("Bazel policy check failed:", file=sys.stderr)
    for error in errors: print(f"- {error}", file=sys.stderr)
    sys.exit(1)
print("Bazel policy check passed")
