#!/usr/bin/env bash
# In-container base setup helper.
#
# Prepares a debian:bookworm-slim (or alpine) container with the tools and
# non-root user the healthy fixtures need. Each fixture sources common.sh then
# calls the appropriate setup function.
#
# Usage (from a fixture script that has already sourced common.sh):
#   source "$(common_lib_dir)/setup-container-base.sh"
#   setup_debian_base <container_name> <create_user: yes|no>
#   setup_alpine_base <container_name>

set -euo pipefail

# ---------------------------------------------------------------------------
# Debian (glibc) base
# ---------------------------------------------------------------------------

# Install the tools the probe checks for, create the non-root user, and prepare
# the Pantoken root directory. create_user=yes creates the pantoken user;
# create_user=no skips user creation (for the root-user fixture).
setup_debian_base() {
    local container="$1"
    local create_user="${2:-yes}"

    echo "  apt-get update ..."
    # apt can emit progress noise; silence it.
    docker exec "${container}" apt-get update -qq >/dev/null

    # sha256sum is in coreutils (already present in debian:bookworm-slim), but we
    # install the full coreutils package explicitly to be safe. tar + curl are
    # needed by the probe and the polytoken installer. unzip makes the probe
    # report tools.unzip=true (a realistic fully-provisioned container).
    echo "  installing tools (tar, curl, coreutils, unzip) ..."
    docker exec "${container}" apt-get install -y -qq tar curl coreutils unzip >/dev/null

    if [[ "${create_user}" == "yes" ]]; then
        echo "  creating non-root user '${PANTOKEN_USER}' (UID ${PANTOKEN_UID}) ..."
        # Remove any existing user/home, then recreate deterministically.
        docker exec "${container}" sh -c \
            "id '${PANTOKEN_USER}' 2>/dev/null && userdel -r '${PANTOKEN_USER}' 2>/dev/null || true"
        docker exec "${container}" useradd -m -u "${PANTOKEN_UID}" "${PANTOKEN_USER}"
    fi

    # The Pantoken root dir is created + owned here for bind-mount fixtures where
    # the host dir is owned by the host user (root on the host). For bind mounts,
    # the mount overlays this — but chown makes the non-mount path work too.
    # These may fail on read-only mounts (fixture 10); tolerate that.
    echo "  preparing Pantoken root at ${PANTOKEN_ROOT} ..."
    docker exec "${container}" mkdir -p "${PANTOKEN_ROOT}" 2>/dev/null || true
    if [[ "${create_user}" == "yes" ]]; then
        docker exec "${container}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# Alpine (musl) base — used by the unsupported-target fixture.
# ---------------------------------------------------------------------------

setup_alpine_base() {
    local container="$1"

    echo "  apk update + install tools ..."
    docker exec "${container}" apk add --no-cache -q tar curl unzip coreutils >/dev/null

    echo "  creating non-root user '${PANTOKEN_USER}' (UID ${PANTOKEN_UID}) ..."
    # adduser on alpine: -D = don't assign a password, -u = uid, -G = group.
    docker exec "${container}" sh -c \
        "id '${PANTOKEN_USER}' 2>/dev/null && deluser '${PANTOKEN_USER}' 2>/dev/null || true"
    docker exec "${container}" adduser -D -u "${PANTOKEN_UID}" "${PANTOKEN_USER}"

    echo "  preparing Pantoken root at ${PANTOKEN_ROOT} ..."
    docker exec "${container}" mkdir -p "${PANTOKEN_ROOT}"
    docker exec "${container}" chown "${PANTOKEN_USER}:${PANTOKEN_USER}" "${PANTOKEN_ROOT}"
}
