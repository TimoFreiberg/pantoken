#!/usr/bin/env bash
# Fixture 03 — Old polytoken (TooOld).
#
# polytoken installed but reports an older version (0.4.2). The probe runs
# `polytoken --version` and parses the version string; the compat checker
# classifies it as TooOld.
#
# Expected pantoken behavior: probe finds 0.4.2 → PolytokenCompat::TooOld.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-old-polytoken"
HOST_BIND_SUBDIR="old-polytoken"

print_header "Fixture 03 — Old polytoken (TooOld)"

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

echo "  installing stub polytoken (too old) ..."
install_stub_polytoken "${CONTAINER_NAME}" "${PANTOKEN_OLD_POLYTOKEN_VERSION}"

docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "03-old-polytoken" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "too-old (${PANTOKEN_OLD_POLYTOKEN_VERSION})" \
    "probe finds ${PANTOKEN_OLD_POLYTOKEN_VERSION} → PolytokenCompat::TooOld"

echo "✓ Fixture 03 complete: ${CONTAINER_NAME} is running with old polytoken."
