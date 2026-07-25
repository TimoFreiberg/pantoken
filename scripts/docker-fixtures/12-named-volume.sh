#!/usr/bin/env bash
# Fixture 12 — Named volume (PersistentVolume).
#
# Pantoken root on a Docker named volume. Tests the PersistentVolume
# classification (safe, no risk). The preflight classifies the mount as
# PersistentVolume and proceeds without surfacing any risk.
#
# Expected pantoken behavior: preflight classifies as PersistentVolume (no risk),
# provisioning proceeds → Ready.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-named-volume"
VOLUME_NAME="pantoken-vol-12"

print_header "Fixture 12 — Named volume (PersistentVolume)"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  removing any existing volume ..."
docker volume rm "${VOLUME_NAME}" >/dev/null 2>&1 || true

echo "  creating named volume ${VOLUME_NAME} ..."
docker volume create "${VOLUME_NAME}" >/dev/null

echo "  creating container ${CONTAINER_NAME} ..."
docker run -d \
    --name "${CONTAINER_NAME}" \
    --mount "type=volume,source=${VOLUME_NAME},target=${PANTOKEN_ROOT}" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up base (tools + user) ..."
setup_debian_base "${CONTAINER_NAME}" yes

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

# The named volume is initially owned by root; chown to the non-root user so
# the identity probe (writability check) passes.
docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "12-named-volume" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight classifies PersistentVolume (no risk) → provisioning → Ready"

echo "✓ Fixture 12 complete: ${CONTAINER_NAME} is running with a named volume."
