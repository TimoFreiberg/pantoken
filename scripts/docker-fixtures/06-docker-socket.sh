#!/usr/bin/env bash
# Fixture 06 — Docker socket exposed.
#
# Container has /var/run/docker.sock bind-mounted. Tests the DockerSocket risk
# acknowledgement. Uses a persistent bind mount for the Pantoken root so the
# only additional risk surfaced is the socket, not ephemeral.
#
# Expected pantoken behavior: preflight surfaces DockerSocket risk →
# AwaitingAcknowledgement.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-docker-socket"
HOST_BIND_SUBDIR="docker-socket"

print_header "Fixture 06 — Docker socket exposed"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating host bind dir ..."
HOST_DIR="$(make_host_bind_dir "${HOST_BIND_SUBDIR}")"

# Check the Docker socket exists on the host before attempting the mount.
SOCKET_PATH="/var/run/docker.sock"
SOCKET_MOUNT_ARGS=()
if [[ -S "${SOCKET_PATH}" ]]; then
    echo "  Docker socket found at ${SOCKET_PATH} — will bind-mount it."
    SOCKET_MOUNT_ARGS+=(-v "${SOCKET_PATH}:/var/run/docker.sock")
else
    echo "  WARNING: ${SOCKET_PATH} not found on this host."
    echo "           The Docker socket risk won't be triggerable without it."
    echo "           Creating the container anyway (it will still run)."
fi

echo "  creating container ${CONTAINER_NAME} ..."
docker run -d \
    --name "${CONTAINER_NAME}" \
    -v "${HOST_DIR}:${PANTOKEN_ROOT}" \
    "${SOCKET_MOUNT_ARGS[@]}" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up base (tools + user) ..."
setup_debian_base "${CONTAINER_NAME}" yes

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "06-docker-socket" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight surfaces DockerSocket risk → AwaitingAcknowledgement"

echo "✓ Fixture 06 complete: ${CONTAINER_NAME} is running with the Docker socket mounted."
