#!/usr/bin/env bash
# install.sh — fetch the latest Pantoken.app into /Applications via curl.
#
# The app is ad-hoc signed (no Apple notarization). A browser download attaches
# the quarantine xattr and Gatekeeper refuses it — "Pantoken.app is damaged and
# can't be opened" — with no Open-Anyway path. curl sets no quarantine xattr, so
# the app opens normally. After the first launch it self-updates.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/TimoFreiberg/pantoken/main/install.sh | bash
#   # or, after cloning:
#   ./install.sh [--dest /Applications]
#
# Requires macOS. Fails loudly elsewhere.
set -euo pipefail

DEFAULT_DEST="/Applications"
REPO="TimoFreiberg/pantoken"

# ── arg parsing ──
DEST="$DEFAULT_DEST"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST="$2"
      shift 2
      ;;
    --dest=*)
      DEST="${1#--dest=}"
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [--dest <dir>]

Downloads the latest Pantoken.app tarball via curl and extracts it to <dir>
(default: $DEFAULT_DEST). macOS only — the desktop app is an .app bundle.

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash
EOF
      exit 0
      ;;
    *)
      echo "install: unknown argument: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

# ── platform guard ──
if [[ "$(uname)" != "Darwin" ]]; then
  echo "install: this script only supports macOS (you're on $(uname))" >&2
  echo "install: the Pantoken desktop app is a macOS .app bundle" >&2
  exit 1
fi

# ── arch → updater platform key ──
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)   PLATFORM="darwin-aarch64" ;;
  x86_64)  PLATFORM="darwin-x86_64" ;;
  *)
    echo "install: unsupported architecture '$ARCH' (expected arm64 or x86_64)" >&2
    exit 1
    ;;
esac

# ── dependency checks ──
for cmd in curl tar mktemp; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "install: required command not found: $cmd" >&2
    exit 1
  fi
done

# ── destination must exist and be writable ──
if [[ ! -d "$DEST" ]]; then
  echo "install: destination directory does not exist: $DEST" >&2
  exit 1
fi
if [[ ! -w "$DEST" ]]; then
  echo "install: destination not writable: $DEST" >&2
  echo "install: try: sudo $0 $*  (or pick a user-writable --dest)" >&2
  exit 1
fi

# ── quit a running instance so the bundle can be replaced cleanly ──
# Only touch the running app if we're overwriting the exact path it's running
# from. Installing to a temp dir (--dest /tmp/...) shouldn't kill the live app.
if [[ -d "$DEST/Pantoken.app" ]] && pgrep -x "pantoken-desktop" >/dev/null 2>&1; then
  echo "install: Pantoken is running — quitting it so the bundle can be replaced."
  osascript -e 'quit app "Pantoken"' 2>/dev/null || pkill -x "pantoken-desktop"
  # Wait for it to actually exit (up to 5s)
  for _ in 1 2 3 4 5; do
    pgrep -x "pantoken-desktop" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -x "pantoken-desktop" >/dev/null 2>&1; then
    echo "install: Pantoken didn't quit — please close it and try again." >&2
    exit 1
  fi
fi

# ── fetch the updater manifest to resolve the platform-specific tarball URL ──
# The manifest's version comes from the built bundle's Info.plist (not config), so
# it always agrees with the artifact. We parse it with plutil (pre-installed on macOS,
# no brew/python dependency). If a platform key is absent, the latest release has no
# build for this arch — fail loudly rather than fetching the wrong one.
MANIFEST_URL="https://github.com/$REPO/releases/latest/download/latest.json"

echo "install: resolving the latest release for $PLATFORM..."
MANIFEST="$(mktemp -t pantoken-install)"
trap 'rm -f "$MANIFEST"' EXIT

curl -fsSL "$MANIFEST_URL" -o "$MANIFEST"

if ! grep -q "\"$PLATFORM\"" "$MANIFEST"; then
  echo "install: the latest release has no build for $PLATFORM." >&2
  echo "install: manifest at $MANIFEST_URL does not list '$PLATFORM'." >&2
  echo "install: open an issue at https://github.com/$REPO/issues" >&2
  exit 1
fi

# plutil -extract <keypath> raw -o - <file> prints the value to stdout.
# Returns non-zero if the key is missing (belt-and-suspenders with the grep above).
TARBALL_URL="$(plutil -extract "platforms.$PLATFORM.url" raw -o - "$MANIFEST" 2>/dev/null || true)"
VERSION="$(plutil -extract "version" raw -o - "$MANIFEST" 2>/dev/null || true)"

if [[ -z "$TARBALL_URL" ]]; then
  echo "install: couldn't extract the tarball URL for $PLATFORM from the manifest." >&2
  echo "install: manifest at $MANIFEST_URL may have an unexpected structure." >&2
  cat "$MANIFEST" >&2
  exit 1
fi

echo "install: Pantoken ${VERSION:-latest} → $DEST/Pantoken.app"

# ── download + extract ──
# Extract to a temp dir, then move into place. This avoids a half-written .app
# in /Applications if curl or tar fails mid-way.
STAGE="$(mktemp -d -t pantoken-install)"
trap 'rm -rf "$MANIFEST" "$STAGE"' EXIT

curl -fsSL "$TARBALL_URL" | tar xz -C "$STAGE"

if [[ ! -d "$STAGE/Pantoken.app" ]]; then
  echo "install: tarball didn't contain Pantoken.app — unexpected archive contents:" >&2
  ls -la "$STAGE" >&2
  exit 1
fi

# Remove an existing copy first (tar won't overwrite a running bundle cleanly,
# and we already quit the app above).
if [[ -d "$DEST/Pantoken.app" ]]; then
  rm -rf "$DEST/Pantoken.app"
fi

mv "$STAGE/Pantoken.app" "$DEST/Pantoken.app"

echo "install: done → $DEST/Pantoken.app"
echo "install: open it with: open -a Pantoken"
