#!/usr/bin/env bash
# bazel-remote-preflight.sh — verify prerequisites and set up the REAPI cache daemon.
#
# Read-only checks first; setup only after checks pass.
# Does NOT install the daemon unless --setup (without --skip-daemon) is passed.
#
# Usage:
#   bash scripts/remote-cache/bazel-remote-preflight.sh [--setup] [--version <ver>]
#       [--cache-dir <path>] [--max-size <GiB>] [--grpc-port <port>]
#       [--http-port <port>] [--instance-name <name>] [--skip-daemon]
#
#   --setup           render plist, create cache dir, write env file, install daemon
#   --version         bazel-remote version (default: 2.6.2)
#   --cache-dir       on-disk cache directory (default: /usr/local/var/bazel-remote)
#   --max-size        max cache size in GiB (default: 50)
#   --grpc-port       gRPC listen port (default: 9092)
#   --http-port       HTTP status port (default: 8080)
#   --instance-name   REAPI instance name for namespacing (default: buck2)
#   --skip-daemon     render plist + env file only, don't install launchd
#
# Check severity model:
#   fatal          — aborts the script
#   warning        — prints but continues
#   informational  — reports state without judgment
#
# Command seams for testability:
#   BAZEL_REMOTE_BIN, TAILSCALE_BIN, LAUNCHCTL_BIN, PLUTIL_BIN, SUDO_BIN,
#   CURL_BIN, DF_BIN — default to standard PATH, overridable for tests.
#
# Output: every check prints ✓ (pass), ⚠ (warning), ℹ (informational),
# or ✗ (fatal/fail) with details.

set -euo pipefail

# ── Command seams (overridable for tests) ─────────────────────────────────────
BAZEL_REMOTE_BIN="${BAZEL_REMOTE_BIN:-bazel-remote}"
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
PLUTIL_BIN="${PLUTIL_BIN:-plutil}"
SUDO_BIN="${SUDO_BIN:-sudo}"
CURL_BIN="${CURL_BIN:-curl}"
DF_BIN="${DF_BIN:-df}"

# ── Paths ──────────────────────────────────────────────────────────────────────
HOME_DIR="${HOME:-$PWD}"
CACHE_DIR="/usr/local/var/bazel-remote"
MAX_SIZE="50"
GRPC_PORT="9092"
HTTP_PORT="8080"
INSTANCE_NAME="buck2"
VERSION_DEFAULT="2.6.2"
DATA_DIR="$HOME_DIR/.local/share/bazel-remote"
ENV_FILE="$DATA_DIR/bazel-remote.env"
LOG_DIR="$HOME_DIR/Library/Logs/bazel-remote"
PLIST_TEMPLATE="$(cd "$(dirname "$0")" && pwd)/com.bazel-remote.plist"
LAUNCHD_LABEL="com.bazel-remote"
RENDERED_PLIST_DIR="$DATA_DIR"

# ── Argument parsing ───────────────────────────────────────────────────────────
DO_SETUP=false
DO_SKIP_DAEMON=false
SETUP_VERSION=""
SETUP_CACHE_DIR=""
SETUP_MAX_SIZE=""
SETUP_GRPC_PORT=""
SETUP_HTTP_PORT=""
SETUP_INSTANCE_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup)         DO_SETUP=true; shift ;;
    --skip-daemon)   DO_SKIP_DAEMON=true; shift ;;
    --version)       SETUP_VERSION="$2"; shift 2 ;;
    --cache-dir)     SETUP_CACHE_DIR="$2"; shift 2 ;;
    --max-size)      SETUP_MAX_SIZE="$2"; shift 2 ;;
    --grpc-port)     SETUP_GRPC_PORT="$2"; shift 2 ;;
    --http-port)     SETUP_HTTP_PORT="$2"; shift 2 ;;
    --instance-name) SETUP_INSTANCE_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--setup] [--version <ver>] [--cache-dir <path>] [--max-size <GiB>]"
      echo "          [--grpc-port <port>] [--http-port <port>] [--instance-name <name>] [--skip-daemon]"
      echo "  --setup           render plist, create cache dir, write env file, install daemon"
      echo "  --version         bazel-remote version (default: $VERSION_DEFAULT)"
      echo "  --cache-dir       on-disk cache directory (default: $CACHE_DIR)"
      echo "  --max-size        max cache size in GiB (default: $MAX_SIZE)"
      echo "  --grpc-port       gRPC listen port (default: $GRPC_PORT)"
      echo "  --http-port       HTTP status port (default: $HTTP_PORT)"
      echo "  --instance-name   REAPI instance name for namespacing (default: $INSTANCE_NAME)"
      echo "  --skip-daemon     render plist + env file only, don't install launchd"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Apply overrides from args (fall back to defaults)
