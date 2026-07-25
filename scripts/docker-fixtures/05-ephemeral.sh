#!/usr/bin/env bash
# Fixture 05 — Ephemeral data (writable layer).
#
# Pantoken root on the container's writable layer (no covering mount). Tests the
# EphemeralData risk acknowledgement. Uses a non-root user so the only risk
# surfaced is ephemeral, not root.
#
# Expected pantoken behavior: preflight surfaces EphemeralData risk →
# AwaitingAcknowledgement.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-ephemeral"

print_header "Fixture 05 — Ephemeral data (writable layer)"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating container ${CONTAINER_NAME} (NO bind mount) ..."
# No -v mount: /var/lib/pantoken lives on the writable layer.
docker run -d \
    --name "${CONTAINER_NAME}" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up base (tools + user) ..."
setup_debian_base "${CONTAINER_NAME}" yes

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

print_fixture_info \
    "05-ephemeral" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight surfaces EphemeralData risk (EphemeralWritableLayer) → AwaitingAcknowledgement"

echo "✓ Fixture 05 complete: ${CONTAINER_NAME} is running with ephemeral Pantoken root."
