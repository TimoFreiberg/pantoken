#!/usr/bin/env bash
# Common helpers for the pantoken Docker fixture scripts.
# shellcheck disable=SC2034 # file-level: constants below are used by scripts that source this file; shellcheck analyzes each file in isolation so it can't see those uses.
#
# Sourced by every fixture script. Provides shared constants and helpers for
# idempotent container creation, image pulling, and success reporting.
#
# These scripts run on a bare Linux server (the SSH host pantoken connects to),
# so they depend only on `docker` + coreutils — no bun/node.

set -euo pipefail

# ---------------------------------------------------------------------------

# The polytoken daemon version pantoken is codegen'd against. The compatible
# fixtures install this exact version; the too-old fixture installs an older one.
PANTOKEN_POLYTOKEN_VERSION="0.5.0-unstable.9"

# An older plausible version the compat checker classifies as TooOld.
PANTOKEN_OLD_POLYTOKEN_VERSION="0.4.2"

# Base image for the glibc fixtures: x86_64, glibc, has apt for installing tools.
BASE_IMAGE="debian:bookworm-slim"

# Base image for the musl (unsupported) fixture.
ALPINE_IMAGE="alpine:latest"

# The canonical Pantoken root path used across fixtures.
PANTOKEN_ROOT="/var/lib/pantoken"

# The non-root user the healthy fixtures create.
PANTOKEN_USER="pantoken"
PANTOKEN_UID=1000

# All container names created by the fixtures (used by setup-all / teardown-all).
FIXTURE_CONTAINERS=(
    pantoken-healthy
    pantoken-no-polytoken
    pantoken-old-polytoken
    pantoken-root
    pantoken-ephemeral
    pantoken-docker-socket
    pantoken-stopped
    pantoken-musl
    pantoken-no-tools
    pantoken-readonly
    pantoken-unparseable
    pantoken-named-volume
    pantoken-tmpfs
)

# Docker volumes created by the fixtures (used by teardown-all).
FIXTURE_VOLUMES=(
    pantoken-vol-12
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Resolve the directory of this script (the lib/ dir), so callers can locate
# sibling helpers regardless of the CWD they're invoked from.
common_lib_dir() {
    local source
    # shellcheck disable=SC1091,SC2317
    source="${BASH_SOURCE[0]}"
    local dir
    dir="$(cd "$(dirname "${source}")" && pwd)"
    echo "${dir}"
}

# Root of the docker-fixtures directory (parent of lib/).
fixtures_root() {
    local lib_dir
    lib_dir="$(common_lib_dir)"
    local root
    root="$(cd "${lib_dir}/.." && pwd)"
    echo "${root}"
}

# Print a section header so the operator can see which fixture is running.
print_header() {
    local title="$1"
    echo
    echo "================================================================"
    echo "  ${title}"
    echo "================================================================"
}

# Ensure a Docker image is present locally; pull if missing.
ensure_image() {
    local image="$1"
    if ! docker image inspect "${image}" >/dev/null 2>&1; then
        echo "  pulling ${image} ..."
        docker pull "${image}" >/dev/null
    fi
}

# Remove a container if it exists (idempotent teardown before create).
remove_container() {
    local name="$1"
    docker rm -f "${name}" >/dev/null 2>&1 || true
}

# Create a fresh host temp dir for a bind mount and register it for cleanup.
# Emits the absolute path on stdout. The dir is created under /tmp so it works
# on any Linux host. Each fixture names its own subdir so teardown can find it.
make_host_bind_dir() {
    local subdir="$1"
    local dir="/tmp/pantoken-fixtures/${subdir}"
    rm -rf "${dir}"
    mkdir -p "${dir}"
    echo "${dir}"
}

# Remove a host bind dir created by make_host_bind_dir.
remove_host_bind_dir() {
    local subdir="$1"
    local dir="/tmp/pantoken-fixtures/${subdir}"
    rm -rf "${dir}" 2>/dev/null || true
}

# Print the fixture summary the operator reads to know what to enter in the
# pantoken profile. Arguments:
#   $1 fixture name (short label)
#   $2 container name (exact — pantoken resolves by exact equality)
#   $3 user (docker --user value)
#   $4 pantoken root path
#   $5 polytoken state (compatible / missing / too-old / unparseable / n/a)
#   $6 expected pantoken behavior
print_fixture_info() {
    local fixture="$1"
    local container="$2"
    local user="$3"
    local root="$4"
    local polytoken_state="$5"
    local expected="$6"
    echo
    echo "  ── Fixture: ${fixture} ──"
    echo "  Container name : ${container}"
    echo "  User           : ${user}"
    echo "  Pantoken root  : ${root}"
    echo "  polytoken state: ${polytoken_state}"
    echo "  Expected       : ${expected}"
    echo
    echo "  In the pantoken profile, set:"
    echo "    SSH host       : <your-server>  (e.g. user@server-ip)"
    echo "    Container name : ${container}  (must match exactly)"
    echo "    User           : ${user}"
    echo "    Pantoken root  : ${root}"
    echo
}

# Die with a clear error message.
die() {
    echo "ERROR: $*" >&2
    exit 1
}