[[ -n "$SETUP_VERSION" ]]       && VERSION_DEFAULT="$SETUP_VERSION"
[[ -n "$SETUP_CACHE_DIR" ]]    && CACHE_DIR="$SETUP_CACHE_DIR"
[[ -n "$SETUP_MAX_SIZE" ]]     && MAX_SIZE="$SETUP_MAX_SIZE"
[[ -n "$SETUP_GRPC_PORT" ]]    && GRPC_PORT="$SETUP_GRPC_PORT"
[[ -n "$SETUP_HTTP_PORT" ]]    && HTTP_PORT="$SETUP_HTTP_PORT"
[[ -n "$SETUP_INSTANCE_NAME" ]] && INSTANCE_NAME="$SETUP_INSTANCE_NAME"

# ── Helpers ───────────────────────────────────────────────────────────────────
fatal_count=0
warning_count=0

check_pass()   { printf '  ✓ %s\n' "$1"; }
check_warn()   { printf '  ⚠ %s\n' "$1"; warning_count=$((warning_count + 1)); }
check_info()   { printf '  ℹ %s\n' "$1"; }
check_fail()   { printf '  ✗ %s\n' "$1"; fatal_count=$((fatal_count + 1)); }

# ── Read-only checks ──────────────────────────────────────────────────────────
echo "=== Bazel-Remote Preflight ==="
echo "  Mode: $([[ "$DO_SETUP" == true ]] && echo 'setup' || echo 'read-only')"
echo "  Version: $VERSION_DEFAULT"
echo "  Cache dir: $CACHE_DIR"
echo "  Max size: ${MAX_SIZE} GiB"
echo "  gRPC port: $GRPC_PORT"
echo "  HTTP port: $HTTP_PORT"
echo "  Instance: $INSTANCE_NAME"
echo ""

echo "--- Check 1: bazel-remote binary ---"
br_path="$(command -v "$BAZEL_REMOTE_BIN" 2>/dev/null || true)"
if [[ -n "$br_path" ]]; then
  # bazel-remote has no --version flag; verify identity via --help.
  br_help="$("$BAZEL_REMOTE_BIN" --help 2>&1 | head -1 || true)"
  if echo "$br_help" | grep -q "bazel-remote"; then
    check_pass "bazel-remote binary found at $br_path"
  else
    check_fail "binary at $br_path does not identify as bazel-remote: $br_help"
  fi
  # Report SHA256 for manual verification against the release page.
  br_sha="$(shasum -a 256 "$br_path" 2>/dev/null | awk '{print $1}' || true)"
  if [[ -n "$br_sha" ]]; then
    check_info "sha256: $br_sha (verify at https://github.com/buchgr/bazel-remote/releases/tag/v${VERSION_DEFAULT})"
  fi
else
  if [[ "$DO_SETUP" == true ]]; then
    check_fail "bazel-remote not found in PATH"
  else
    check_warn "bazel-remote not found in PATH"
  fi
fi

echo "--- Check 2: Tailscale ---"
if command -v "$TAILSCALE_BIN" >/dev/null 2>&1; then
  ts_status="$("$TAILSCALE_BIN" status 2>/dev/null || true)"
  if [[ -n "$ts_status" ]]; then
    ts_self="$(echo "$ts_status" | head -1 || true)"
    check_pass "Tailscale running ($ts_self)"
  else
    check_warn "tailscale CLI found but status empty"
  fi
else
  check_warn "tailscale CLI not found — cannot verify tailnet connectivity"
fi

echo "--- Check 3: Cache directory ---"
if [[ -d "$CACHE_DIR" ]]; then
  if [[ -w "$CACHE_DIR" ]]; then
    check_pass "cache dir exists and is writable: $CACHE_DIR"
  else
    check_warn "cache dir exists but not writable: $CACHE_DIR"
  fi
else
  check_info "cache dir does not exist yet: $CACHE_DIR"
fi

echo "--- Check 4: Disk space ---"
# Warn if available disk < 2× max_size (in GiB)
max_size_bytes=$((MAX_SIZE * 1024 * 1024 * 1024))
threshold_bytes=$((max_size_bytes * 2))
cache_parent="$(dirname "$CACHE_DIR")"
if [[ -d "$cache_parent" ]]; then
  avail_bytes="$("$DF_BIN" -k "$cache_parent" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
  avail_bytes=$((avail_bytes * 1024))
  if [[ "$avail_bytes" -ge "$threshold_bytes" ]]; then
    avail_gib=$((avail_bytes / 1024 / 1024 / 1024))
    check_pass "disk space sufficient: ${avail_gib} GiB available (need ≥ $((MAX_SIZE * 2)) GiB)"
  else
    avail_gib=$((avail_bytes / 1024 / 1024 / 1024))
    check_warn "low disk space: ${avail_gib} GiB available (need ≥ $((MAX_SIZE * 2)) GiB for 2× cache)"
  fi
else
  check_info "cache parent dir does not exist yet: $cache_parent"
fi

echo "--- Check 5: gRPC port ---"
if "$LAUNCHCTL_BIN" print "system/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  svc_status="$("$LAUNCHCTL_BIN" print "system/$LAUNCHD_LABEL" 2>/dev/null | head -5 || true)"
  check_info "service already loaded: $(echo "$svc_status" | tr '\n' ' ')"
