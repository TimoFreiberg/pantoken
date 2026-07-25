#!/usr/bin/env bash
# Master setup script — runs all 13 fixtures in sequence.
#
# Usage: bash scripts/docker-fixtures/setup-all.sh
#
# Creates all test containers on this server. Prints a summary table at the
# end listing each container name, its state, and the pantoken profile fields.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

print_header "Pantoken Docker Fixtures — Setup All"

echo "  This script creates 13 test containers for manual test-driving"
echo "  of the pantoken remote-container connection feature."
echo

# Detect host architecture and warn if not x86_64.
host_arch="$(uname -m)"
if [[ "${host_arch}" != "x86_64" ]]; then
    echo "  WARNING: host architecture is ${host_arch}, not x86_64."
    echo "           The healthy/provisioning fixtures require x86_64 because the"
    echo "           pantoken feature only supports x86_64-unknown-linux-gnu."
    echo "           On arm64, use: docker run --platform linux/amd64 ... (emulation)"
    echo
fi

# All fixture scripts, in order.
FIXTURES=(
    "01-healthy.sh"
    "02-missing-polytoken.sh"
    "03-old-polytoken.sh"
    "04-root-user.sh"
    "05-ephemeral.sh"
    "06-docker-socket.sh"
    "07-stopped.sh"
    "08-musl-unsupported.sh"
    "09-missing-tools.sh"
    "10-read-only-mount.sh"
    "11-unparseable-polytoken.sh"
    "12-named-volume.sh"
    "13-tmpfs.sh"
)

failed=()
for fixture in "${FIXTURES[@]}"; do
    script="${SCRIPT_DIR}/${fixture}"
    if [[ ! -x "${script}" && ! -f "${script}" ]]; then
        echo "  MISSING: ${fixture}" >&2
        failed+=("${fixture}")
        continue
    fi
    if bash "${script}"; then
        :
    else
        echo "  FAILED: ${fixture}" >&2
        failed+=("${fixture}")
    fi
done

# ---------------------------------------------------------------------------
# Summary table
# ---------------------------------------------------------------------------

print_header "Setup Summary"

printf "  %-30s %-12s %-12s %-22s %s\n" \
    "CONTAINER" "STATE" "USER" "POLYTOKEN" "EXPECTED BEHAVIOR"
printf "  %-30s %-12s %-12s %-22s %s\n" \
    "--------" "-----" "----" "---------" "-----------------"

# Helper to print a summary row for a container.
summary_row() {
    local name="$1"
    local user="$2"
    local polytoken="$3"
    local expected="$4"
    local state
    state="$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null || echo 'missing')"
    printf "  %-30s %-12s %-12s %-22s %s\n" \
        "${name}" "${state}" "${user}" "${polytoken}" "${expected}"
}

summary_row "pantoken-healthy"         "pantoken" "compatible"            "Ready"
summary_row "pantoken-no-polytoken"   "pantoken" "missing"               "PolytokenCompat::Missing"
summary_row "pantoken-old-polytoken"  "pantoken" "too-old (0.4.2)"       "PolytokenCompat::TooOld"
summary_row "pantoken-root"           "root"     "compatible"            "RootExecution risk → AwaitingAck"
summary_row "pantoken-ephemeral"     "pantoken" "compatible"            "EphemeralData risk → AwaitingAck"
summary_row "pantoken-docker-socket"  "pantoken" "compatible"            "DockerSocket risk → AwaitingAck"
summary_row "pantoken-stopped"        "—"        "—"                     "ContainerUnavailable(exited)"
summary_row "pantoken-musl"           "pantoken" "compatible"            "UnsupportedTarget → Failed"
summary_row "pantoken-no-tools"      "pantoken" "compatible"            "probe tools missing → fail"
summary_row "pantoken-readonly"       "pantoken" "compatible"            "read-only: identity probe fails → preflight fail"
summary_row "pantoken-unparseable"    "pantoken" "unparseable (01.2.3)"  "Unparseable → Failed"
summary_row "pantoken-named-volume"   "pantoken" "compatible"            "PersistentVolume → Ready"
summary_row "pantoken-tmpfs"          "pantoken" "compatible"            "EphemeralTmpfs → AwaitingAck"

echo
if [[ ${#failed[@]} -gt 0 ]]; then
    echo "  ⚠ ${#failed[@]} fixture(s) failed: ${failed[*]}"
    echo
    echo "  Containers that succeeded are still running. Fix the failures and"
    echo "  re-run the individual fixture scripts (they are idempotent)."
    exit 1
fi

echo "  ✓ All 13 fixtures created successfully."
echo
echo "  Next: point pantoken's SSH destination at this server and create"
echo "  profiles with the container names above. See README.md for details."
