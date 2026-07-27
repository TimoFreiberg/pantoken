# Pantoken Docker Fixture Scripts

Self-contained bash scripts that spin up Docker containers in every state the
pantoken remote-container connection feature needs to exercise during manual
test-driving.

## What These Are For

The pantoken desktop app connects to remote Docker containers over SSH. It
discovers a container by exact name, inspects it, probes its OS/arch/libc/tools
+ polytoken version, classifies persistence of the Pantoken root mount, surfaces
risk acknowledgements (root / ephemeral / docker-socket), and then provisions +
launches the pantoken-server stdio proxy inside the container via `docker exec`.

These fixtures create containers in each of the states that flow exercises, so
you can test-drive the full connection lifecycle without hand-crafting Docker
setups.

## Prerequisites

1. **Docker** installed and running on the server machine.
2. **SSH access** to that server (pantoken connects over SSH using
   `BatchMode=yes`, so your key must be loaded in an agent — no password
   prompts).
3. The **SSH user must be in the `docker` group** (or otherwise have permission
   to run `docker` commands without `sudo`).
4. **x86_64 host** — the pantoken feature only supports
   `x86_64-unknown-linux-gnu` for the helper artifact. The musl/unsupported
   fixtures work on arm64, but the healthy/provisioning fixtures require x86_64
   (or `--platform linux/amd64` emulation).

## Quick Start

On the remote server:

```bash
# Create all 13 fixtures
just docker-fixtures-setup

# Verify
docker ps -a --filter name=pantoken-
```

Then in the pantoken desktop app, create a profile pointing at this server:

| Field | Value |
|-------|-------|
| SSH destination | `user@server-ip` |
| Container name | *(exact name from the table below)* |
| User | *(from the table)* |
| Pantoken root | `/var/lib/pantoken` |

When done:

```bash
just docker-fixtures-teardown
```

## Fixture Reference

Each fixture is independently runnable and idempotent (tears down + recreates):
`bash scripts/docker-fixtures/01-healthy.sh` (individual fixtures remain direct helpers)

| # | Script | Container name | User | polytoken | Expected pantoken behavior |
|---|--------|---------------|------|-----------|---------------------------|
| 01 | `01-healthy.sh` | `pantoken-healthy` | `pantoken` | compatible `0.5.0-unstable.9` | Preflight passes, no risks → **Ready** |
| 02 | `02-missing-polytoken.sh` | `pantoken-no-polytoken` | `pantoken` | missing | `PolytokenCompat::Missing` — install-offer flow |
| 03 | `03-old-polytoken.sh` | `pantoken-old-polytoken` | `pantoken` | too-old `0.4.2` | `PolytokenCompat::TooOld` |
| 04 | `04-root-user.sh` | `pantoken-root` | `root` | compatible | `RootExecution` risk → **AwaitingAcknowledgement** |
| 05 | `05-ephemeral.sh` | `pantoken-ephemeral` | `pantoken` | compatible | `EphemeralData` risk (writable layer) → **AwaitingAcknowledgement** |
| 06 | `06-docker-socket.sh` | `pantoken-docker-socket` | `pantoken` | compatible | `DockerSocket` risk → **AwaitingAcknowledgement** |
| 07 | `07-stopped.sh` | `pantoken-stopped` | — | — | `ContainerUnavailable("exited")` |
| 08 | `08-musl-unsupported.sh` | `pantoken-musl` | `pantoken` | compatible | Preflight passes → probe detects musl → `UnsupportedTarget` → **Failed** |
| 09 | `09-missing-tools.sh` | `pantoken-no-tools` | `pantoken` | compatible | Probe reports `tools.tar=false` etc → provisioning failure |
| 10 | `10-read-only-mount.sh` | `pantoken-readonly` | `pantoken` | compatible | Read-only mount: `test -w` fails at identity probe → preflight fails |
| 11 | `11-unparseable-polytoken.sh` | `pantoken-unparseable` | `pantoken` | unparseable `01.2.3` | `PolytokenCompat::Unparseable` → **Failed** |
| 12 | `12-named-volume.sh` | `pantoken-named-volume` | `pantoken` | compatible | `PersistentVolume` (safe, no risk) → **Ready** |
| 13 | `13-tmpfs.sh` | `pantoken-tmpfs` | `pantoken` | compatible | `EphemeralTmpfs` → `EphemeralData` risk → **AwaitingAcknowledgement** |

> **Container name matters:** pantoken resolves by **exact equality**, not
> substring. The name you enter in the profile must match exactly. Pointing at
> `pantoken-heal` (a substring of `pantoken-healthy`) yields
> `ContainerNotFound`.

## Manual Verification Commands

After running `setup-all.sh`, you can verify each container's state directly:

