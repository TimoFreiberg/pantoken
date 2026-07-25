#!/usr/bin/env bash
# Fixture 07 — Stopped container.
#
# Container exists but is stopped (exited state). Tests the
# ContainerUnavailable error path. pantoken resolves by exact name and requires
# the container to be in "running" state; an exited container yields
# ContainerUnavailable("exited").
#
# Expected pantoken behavior: resolve_exact_running returns
# ContainerUnavailable("exited").

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONTAINER_NAME="pantoken-stopped"

print_header "Fixture 07 — Stopped container"

echo "  ensuring base image ..."
ensure_image "${BASE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating container ${CONTAINER_NAME} (then stopping it) ..."
# Create the container, then immediately stop it so it's in "exited" state.
# We don't need tools/polytoken — the failure happens before probing.
docker run -d \
    --name "${CONTAINER_NAME}" \
    "${BASE_IMAGE}" \
    sleep infinity >/dev/null

docker stop "${CONTAINER_NAME}" >/dev/null

container_state="$(docker inspect -f '{{.State.Status}}' "${CONTAINER_NAME}")"

echo
echo "  ── Fixture: 07-stopped ──"
echo "  Container name : ${CONTAINER_NAME}"
echo "  State          : ${container_state} (expected: exited)"
echo "  Expected       : resolve_exact_running returns ContainerUnavailable(\"exited\")"
echo
echo "  In the pantoken profile, set:"
echo "    SSH host       : <your-server>  (e.g. user@server-ip)"
echo "    Container name : ${CONTAINER_NAME}  (must match exactly)"
echo "    User           : ${PANTOKEN_USER}  (doesn't matter — fails before user check)"
echo "    Pantoken root  : ${PANTOKEN_ROOT}  (doesn't matter — fails before root check)"
echo

echo "✓ Fixture 07 complete: ${CONTAINER_NAME} is stopped (state: ${container_state})."
