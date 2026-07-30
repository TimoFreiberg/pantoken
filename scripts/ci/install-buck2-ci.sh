#!/usr/bin/env bash
# scripts/ci/install-buck2-ci.sh — Install pinned Buck2 + Reindeer for CI.
#
# Downloads prebuilt binaries from GitHub releases matching the pinned revisions
# defined in scripts/buck2/check-version.sh. Installs to $HOME/.local/bin.
#
# Usage: bash scripts/ci/install-buck2-ci.sh
#
# Exit codes:
#   0 — success
#   1 — any failure (download, decompress, version check)
#
# Pinned revisions (canonical source: scripts/buck2/check-version.sh):
#   Buck2:     2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc
#   Reindeer:  efe17c7bb0b547ed07d48111ebcbeea5fa42a904 (tag v2026.07.27.00)

set -euo pipefail

# ── Pinned versions (must match scripts/buck2/check-version.sh) ──────────────
BUCK2_REPO="facebook/buck2"
BUCK2_DATE_TAG="2026-07-15"
BUCK2_REVISION="1560aca2002865cd73d7cafb22c705cfb640b2bc"

REINDEER_REPO="facebookincubator/reindeer"
REINDEER_TAG="v2026.07.27.00"

# Determine the host architecture asset suffix
HOST_TRIPLE="${BUCK2_EXPECTED_HOST_TRIPLE:-}"
if [[ -z "$HOST_TRIPLE" ]]; then
  HOST_TRIPLE=$(rustc -vV 2>/dev/null | grep '^host:' | awk '{print $2}')
fi
if [[ -z "$HOST_TRIPLE" ]]; then
  echo "ERROR: could not determine host triple. Set BUCK2_EXPECTED_HOST_TRIPLE." >&2
  exit 1
fi

# Map the rustc host triple → Buck2/Reindeer release asset suffix.
# Buck2 publishes Linux binaries as *-musl, but rustc reports *-gnu.
asset_triple() {
  case "$1" in
    aarch64-apple-darwin)       echo "aarch64-apple-darwin" ;;
    x86_64-unknown-linux-gnu)   echo "x86_64-unknown-linux-musl" ;;
    aarch64-unknown-linux-gnu)  echo "aarch64-unknown-linux-musl" ;;
    *) echo "$1" ;;
  esac
}

ASSET_TRIPLE=$(asset_triple "$HOST_TRIPLE")

# Install zstd if not available (needed for decompressing Buck2/Reindeer assets).
# macOS runners have zstd pre-installed; ubuntu-latest does not.
if ! command -v zstd &>/dev/null; then
  echo "  zstd not found — installing..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq zstd
  elif command -v brew &>/dev/null; then
    brew install zstd
  else
    echo "ERROR: zstd not found and no package manager available to install it." >&2
    exit 1
  fi
fi

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

echo "=== Installing Buck2 + Reindeer for CI ==="
echo "  Host triple: $HOST_TRIPLE"
echo "  Asset triple: $ASSET_TRIPLE"
echo "  Install dir: $INSTALL_DIR"
echo "  Buck2 pin:   ${BUCK2_DATE_TAG}-${BUCK2_REVISION}"
echo "  Reindeer tag: ${REINDEER_TAG}"

# ── Download helper ──────────────────────────────────────────────────────────
download_asset() {
  local repo="$1"
  local tag="$2"
  local asset="$3"
  local dest="$4"
  local url="https://github.com/${repo}/releases/download/${tag}/${asset}"
  echo "  Downloading: $url"
  if ! curl -fsSL -o "$dest" "$url"; then
    echo "ERROR: download failed for $asset" >&2
    echo "  URL: $url" >&2
    return 1
  fi
}

