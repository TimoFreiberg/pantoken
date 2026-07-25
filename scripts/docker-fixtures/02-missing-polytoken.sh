#!/usr/bin/env bash
# Fixture 02 — Missing polytoken.
#
# Same as healthy but no polytoken binary installed. Tests the Missing compat
# state and the install-offer flow (OfferInstall) or failure (RequireExisting).
#
# Expected pantoken behavior: probe finds no polytoken → PolytokenCompat::Missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"

CONTAINER_NAME="pantoken-no-polytoken"
HOST_BIND_SUBDIR="no-polytoken"

print_header "Fixture 02 — Missing polytoken"

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

# Explicitly ensure NO polytoken binary exists.
docker exec "${CONTAINER_NAME}" rm -f /usr/local/bin/polytoken /usr/bin/polytoken 2>/dev/null || true

docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "02-missing-polytoken" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "missing (no binary)" \
    "probe finds no polytoken → PolytokenCompat::Missing"

echo "✓ Fixture 02 complete: ${CONTAINER_NAME} is running with no polytoken."
