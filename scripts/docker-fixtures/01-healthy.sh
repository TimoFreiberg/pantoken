#!/usr/bin/env bash
# Fixture 01 — Healthy happy path.
#
# Running container, non-root user, persistent bind mount, compatible polytoken
# pre-installed. This is the "everything works" baseline.
#
# Expected pantoken behavior: preflight passes, no risks, provisioning finds
# compatible polytoken → connects → Ready.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-healthy"
HOST_BIND_SUBDIR="healthy"

print_header "Fixture 01 — Healthy (happy path)"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating host bind dir ..."
HOST_DIR="$(make_host_bind_dir "${HOST_BIND_SUBDIR}")"

echo "  creating container ${CONTAINER_NAME} ..."
docker run -d \
    --name "${CONTAINER_NAME}" \
    -v "${HOST_DIR}:${PANTOKEN_ROOT}" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up base (tools + user) ..."
setup_debian_base "${CONTAINER_NAME}" yes

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

# Ensure the Pantoken root is owned by the non-root user (the bind mount may
# have created it as root).
docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "01-healthy" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight passes, no risks, polytoken compatible → Ready"

echo "✓ Fixture 01 complete: ${CONTAINER_NAME} is running and healthy."
