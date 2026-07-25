#!/usr/bin/env bash
# polytoken install helper.
#
# Installs a real polytoken binary inside a running container, OR writes a fake
# `polytoken` stub script that prints a given version string (for the too-old
# and unparseable fixtures — the probe only runs `polytoken --version` and
# parses the output; it does not invoke the daemon).
#
# Usage (from a fixture script that has already sourced common.sh):
#   source "$(common_lib_dir)/install-polytoken.sh"
#   install_real_polytoken <container_name>
#   install_stub_polytoken <container_name> <version_string>
#
# The real install downloads the official release archive + SHA256SUMS for the
# target version, verifies the checksum, and extracts into the container. The URL
# pattern matches desktop/src/provisioning/polytoken_install.rs:resolve_artifact_urls().

set -euo pipefail

# ---------------------------------------------------------------------------
# Real polytoken binary install
# ---------------------------------------------------------------------------

# Install the real polytoken binary at /usr/local/bin/polytoken inside a running
# container. Downloads to a host temp dir, verifies SHA256, then docker cp's +
# extracts inside the container.
install_real_polytoken() {
    local container="$1"
    local version="${PANTOKEN_POLYTOKEN_VERSION}"

    echo "  installing real polytoken ${version} into ${container} ..."

    # The feature only supports x86_64-unknown-linux-gnu for the helper artifact
    # (see probe.rs:target_triple). Detect the container arch to choose the
    # right download, but warn if it's not amd64.
    local arch
    arch="$(docker exec "${container}" uname -m)"
    local dl_platform dl_arch
    case "${arch}" in
        x86_64)
            dl_platform="linux"
            dl_arch="amd64"
            ;;
        aarch64|arm64)
            # Note: the pantoken feature classifies aarch64/glibc as
            # UnsupportedTarget at probe time (no published artifact). We still
            # attempt the install for completeness, but the fixture will fail at
            # the provisioning step on arm64. The README documents this.
            dl_platform="linux"
            dl_arch="arm64"
            echo "  WARNING: container arch is ${arch}; the pantoken feature only"
            echo "           supports x86_64-unknown-linux-gnu. Use --platform"
            echo "           linux/amd64 if you need the healthy path to pass."
            ;;
        *)
            die "unexpected container arch '${arch}' in ${container}"
            ;;
    esac

    # Channel: prerelease (version contains '-') → unstable, else stable.
    # Matches channel_for_version() in polytoken_install.rs.
    local base
    if [[ "${version}" == *-* ]]; then
        base="https://dl.polytoken.dev/unstable/${version}"
    else
        base="https://dl.polytoken.dev/${version}"
    fi

    local archive_url="${base}/${dl_platform}-${dl_arch}/polytoken.tar.gz"
    local checksums_url="${base}/SHA256SUMS.${dl_platform}"
    local archive_filename="polytoken-${dl_platform}-${dl_arch}.tar.gz"

    # Download to a host temp dir.
    local work_dir
    work_dir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '${work_dir}'" EXIT

    echo "    downloading ${archive_url} ..."
    if ! curl -fsSL "${archive_url}" -o "${work_dir}/${archive_filename}"; then
        die "failed to download polytoken archive from ${archive_url}"
    fi

    echo "    downloading ${checksums_url} ..."
    if ! curl -fsSL "${checksums_url}" -o "${work_dir}/SHA256SUMS"; then
        die "failed to download SHA256SUMS from ${checksums_url}"
    fi

    # Verify the checksum. find_checksum_in_sums() in polytoken_install.rs matches
    # on the basename of the entry. The sums file format is "<hash>  <filename>".
    # Use exact string match (not regex) to avoid `.` matching any character.
    local expected_hash
    expected_hash="$(awk -v fname="${archive_filename}" '
        { entry=$2; n=split(entry,parts,"/"); base=parts[n] }
        base == fname { print $1; exit }
    ' "${work_dir}/SHA256SUMS")"
    if [[ -z "${expected_hash}" ]]; then
        die "checksum for ${archive_filename} not found in SHA256SUMS"
    fi
    expected_hash="$(echo "${expected_hash}" | tr '[:upper:]' '[:lower:]')"

    local actual_hash
    actual_hash="$(sha256sum "${work_dir}/${archive_filename}" | awk '{print $1}')"
    if [[ "${actual_hash}" != "${expected_hash}" ]]; then
        die "SHA256 mismatch: expected ${expected_hash}, got ${actual_hash}"
    fi
    echo "    checksum verified: ${actual_hash}"

    # Copy the archive into the container and extract.
    docker cp "${work_dir}/${archive_filename}" "${container}:/tmp/${archive_filename}"

    # Extract to a staging dir, then move the binary into /usr/local/bin.
    docker exec "${container}" sh -c "
        set -e
        rm -rf /tmp/polytoken-staging
        mkdir -p /tmp/polytoken-staging
        tar xzf /tmp/${archive_filename} -C /tmp/polytoken-staging
        # The archive may contain the binary at the top level or in a subdir.
        bin=\$(find /tmp/polytoken-staging -type f -name polytoken | head -1)
        test -n \"\${bin}\"
        chmod +x \"\${bin}\"
        mkdir -p /usr/local/bin
        mv -f \"\${bin}\" /usr/local/bin/polytoken
        rm -rf /tmp/polytoken-staging /tmp/${archive_filename}
    "

    # Verify the install.
    local installed_version
    installed_version="$(docker exec "${container}" polytoken --version 2>/dev/null | head -1 || echo '')"
    echo "    installed: ${installed_version}"
    if [[ "${installed_version}" != *"${version}"* ]]; then
        die "installed polytoken version '${installed_version}' does not contain '${version}'"
    fi
    echo "  polytoken ${version} installed at /usr/local/bin/polytoken in ${container}"
}

# ---------------------------------------------------------------------------
# Stub polytoken install (for too-old / unparseable fixtures)
# ---------------------------------------------------------------------------

# Write a fake `polytoken` script at /usr/local/bin/polytoken inside the
# container that prints the given version string. The probe only runs
# `polytoken --version` and parses the output — it never invokes the daemon.
install_stub_polytoken() {
    local container="$1"
    local version_string="$2"

    echo "  installing stub polytoken (prints '${version_string}') into ${container} ..."

    # Write the stub via stdin to avoid nested heredoc quoting issues.
    # The probe only runs `polytoken --version` and parses the output — it
    # never invokes the daemon, so a stub that echoes a version is sufficient.
    printf '#!/bin/sh\necho "polytoken %s"\n' "${version_string}" \
        | docker exec -i "${container}" sh -c 'cat > /usr/local/bin/polytoken && chmod +x /usr/local/bin/polytoken'

    # Verify.
    local printed
    printed="$(docker exec "${container}" polytoken --version 2>/dev/null | head -1 || echo '')"
    echo "    stub prints: ${printed}"
    echo "  stub polytoken installed in ${container}"
}