# ── Install Buck2 ────────────────────────────────────────────────────────────
install_buck2() {
  local asset="buck2-${ASSET_TRIPLE}.zst"
  local tmp_zst
  tmp_zst=$(mktemp -t buck2.XXXXXX.zst)
  local tmp_bin
  tmp_bin=$(mktemp -t buck2.XXXXXX)

  download_asset "$BUCK2_REPO" "$BUCK2_DATE_TAG" "$asset" "$tmp_zst"

  echo "  Decompressing buck2..."
  if ! zstd -d "$tmp_zst" -o "$tmp_bin" -f; then
    echo "ERROR: zstd decompression failed for buck2" >&2
    rm -f "$tmp_zst" "$tmp_bin"
    return 1
  fi

  chmod +x "$tmp_bin"
  mv "$tmp_bin" "${INSTALL_DIR}/buck2"
  rm -f "$tmp_zst"
  echo "  Buck2 installed: ${INSTALL_DIR}/buck2"
}

# ── Install Reindeer ─────────────────────────────────────────────────────────
install_reindeer() {
  local asset="reindeer-${ASSET_TRIPLE}.zst"
  local tmp_zst
  tmp_zst=$(mktemp -t reindeer.XXXXXX.zst)
  local tmp_bin
  tmp_bin=$(mktemp -t reindeer.XXXXXX)

  if ! download_asset "$REINDEER_REPO" "$REINDEER_TAG" "$asset" "$tmp_zst"; then
    echo "WARN: Reindeer binary not found for tag ${REINDEER_TAG}, trying cargo install" >&2
    echo "  This is expected if no prebuilt binary is published." >&2
    rm -f "$tmp_zst" "$tmp_bin"
    # Fall back to cargo install from the pinned commit
    if command -v cargo &>/dev/null; then
      echo "  Installing Reindeer via cargo install (pinned commit)..."
      cargo install --git "https://github.com/${REINDEER_REPO}" \
        --rev "efe17c7bb0b547ed07d48111ebcbeea5fa42a904" \
        --root "$INSTALL_DIR" reindeer
    else
      echo "  cargo not available — Reindeer not installed" >&2
    fi
    return 0
  fi

  echo "  Decompressing reindeer..."
  if ! zstd -d "$tmp_zst" -o "$tmp_bin" -f; then
    echo "ERROR: zstd decompression failed for reindeer" >&2
    rm -f "$tmp_zst" "$tmp_bin"
    return 1
  fi

  chmod +x "$tmp_bin"
  mv "$tmp_bin" "${INSTALL_DIR}/reindeer"
  rm -f "$tmp_zst"
  echo "  Reindeer installed: ${INSTALL_DIR}/reindeer"
}

# ── Verify ──────────────────────────────────────────────────────────────────
verify() {
  # Add install dir to PATH for this shell
  export PATH="${INSTALL_DIR}:${PATH}"

  echo "=== Verifying Buck2 revision ==="
  local version_output
  version_output=$("${INSTALL_DIR}/buck2" --version 2>&1) || {
    echo "ERROR: buck2 binary failed to execute" >&2
    echo "  Output: $version_output" >&2
    return 1
  }

  local extracted_rev
  extracted_rev=$(echo "$version_output" | grep -oE '[0-9a-f]{40}' | head -1)

  if [[ "$extracted_rev" != "$BUCK2_REVISION" ]]; then
    echo "ERROR: Buck2 revision mismatch." >&2
    echo "  Expected: $BUCK2_REVISION" >&2
    echo "  Got:      $extracted_rev" >&2
    echo "  Full version: $version_output" >&2
    return 1
  fi

  echo "OK: Buck2 revision matches ($extracted_rev)"
  echo "  $version_output"

  # Verify Reindeer presence (commit not verified — Reindeer has no --version)
  if command -v reindeer &>/dev/null; then
    echo "OK: Reindeer found at $(command -v reindeer)"
    echo "  (commit not verified — Reindeer has no --version flag)"
  else
    echo "WARN: Reindeer not on PATH (only needed for deps regeneration)" >&2
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
install_buck2
install_reindeer
verify

echo ""
echo "=== Installation complete ==="
echo "  buck2: ${INSTALL_DIR}/buck2"
echo "  Add ${INSTALL_DIR} to PATH for subsequent steps."