```bash
# AC.3 — healthy container passes the probe
docker exec pantoken-healthy polytoken --version     # → polytoken 0.5.0-unstable.9
docker exec pantoken-healthy uname -m                # → x86_64
docker exec pantoken-healthy sh -c 'ldd --version 2>&1 | head -1'  # mentions glibc

# AC.4 — musl container detected as unsupported
docker exec pantoken-musl sh -c 'ldd --version 2>&1 | head -1'     # mentions musl

# AC.5 — stopped container is in exited state
docker inspect -f '{{.State.Status}}' pantoken-stopped              # → exited

# AC.6 — read-only mount
docker inspect pantoken-readonly | grep -A2 '"Destination": "/var/lib/pantoken"'
#   (the mount has "RW": false)

# AC.7 — docker socket mounted
docker inspect pantoken-docker-socket | grep docker.sock

# AC.8 — root container UID is 0
docker exec -u root pantoken-root id -u             # → 0

# AC.9 — ephemeral container has no covering mount
docker inspect pantoken-ephemeral | grep -c '"Destination": "/var/lib/pantoken"'
#   → 0 (no mount covers the Pantoken root)
```

## How polytoken Is Installed

The compatible fixtures (01, 04, 05, 06, 08, 09, 12, 13) install the **real**
polytoken `0.5.0-unstable.9` binary from the official release artifact CDN. The
URL pattern matches the production code in
`desktop/src/provisioning/polytoken_install.rs:resolve_artifact_urls()`:

- **Archive:** `https://dl.polytoken.dev/unstable/0.5.0-unstable.9/linux-amd64/polytoken.tar.gz`
- **Checksums:** `https://dl.polytoken.dev/unstable/0.5.0-unstable.9/SHA256SUMS.linux`

The `install-polytoken.sh` helper downloads the archive + checksums, verifies
SHA256, copies the archive into the container, and extracts it to
`/usr/local/bin/polytoken`.

The **too-old** fixture (03) and **unparseable** fixture (11) use a stub script
instead of a real binary — the probe only runs `polytoken --version` and parses
the version string; it never invokes the daemon.

## States NOT Covered (and Why)

Some states the feature code can produce are not fixture-testable:

### AmbiguousContainer (two containers, same exact name)

Docker enforces container name uniqueness at creation — you cannot create two
containers with the same name. Covered by unit test
`docker_exact_name_resolution_and_substring_names_do_not_match` in
`docker_target.rs`.

### ContainerNotFound (exact name doesn't match any container)

Test manually: point pantoken at a non-existent container name (e.g.
`pantoken-typo`). Also tests the substring-rejection path: pointing at
`pantoken-heal` (substring of `pantoken-healthy`) yields `ContainerNotFound`,
since pantoken resolves by exact equality. Covered by unit tests in
`docker_target.rs`.

### CheckingDockerAccess failure (docker CLI missing / permission denied)

This is an SSH-host-level state, not a container state. Test manually: SSH to
the server as a user **not** in the `docker` group and attempt to connect to
any fixture container.

### CheckingUserPermissions failure (user can't write to pantoken_root)

Test manually: create a profile pointing at the `pantoken-healthy` container
but enter a user that doesn't exist in the container, or a Pantoken root the
user can't write to. Covered by the preflight identity probe in
`remote_executor.rs:240-256`.

### MalformedList / MalformedInspect / UnsafePath

Malformed-output or bad-input edge cases not producible by a real Docker daemon.
Covered by unit tests in `docker_target.rs`.

## Architecture

```
scripts/docker-fixtures/
├── lib/
│   ├── common.sh                # shared constants + helpers
│   ├── setup-container-base.sh  # in-container apt/apk + user setup
│   └── install-polytoken.sh     # real binary + stub install helpers
├── 01-healthy.sh                # happy path → Ready
├── 02-missing-polytoken.sh      # Missing compat state
├── 03-old-polytoken.sh          # TooOld compat state
├── 04-root-user.sh              # RootExecution risk
├── 05-ephemeral.sh              # EphemeralData risk (writable layer)
├── 06-docker-socket.sh          # DockerSocket risk
├── 07-stopped.sh                # ContainerUnavailable
├── 08-musl-unsupported.sh       # UnsupportedTarget
├── 09-missing-tools.sh          # probe reports missing tools
├── 10-read-only-mount.sh        # ReadOnlyMount hard error
├── 11-unparseable-polytoken.sh  # Unparseable compat state
├── 12-named-volume.sh           # PersistentVolume (safe)
├── 13-tmpfs.sh                  # EphemeralTmpfs risk
├── setup-all.sh                # runs all 13 + summary table
├── teardown-all.sh             # removes everything
└── README.md                    # this file
```
