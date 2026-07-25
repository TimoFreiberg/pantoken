#!/usr/bin/env bash
# Master teardown script — removes all test containers, host temp dirs, and
# Docker volumes created by the fixtures.
#
# Usage: bash scripts/docker-fixtures/teardown-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

print_header "Pantoken Docker Fixtures — Teardown All"

echo "  Removing containers ..."
for name in "${FIXTURE_CONTAINERS[@]}"; do
    if docker rm -f "${name}" >/dev/null 2>&1; then
        echo "    ✓ removed ${name}"
    else
        echo "    — ${name} not found (already removed)"
    fi
done

echo
echo "  Removing Docker volumes ..."
for vol in "${FIXTURE_VOLUMES[@]}"; do
    if docker volume rm "${vol}" >/dev/null 2>&1; then
        echo "    ✓ removed volume ${vol}"
    else
        echo "    — volume ${vol} not found (already removed)"
    fi
done

echo
echo "  Removing host bind dirs ..."
rm -rf /tmp/pantoken-fixtures 2>/dev/null && echo "    ✓ removed /tmp/pantoken-fixtures" || echo "    — /tmp/pantoken-fixtures not found"

echo
echo "  Verifying cleanup ..."
remaining="$(docker ps -a --filter name=pantoken- --format '{{.Names}}' | wc -l | tr -d ' ')"
if [[ "${remaining}" == "0" ]]; then
    echo "  ✓ All pantoken-* containers removed."
else
    echo "  ⚠ ${remaining} pantoken-* containers still remain:"
    docker ps -a --filter name=pantoken- --format '    {{.Names}} ({{.Status}})'
    exit 1
fi

echo
echo "✓ Teardown complete."
