# Root BUCK file for the pantoken Buck2 POC.
# Cargo/pnpm remain authoritative. Buck2 is additive and experimental.
# Archive assembly targets for the Buck2 foundation.
# See docs/buck2-poc-findings.md for the full POC boundary and policy.

# ── Pre-built client-dist (pnpm stays authoritative) ─────────────────────────
# Requires `just build-client` to have been run first. Buck2 consumes the output
# as a file input; it does not invoke pnpm/Vite.

filegroup(
    name = "client_dist",
    srcs = glob(
        [
            "client/dist/index.html",
            "client/dist/assets/**",
            "client/dist/apple-touch-icon*",
            "client/dist/icon*",
            "client/dist/favicon*",
            "client/dist/manifest*",
            "client/dist/sw*",
            "client/dist/registerSW*",
        ],
    ),
    visibility = ["PUBLIC"],
)

# ── VERSION + BUILD_SHA files ────────────────────────────────────────────────
# CI provides real values via --config-file .buckconfig.ci with [pantoken]
# section. read_config() returns the default when no config file is provided,
# so local builds behave exactly as before. The value participates in the
# action cache key automatically (different versions → different cache entries).

genrule(
    name = "version_file",
    out = "VERSION",
    cmd = "echo '%s' > $OUT" % read_config("pantoken", "version", "0.0.0"),
    visibility = ["PUBLIC"],
)

genrule(
    name = "build_sha_file",
    out = "BUILD_SHA",
    cmd = "echo '%s' > $OUT" % read_config("pantoken", "build_sha", "0000000000000000000000000000000000000000"),
    visibility = ["PUBLIC"],
)

# ── Deploy scripts ───────────────────────────────────────────────────────────

export_file(
    name = "run_sh",
    src = "deploy/run.sh",
    visibility = ["PUBLIC"],
)

export_file(
    name = "update_headless_sh",
    src = "deploy/update-headless.sh",
    visibility = ["PUBLIC"],
)

# ── Deterministic unsigned headless archive ────────────────────────────────
# Uses a Python-based assembler for deterministic tar.gz with:
#   - sorted paths, fixed mtime (epoch 0), uid/gid (0/0), uname/gname (root/root)
#   - fixed modes (0755 for executables, 0644 for files)
#   - deterministic gzip header (no timestamp, no filename, compression level 9)
#
# Layout matches the real release artifact: flat root (no package_dir).
#   VERSION, BUILD_SHA, bin/pantoken-server, bin/pantoken-tar-validate,
#   run.sh, update.sh, client-dist/index.html, client-dist/assets/*

genrule(
    name = "pantoken_headless_unsigned",
    out = "pantoken-headless-unsigned.tar.gz",
    srcs = [
        "//server-rs/pantoken-server:pantoken_server",
        "//server-rs/pantoken-tar-validate:pantoken_tar_validate",
        ":run_sh",
        ":update_headless_sh",
        ":version_file",
        ":build_sha_file",
        ":client_dist",
        "//scripts/buck2:stage_payload_sh",
        "//scripts/buck2:assemble_archive_py",
    ],
    cmd = "bash $(location //scripts/buck2:stage_payload_sh) $TMP/staging && python3 $(location //scripts/buck2:assemble_archive_py) $OUT $TMP/staging",
    env = {
        "PANTOKEN_SERVER_BIN": "$(location //server-rs/pantoken-server:pantoken_server)",
        "PANTOKEN_TAR_VALIDATE_BIN": "$(location //server-rs/pantoken-tar-validate:pantoken_tar_validate)",
        "RUN_SH": "$(location :run_sh)",
        "UPDATE_HEADLESS_SH": "$(location :update_headless_sh)",
        "VERSION_FILE": "$(location :version_file)",
        "BUILD_SHA_FILE": "$(location :build_sha_file)",
        "CLIENT_DIST_DIR": "$(location :client_dist)",
    },
    visibility = ["PUBLIC"],
)

# ── Validation sh_test ───────────────────────────────────────────────────────
# Uses the Buck2-built pantoken-tar-validate binary explicitly.
# HOME and PANTOKEN_TAR_VALIDATOR are NOT set — no ambient host state
# can make this pass.

sh_test(
    name = "validate_headless_archive",
    test = "//scripts/buck2:validate_archive_sh",
    args = [
        "$(location //server-rs/pantoken-tar-validate:pantoken_tar_validate)",
        "$(location :pantoken_headless_unsigned)",
    ],
    resources = [
        ":pantoken_headless_unsigned",
        "//server-rs/pantoken-tar-validate:pantoken_tar_validate",
    ],
    env = {
        "HOME": "",
        "PANTOKEN_TAR_VALIDATOR": "",
    },
    visibility = ["PUBLIC"],
)
