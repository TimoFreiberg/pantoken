#!/usr/bin/env bash
# Fixture 08 — musl libc (UnsupportedTarget).
#
# Alpine-based container (musl libc). The preflight passes cleanly (running
# container, persistent bind mount, user resolves, root writable), but the
# provisioning reconcile step runs PROBE_SCRIPT which detects libc=musl →
# target_triple() returns Err(UnsupportedTarget) → ReconcileOutcome::
# UnsupportedTarget → ConnectionState::Failed(ProvisioningFailed).
#
# The failure occurs at the provisioning reconcile step, NOT at preflight.
#
# Expected pantoken behavior: preflight passes → provisioning reconcile detects
# musl → UnsupportedTarget → Failed(ProvisioningFailed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/setup-container-base.sh
source "${SCRIPT_DIR}/lib/setup-container-base.sh"
# shellcheck source=lib/install-polytoken.sh
source "${SCRIPT_DIR}/lib/install-polytoken.sh"

CONTAINER_NAME="pantoken-musl"
HOST_BIND_SUBDIR="musl"

print_header "Fixture 08 — musl libc (UnsupportedTarget)"

echo "  ensuring alpine image ..."
ensure_image "${ALPINE_IMAGE}"

echo "  removing any existing container ..."
remove_container "${CONTAINER_NAME}"

echo "  creating host bind dir ..."
HOST_DIR="$(make_host_bind_dir "${HOST_BIND_SUBDIR}")"

echo "  creating container ${CONTAINER_NAME} (alpine) ..."
docker run -d \
    --name "${CONTAINER_NAME}" \
    -v "${HOST_DIR}:${PANTOKEN_ROOT}" \
    "${ALPINE_IMAGE}" \
    sleep infinity >/dev/null

echo "  setting up alpine base (tools + user) ..."
setup_alpine_base "${CONTAINER_NAME}"

echo "  installing polytoken ..."
install_real_polytoken "${CONTAINER_NAME}"

docker exec "${CONTAINER_NAME}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"

# Confirm musl is detected.
libc_line="$(docker exec "${CONTAINER_NAME}" sh -c 'ldd --version 2>&1 | head -1')"
echo "  ldd --version: ${libc_line}"

print_fixture_info \
    "08-musl-unsupported" \
    "${CONTAINER_NAME}" \
    "${PANTOKEN_USER}" \
    "${PANTOKEN_ROOT}" \
    "compatible (${PANTOKEN_POLYTOKEN_VERSION})" \
    "preflight passes → provisioning detects musl → UnsupportedTarget → Failed"

echo "✓ Fixture 08 complete: ${CONTAINER_NAME} is running (musl libc)."
