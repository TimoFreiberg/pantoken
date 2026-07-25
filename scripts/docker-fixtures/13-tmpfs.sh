#!/usr/bin/env bash
# Fixture 13 — tmpfs mount (EphemeralTmpfs).
#
# Pantoken root on a tmpfs mount. Tests the EphemeralTmpfs classification
# (ephemeral risk). The preflight classifies the mount as EphemeralTmpfs and
# surfaces the EphemeralData risk.
#
# Expected pantoken behavior: preflight classifies EphemeralTmpfs → surfaces
# EphemeralData risk → AwaitingAcknowledgement.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-tmpfs"

print_header "Fixture 13 — tmpfs mount (EphemeralTmpfs)"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating container ${CONTAINER_NAME} (tmpfs Pantoken root) ..."
# --mount type=tmpfs creates an in-memory tmpfs mount at the target. The mount
# type in docker inspect will be "tmpfs", which persistence_facts classifies as
# EphemeralTmpfs.
docker run -d \
    --name "${CONTAINER_NAME}" \
    --mount "type=tmpfs,target=${PANTOKEN_ROOT}" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up base (tools + user) ..."
setup_debian_base "${CONTAINER_NAME}" yes

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

# tmpfs is owned by root initially; chown to the non-root user.
docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "13-tmpfs" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight classifies EphemeralTmpfs → EphemeralData risk → AwaitingAcknowledgement"

echo "✓ Fixture 13 complete: ${CONTAINER_NAME} is running with a tmpfs Pantoken root."
