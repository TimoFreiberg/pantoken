#!/usr/bin/env bash
# Fixture 09 — Missing tools.
#
# Minimal debian container with only sh, mkdir, cat — no tar, no curl, no
# sha256sum. Tests provisioning failure due to missing extraction/checksum
# tools. The probe reports tools.tar=false, tools.curl=false,
# tools.sha256sum=false.
#
# Expected pantoken behavior: probe reports missing tools → provisioning may
# fail at extraction (no tar to extract the polytoken archive).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-no-tools"
HOST_BIND_SUBDIR="no-tools"

print_header "Fixture 09 — Missing tools"

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

# Intentionally do NOT run setup_debian_base — we want a minimal container.
# debian:bookworm-slim has sh, mkdir, cat, coreutils (sha256sum) but NOT tar or
# curl. To make the "missing tools" scenario unambiguous, we remove tar,
# curl, and sha256sum explicitly.
echo "  stripping tools (tar, curl, sha256sum) to simulate a minimal image ..."
docker exec "${CONTAINER_NAME}" apt-get update -qq >/dev/null
# Install curl temporarily so we can install polytoken, then remove all three.
docker exec "${CONTAINER_NAME}" apt-get install -y -qq curl >/dev/null

echo "  installing polytoken (curl present temporarily) ..."
install_real_polytoken "${CONTAINER_NAME}"

echo "  creating non-root user ${PANTOKEN_USER} ..."
docker exec "${CONTAINER_NAME}" useradd -m -u "${PANTOKEN_UID}" "${PANTOKEN_USER}" 2>/dev/null || true
docker exec "${CONTAINER_NAME}" mkdir -p "${PANTOKEN_ROOT}"
docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

# Now remove the specific tools the probe checks for, so the container reports
# them missing. We remove only the individual binaries (not the whole coreutils
# package — purging coreutils would also remove tr, head, basename, etc. that
# the PROBE_SCRIPT itself uses internally, causing it to fail mid-execution).
echo "  removing tar, curl, sha256sum binaries ..."
docker exec "${CONTAINER_NAME}" sh -c \
    'rm -f /usr/bin/tar /bin/tar /usr/bin/curl /bin/curl /usr/bin/sha256sum /bin/sha256sum 2>/dev/null || true'

print_fixture_info \
    "09-missing-tools" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "probe reports tools.tar=false, tools.curl=false, tools.sha256sum=false → provisioning failure"

echo "✓ Fixture 09 complete: ${CONTAINER_NAME} is running with missing tools."
