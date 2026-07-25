#!/usr/bin/env bash
# Fixture 10 — Read-only mount.
#
# Pantoken root on a read-only bind mount. Tests the ReadOnlyMount hard error.
# persistence_facts() returns DockerTargetError::ReadOnlyMount when the deepest
# covering mount has read_write=false.
#
# Expected pantoken behavior: persistence_facts returns ReadOnlyMount error →
# preflight fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-readonly"
HOST_BIND_SUBDIR="readonly"

print_header "Fixture 10 — Read-only mount"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating host bind dir ..."
HOST_DIR="$(make_host_bind_dir "${HOST_BIND_SUBDIR}")"

echo "  creating container ${CONTAINER_NAME} (read-only Pantoken root) ..."
# The ':ro' suffix makes the bind mount read-only. The mount will have
# read_write=false in docker inspect, which persistence_facts classifies as
# ReadOnlyMount.
docker run -d \
    --name "${CONTAINER_NAME}" \
    -v "${HOST_DIR}:${PANTOKEN_ROOT}:ro" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up base (tools + user) ..."
setup_debian_base "${CONTAINER_NAME}" yes

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}" 2>/dev/null || true

print_fixture_info \
    "10-read-only-mount" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "read-only mount: identity probe test -w fails (CheckingUserPermissions) before persistence_facts → preflight fails"

echo "✓ Fixture 10 complete: ${CONTAINER_NAME} is running with a read-only Pantoken root."
