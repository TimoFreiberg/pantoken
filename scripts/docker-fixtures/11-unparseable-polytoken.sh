#!/usr/bin/env bash
# Fixture 11 — Unparseable polytoken version.
#
# polytoken installed but its version string is unparseable. The probe's grep
# extracts "01.2.3" (a leading-zero version), but parse_version() in semver.rs
# rejects leading zeros → parse_semver returns false → PolytokenCompat::
# Unparseable{raw:"01.2.3"}.
#
# Expected pantoken behavior: probe finds a version string → classify_compat
# returns Unparseable → reconcile drives Failed(ProvisioningFailed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-unparseable"
HOST_BIND_SUBDIR="unparseable"
# A leading-zero version: the probe grep extracts this, but parse_version
# rejects leading zeros (semver.rs:54-55) → Unparseable.
UNPARSEABLE_VERSION="01.2.3"

print_header "Fixture 11 — Unparseable polytoken version"

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

echo "  installing stub polytoken (unparseable version) ..."
install_stub_polytoken "${CONTAINER_NAME}" "${UNPARSEABLE_VERSION}"

docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

print_fixture_info \
    "11-unparseable-polytoken" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "unparseable (${UNPARSEABLE_VERSION})" \
    "probe finds ${UNPARSEABLE_VERSION} → PolytokenCompat::Unparseable → Failed"

echo "✓ Fixture 11 complete: ${CONTAINER_NAME} is running with unparseable polytoken."
