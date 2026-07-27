#!/usr/bin/env bash
# capture-baseline-timings.sh — record representative toolchain baseline timings.
#
# Outputs a markdown table to stdout suitable for pasting into
# docs/toolchain-baseline.md. These are one-time comparison points, not a
# performance program — re-capture on the same machine for like-for-like results.
#
# Requirements:
#   - Run from the DEFAULT jj workspace (repo root). The script checks this
#     because `just create-workspace` refuses to run from a non-default workspace.
#   - All prerequisites installed: bun, cargo, just, sccache, Playwright browsers.
#
# Cost:
#   - cargo clean -p pantoken-server removes pantoken-server artifacts from the
#     shared CARGO_TARGET_DIR (shared across all jj worktrees). Other worktrees
#     will need to recompile pantoken-server. Run when no other worktree is
#     actively building.
#   - E2E is expensive (boots a dev server + browser suite).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"

# --- Guard: must run from the default jj workspace ---------------------------
current_dir="$(pwd -P)"
is_default=no
while IFS=$'\t' read -r n r; do
  [ "$n" = default ] || continue
  canonical="$(cd "$r" 2>/dev/null && pwd -P || true)"
  [ "$canonical" = "$current_dir" ] && is_default=yes
done < <(jj workspace list -T 'name ++ "\t" ++ root ++ "\n"' 2>/dev/null)
if [ "$is_default" != yes ]; then
  echo "ERROR: this script must run from the default jj workspace at $REPO_ROOT" >&2
  echo "You are currently in: $current_dir" >&2
  echo "Run from the repo root (the default workspace)." >&2
  exit 1
fi

# --- Helpers ----------------------------------------------------------------
timings_file="$(mktemp)"
trap 'rm -f "$timings_file"' EXIT

# time_cmd <label> <command...>  — runs command, appends elapsed seconds to timings_file
time_cmd() {
  local label="$1"; shift
  local start end elapsed
  start=$(date +%s.%N)
  "$@" >/dev/null 2>&1
  end=$(date +%s.%N)
  elapsed=$(awk "BEGIN {printf \"%.2f\", $end - $start}")
  echo "$label	$elapsed" >> "$timings_file"
}

# fmt_duration <seconds> — returns "Xs" or "Xm Ys"
fmt_duration() {
  local secs="$1"
  awk -v s="$secs" 'BEGIN {
    if (s < 60) printf "%.1fs", s;
    else printf "%.0fm %.0fs", s/60, s%60
  }'
}

# --- Machine info -----------------------------------------------------------
machine_os="$(sw_vers -productName 2>/dev/null && sw_vers -productVersion 2>/dev/null || uname -s)"
machine_arch="$(uname -m)"
machine_cpu="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
capture_date="$(date '+%Y-%m-%d')"

echo "" >&2
echo "=== Toolchain Baseline Timing Capture ===" >&2
echo "Machine: $machine_os ($machine_arch), $machine_cpu" >&2
echo "Date: $capture_date" >&2
echo "" >&2

# --- Confirm the shared-cache cost ------------------------------------------
cat >&2 <<'WARNING'
NOTE: This script runs `cargo clean -p pantoken-server`, which removes
pantoken-server artifacts from the shared CARGO_TARGET_DIR
($HOME/Library/Caches/pantoken-cargo-target). This dir is shared across all
jj worktrees — other worktrees will need to recompile pantoken-server.

WARNING
read -r -p "Proceed? (yes/no) " reply >&2
[ "$reply" = "yes" ] || { echo "Aborted." >&2; exit 0; }
echo "" >&2

# --- Rust warm build --------------------------------------------------------
echo "Timing Rust warm build..." >&2
time_cmd "Rust build (warm)" cargo build -p pantoken-server

# --- Rust clean build -------------------------------------------------------
echo "Timing Rust clean build..." >&2
cargo clean -p pantoken-server
time_cmd "Rust build (clean)" cargo build -p pantoken-server

# --- Rust incremental build -------------------------------------------------
# Touch a source file (mtime-only change; jj content-hashing is unaffected).
echo "Timing Rust incremental build..." >&2
touch server-rs/pantoken-server/src/lib.rs
time_cmd "Rust build (incremental)" cargo build -p pantoken-server

# --- Client warm build ------------------------------------------------------
echo "Timing client warm build..." >&2
time_cmd "Client build (warm)" bun run build

# --- Client clean build -----------------------------------------------------
echo "Timing client clean build..." >&2
rm -rf client/dist
time_cmd "Client build (clean)" bun run build

# --- Client incremental build -----------------------------------------------
echo "Timing client incremental build..." >&2
touch client/src/lib/app-badge.ts
time_cmd "Client build (incremental)" bun run build

# --- Unit tests -------------------------------------------------------------
echo "Timing unit tests..." >&2
time_cmd "Unit tests (bun test)" bun test

# --- Typecheck --------------------------------------------------------------
echo "Timing typecheck..." >&2
time_cmd "Typecheck (bun run check)" bun run check

# --- E2E --------------------------------------------------------------------
echo "Timing E2E (expensive — boots dev server + browser suite)..." >&2
time_cmd "E2E (bun run test:e2e)" bun run test:e2e

# --- Workspace startup ------------------------------------------------------
echo "Timing workspace startup..." >&2
ws_name="baseline-timing-test"
# Clean up any stale workspace from a prior interrupted run.
just cleanup-workspace "$ws_name" >/dev/null 2>&1 || true
ws_start=$(date +%s.%N)
just create-workspace "$ws_name" >/dev/null 2>&1
(cd "$REPO_ROOT/.workspaces/$ws_name" && bun install --frozen-lockfile) >/dev/null 2>&1
ws_end=$(date +%s.%N)
ws_elapsed=$(awk "BEGIN {printf \"%.2f\", $ws_end - $ws_start}")
echo "Workspace startup	$ws_elapsed" >> "$timings_file"
# Cleanup the workspace.
just cleanup-workspace "$ws_name" >/dev/null 2>&1 || jj workspace forget "$ws_name" >/dev/null 2>&1 || true

# --- Output markdown table --------------------------------------------------
echo ""
echo "## Representative timings"
echo ""
echo "_Captured: $capture_date on $machine_os ($machine_arch), $machine_cpu._"
echo ""
echo "_These are comparison points, not a performance program. Machine-specific;_
_re-capture on the same machine for like-for-like comparison._"
echo ""
echo "| Metric | Time |"
echo "|--------|------|"
while IFS=$'\t' read -r label elapsed; do
  echo "| $label | $(fmt_duration "$elapsed") |"
done < "$timings_file"
