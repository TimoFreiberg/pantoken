#!/usr/bin/env bash
# Fixture 04 — Root user.
#
# Container runs as root (UID 0). Tests the RootExecution risk acknowledgement.
# Uses a persistent bind mount so the only risk surfaced is root, not ephemeral.
#
# Expected pantoken behavior: preflight surfaces RootExecution risk →
# AwaitingAcknowledgement.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-root"
HOST_BIND_SUBDIR="root"

print_header "Fixture 04 — Root user"

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

echo "  setting up base (tools only, no non-root user) ..."
setup_debian_base "${CONTAINER_NAME}" no

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

# Root owns everything; no chown needed.

print_fixture_info \
    "04-root-user" \
    "${CONTAINER_NAME}" \
    "root" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight surfaces RootExecution risk → AwaitingAcknowledgement"

echo "✓ Fixture 04 complete: ${CONTAINER_NAME} is running as root."
