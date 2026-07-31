#!/usr/bin/env bash
# Symlink rustc into a directory on buck2's sandbox-narrowed PATH.
#
# Buck2's system_rust_toolchain uses RunInfo(args=["rustc"]) — a bare name, not
# an absolute path — so rustc must be findable on PATH. ring's buildscript
# fixup narrows the sandbox PATH to system directories
# (/usr/bin:/bin:/usr/sbin:/sbin, plus
# /Library/Developer/CommandLineTools/usr/bin on macOS), which excludes
# rustup's ~/.cargo/bin. The prelude's buildscript_run.py calls
# ensure_rustc_available() before running any buildscript, so ring (and any
# other cc-based crate) fails with `rustc: command not found` unless rustc is
# discoverable on that narrowed PATH.
#
# On Linux, /usr/bin is writable (with sudo) → symlink rustc there.
# On macOS, /usr/bin is SIP-protected (read-only, even for root). We symlink
# to /Library/Developer/CommandLineTools/usr/bin instead, which is in the
# narrowed PATH and writable with sudo (not under SIP protection).
#
# The symlink targets `command -v rustc` (the rustup shim at ~/.cargo/bin/rustc)
# rather than `rustup which rustc` (the resolved toolchain binary) so that
# `rustup update` / channel switches are transparent — the shim re-targets
# automatically, while a resolved-binary symlink would break on toolchain
# update.
#
# Idempotent: if the symlink already exists and points to the correct target,
# exits 0 without prompting for sudo.
#
# Usage: bash scripts/buck2/setup-sandbox-rustc.sh
#        (or `just setup-sandbox-rustc`)

set -euo pipefail

# ── Resolve the rustc source (rustup shim) ──────────────────────────────────

if ! command -v rustc &>/dev/null; then
  echo "ERROR: rustc not on PATH — install Rust via rustup first." >&2
  echo "  rustup install 1.97.1" >&2
  exit 1
fi

RUSTC_SRC="$(command -v rustc)"

# ── Determine the symlink target directory ──────────────────────────────────

if [[ "$(uname -s)" == "Darwin" ]]; then
  # macOS: /usr/bin is SIP-protected. Use CommandLineTools/usr/bin (in PATH).
  SYMLINK_DIR="/Library/Developer/CommandLineTools/usr/bin"
  if [[ ! -d "$SYMLINK_DIR" ]]; then
    echo "ERROR: $SYMLINK_DIR not found — install Xcode CommandLineTools first:" >&2
    echo "  xcode-select --install" >&2
    exit 1
  fi
else
  # Linux: /usr/bin is writable with sudo.
  SYMLINK_DIR="/usr/bin"
fi

TARGET="$SYMLINK_DIR/rustc"

# ── Idempotency check: skip if symlink already correct ──────────────────────

if [[ -L "$TARGET" && "$(readlink "$TARGET" 2>/dev/null)" == "$RUSTC_SRC" ]]; then
  echo "OK: rustc already symlinked to $TARGET → $RUSTC_SRC (no action needed)"
  exit 0
fi

# ── Create / refresh the symlink (needs sudo) ───────────────────────────────

if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
  echo "ERROR: $TARGET exists and is not a symlink — refusing to overwrite." >&2
  exit 1
fi

echo "Symlinking rustc → $TARGET (pointing to $RUSTC_SRC)"
echo "  (requires sudo to write to $SYMLINK_DIR)"
sudo ln -sf "$RUSTC_SRC" "$TARGET"

# ── Verify ──────────────────────────────────────────────────────────────────

if [[ -L "$TARGET" && "$(readlink "$TARGET" 2>/dev/null)" == "$RUSTC_SRC" ]]; then
  echo "OK: rustc symlinked → $TARGET → $RUSTC_SRC"
else
  echo "ERROR: symlink verification failed — $TARGET does not point to $RUSTC_SRC" >&2
  exit 1
fi