else
  check_info "service not loaded (expected before bootstrap)"
fi

echo "--- Check 6: HTTP status endpoint ---"
http_status="$("$CURL_BIN" -fsS "http://localhost:${HTTP_PORT}/status" 2>/dev/null || true)"
if [[ -n "$http_status" ]]; then
  check_pass "bazel-remote HTTP status reachable on port $HTTP_PORT"
  # Verify the running version via GitTags in /status JSON.
  git_tags="$(echo "$http_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('GitTags',''))" 2>/dev/null || true)"
  if [[ -n "$git_tags" ]]; then
    if echo "$git_tags" | grep -q "v${VERSION_DEFAULT}"; then
      check_pass "running version $git_tags (expected v${VERSION_DEFAULT})"
    else
      check_warn "running version $git_tags (expected v${VERSION_DEFAULT})"
    fi
  fi
else
  check_info "bazel-remote HTTP status not reachable (expected if not running yet)"
fi

echo ""
echo "=== Check summary ==="
echo "  Fatal: $fatal_count  Warnings: $warning_count"
echo ""

# ── Abort on fatal if setup mode ───────────────────────────────────────────────
if [[ "$DO_SETUP" == true && $fatal_count -gt 0 ]]; then
  echo "ERROR: $fatal_count fatal check(s) failed — aborting setup" >&2
  exit 1
fi

# ── Read-only mode exit ───────────────────────────────────────────────────────
if [[ "$DO_SETUP" != true ]]; then
  if [[ $fatal_count -gt 0 ]]; then
    exit 1
  fi
  exit 0
fi

# ── Setup mode ────────────────────────────────────────────────────────────────
echo "=== Setup mode ==="
echo ""

echo "--- Step 1: Create cache directory ---"
if [[ ! -d "$CACHE_DIR" ]]; then
  # The default cache dir (/usr/local/var/bazel-remote) requires root.
  "$SUDO_BIN" mkdir -p "$CACHE_DIR"
  check_pass "created cache dir: $CACHE_DIR"
else
  check_pass "cache dir already exists: $CACHE_DIR"
fi

echo "--- Step 2: Render plist ---"
mkdir -p "$RENDERED_PLIST_DIR"
rendered_plist="$RENDERED_PLIST_DIR/com.bazel-remote.plist"

# Resolve bazel-remote binary path for the plist
br_resolved="$br_path"
if [[ -z "$br_resolved" ]]; then
  br_resolved="$(command -v bazel-remote 2>/dev/null || echo /usr/local/bin/bazel-remote)"
fi

sed \
  -e "s|@@@BAZEL_REMOTE_BIN@@@|$br_resolved|g" \
  -e "s|@@@CACHE_DIR@@@|$CACHE_DIR|g" \
  -e "s|@@@MAX_SIZE@@@|$MAX_SIZE|g" \
  -e "s|@@@GRPC_PORT@@@|$GRPC_PORT|g" \
  -e "s|@@@HTTP_PORT@@@|$HTTP_PORT|g" \
  -e "s|@@@LOGDIR@@@|$LOG_DIR|g" \
  "$PLIST_TEMPLATE" > "$rendered_plist"

if ! "$PLUTIL_BIN" -lint "$rendered_plist" 2>&1; then
  echo "ERROR: rendered plist failed lint" >&2
  exit 1
fi
check_pass "rendered plist valid: $rendered_plist"

echo "--- Step 3: Write env file ---"
mkdir -p "$DATA_DIR"
cat > "$ENV_FILE" <<ENVEOF
# bazel-remote environment (reference — bazel-remote reads flags from the plist, not this file)
# This file documents the intended instance name for operators.
INSTANCE_NAME=$INSTANCE_NAME
GRPC_PORT=$GRPC_PORT
HTTP_PORT=$HTTP_PORT
CACHE_DIR=$CACHE_DIR
MAX_SIZE=$MAX_SIZE
ENVEOF
check_pass "wrote env file: $ENV_FILE"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Rendered plist:"
echo "  $rendered_plist"
echo ""
if [[ "$DO_SKIP_DAEMON" == true ]]; then
  echo "Skipped daemon installation (--skip-daemon)."
  echo "To install manually:"
  echo "  sudo cp $rendered_plist /Library/LaunchDaemons/com.bazel-remote.plist"
  echo "  sudo launchctl bootstrap system /Library/LaunchDaemons/com.bazel-remote.plist"
else
  echo "Installing LaunchDaemon..."
  "$SUDO_BIN" cp "$rendered_plist" /Library/LaunchDaemons/com.bazel-remote.plist
  "$SUDO_BIN" "$LAUNCHCTL_BIN" bootstrap system /Library/LaunchDaemons/com.bazel-remote.plist
  check_pass "LaunchDaemon installed and bootstrapped"
fi
echo ""
echo "Post-setup verification:"
echo "  launchctl print system/$LAUNCHD_LABEL"
echo "  curl -fsS http://localhost:${HTTP_PORT}/status"
