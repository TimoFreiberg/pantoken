# Remote cache setup guide

This guide walks through deploying a shared `bazel-remote` REAPI cache on the
Mac mini and configuring the MacBook and CI to use it. Once deployed, all local
and CI Buck2 builds share compiled artifacts via the cache, so a crate built on
the MacBook can be reused on the Mac mini or in CI without recompilation.

## Architecture

```
  MacBook (buck2 client)          Mac mini (bazel-remote server)
  ┌─────────────────┐             ┌──────────────────────────┐
  │ .buckconfig     │   Tailscale │ bazel-remote             │
  │ .remote-cache   │ ─────────→ │ :9092 (gRPC)             │
  │                 │   WireGuard │ :8080 (HTTP status)      │
  └─────────────────┘             │ /usr/local/var/bazel-remote (50 GB) │
                                  └──────────────────────────┘
  CI (GitHub Actions)                    ↑
  ┌─────────────────┐                    │
  │ Tailscale +     │ ───────────────────┘
  │ .buckconfig     │   (trusted runs only)
  │ .remote-cache   │
  └─────────────────┘
```

The cache is **opt-in**: if `.buckconfig.remote-cache` is absent, Buck2 uses
local-only execution. Fork PRs never get cache access — the Tailscale and cache
config steps are gated on `github.event.pull_request.head.repo.full_name ==
github.repository`.

## Prerequisites

- **Tailscale** installed and running on both the Mac mini and MacBook.
  Verify with `tailscale status` on each machine.
- A pantoken repo checkout on the Mac mini (for running the preflight script).
- `bazel-remote` v2.6.2 binary on the Mac mini.
- GitHub CLI (`gh`) for setting repository secrets (for CI cache access).

## Step 1: Install bazel-remote on the Mac mini

```bash
# Download v2.6.2 for darwin-arm64
curl -L -o /usr/local/bin/bazel-remote \
  https://github.com/buchgr/bazel-remote/releases/download/v2.6.2/bazel-remote-2.6.2-darwin-arm64
chmod +x /usr/local/bin/bazel-remote

# bazel-remote has no --version flag; verify identity and integrity instead.
bazel-remote --help | head -1           # should print "bazel-remote - A remote build cache..."
shasum -a 256 /usr/local/bin/bazel-remote  # compare against the SHA on the release page
```

## Step 2: Run the preflight + setup script

From the pantoken repo checkout on the Mac mini:

```bash
# Read-only checks (verifies Tailscale, disk space, ports)
bash deploy/bazel-remote-preflight.sh

# Install LaunchDaemon (creates 50 GiB cache, renders plist, starts daemon)
bash deploy/bazel-remote-preflight.sh --setup
```

This creates `/usr/local/var/bazel-remote` (50 GiB cache), renders the plist
from `deploy/com.bazel-remote.plist`, installs it as a system LaunchDaemon at
`/Library/LaunchDaemons/com.bazel-remote.plist`, and bootstraps it via
`sudo launchctl bootstrap system`.

The cache directory default is 50 GiB. Override with `--max_size <GiB>`.

## Step 3: Verify the cache is running

```bash
# Check the launchd service
launchctl print system/com.bazel-remote

# Check the HTTP status endpoint
curl -fsS http://localhost:8080/status
```

The `/status` endpoint returns JSON with cache size, entry count, uptime, and a
`GitTags` field (e.g. `"v2.6.2"`) that confirms the running version.

## Step 4: Verify Tailscale reachability from the MacBook

Find the Mac mini's tailnet hostname:

```bash
# On the Mac mini:
tailscale status | head -1
# Output: e.g. "macmini.tailnet-name.ts.net"
```

From the MacBook, verify the cache is reachable over Tailscale:

```bash
curl -fsS http://<mac-mini-tailnet-host>:8080/status
```

If this fails, check:
- Tailscale is running on both machines (`tailscale status`).
- The Mac mini's firewall allows inbound on port 9092 (gRPC) and 8080 (HTTP).
  The LaunchDaemon binds `0.0.0.0` for both ports.
- The Mac mini's Tailscale ACL permits the MacBook's tailnet IP.

## Step 5: Configure the MacBook's buck2 client

```bash
cp .buckconfig.remote-cache.example .buckconfig.remote-cache
```

Edit `.buckconfig.remote-cache` and replace `<tailnet-host>` with the Mac
mini's tailnet hostname:

```ini
[buck2_re_client]
engine_address = macmini.tailnet-name.ts.net:9092
action_cache_address = macmini.tailnet-name.ts.net:9092
cas_address = macmini.tailnet-name.ts.net:9092
tls = false
instance_name = buck2

[build]
execution_platforms = toolchains//platforms:remote_cache
```

> `.buckconfig.remote-cache` is gitignored — the Tailscale address is private.

Verify cache hits by building with the cached recipes:

```bash
# First build populates the cache (all local)
just buck2-build-cached

# Clean then rebuild — should show cache hits
buck2 clean
just buck2-build-cached
# Console summary: Commands: N (cached: X, remote: Y, local: Z)
# X and Y should be non-zero on the second run
```

## Step 6: Set GitHub secrets for CI

CI connects to the cache via Tailscale. Set these repository secrets:

```bash
# Generate a reusable Tailscale auth key on the Mac mini:
tailscale authkey --reusable

# Set the GitHub secrets:
gh secret set TS_AUTH_KEY < ~/.tailscale/auth-key
gh secret set BUCK2_CACHE_HOST --body "macmini.tailnet-name.ts.net"
```

- `TS_AUTH_KEY` — a reusable Tailscale auth key. CI uses it to join the tailnet
  for the duration of the job, then disconnects.
- `BUCK2_CACHE_HOST` — the Mac mini's tailnet hostname (no port; the CI
  workflow appends `:9092` for the gRPC address).

## Step 7: Verify CI remote cache

Trigger a workflow run (push to a branch or open a PR from the same repo).
Check the `buck2` job logs for:

```
Commands: N (cached: X, remote: Y, local: Z)
```

On the first run after a change, most commands will be `local` (cache miss).
On subsequent runs of unchanged code, `cached` or `remote` should be non-zero.

For trusted PRs (same-repo), the CI workflow:
1. Connects to Tailscale via `tailscale/github-action@v4`.
2. Generates `.buckconfig.remote-cache` from the `BUCK2_CACHE_HOST` secret.
3. Runs `just buck2-*-cached` recipes.

For fork PRs, no Tailscale connection or cache config is generated — Buck2 uses
local-only execution automatically.

## Troubleshooting

### Cache unreachable from the MacBook

1. Check Tailscale: `tailscale status` on both machines — both must be `active`.
2. Check the daemon: `launchctl print system/com.bazel-remote` on the Mac mini.
3. Check the HTTP endpoint: `curl -fsS http://localhost:8080/status` on the Mac mini.
4. Check the firewall: the Mac mini must allow inbound on ports 8080 and 9092.
5. Check Tailscale ACLs: the MacBook's tailnet IP must be permitted to reach
   the Mac mini.

### Cache full

`bazel-remote` uses LRU (least-recently-used) eviction automatically. The
cache will not exceed `--max_size` GiB. Verify current usage via:

```bash
curl -fsS http://localhost:8080/status | python3 -m json.tool
```

If the cache is consistently full, increase `--max_size` and restart the
daemon. The default 50 GiB is sufficient for the server-rs crate set.

### Version mismatch

Buck2 version is pinned in `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`.
If the CI buck2 binary doesn't match the local one, cache entries may not be
compatible. Ensure both use the same pinned revision:

```bash
buck2 --version  # local
# CI installs from scripts/ci/install-buck2-ci.sh which uses the same pin
```

### Forcing local-only execution

To bypass the remote cache (for debugging or benchmarking):

```bash
# Remove or rename the cache config
mv .buckconfig.remote-cache .buckconfig.remote-cache.disabled

# Or use the non-cached recipes
just buck2-build
just buck2-test
```

### CI not using cache

Check that:
1. The `TS_AUTH_KEY` and `BUCK2_CACHE_HOST` secrets are set (`gh secret list`).
2. The PR is from the same repository (fork PRs don't get cache access).
3. The `buck2_no_cache` workflow_dispatch input is not set to `true`.

### Rollback

```bash
# Stop and remove the LaunchDaemon
sudo launchctl bootout system/com.bazel-remote
rm /Library/LaunchDaemons/com.bazel-remote.plist

# Optionally remove the cache data
rm -rf /usr/local/var/bazel-remote
```

## Local cache fallback (not currently deployed)

Buck2 has no built-in local disk action cache. Unlike Bazel's `--disk_cache`,
there is no way to persist action cache results across daemon restarts. The
Buck1 `[cache]` section is not supported (buck2 issue #459, closed wontfix), and
the daemon's in-memory action cache is volatile — `buck2 kill` triggers full
rebuilds (issue #547). The `sqlite_materializer_state` option only tracks which
files are already materialized on disk in `buck-out`; it does not persist action
cache results, so a daemon restart still re-executes all actions.

This means when the remote bazel-remote on the Mac mini is unreachable, Buck2
re-executes every action from scratch — no local fallback exists. The workaround
is a **local bazel-remote sidecar with a proxy backend**: a second bazel-remote
instance on the MacBook that caches to local disk and proxies to the remote
host, providing both persistence across daemon restarts and graceful degradation
when the remote is down.

### Architecture

```
  MacBook (buck2 client)         Local sidecar (bazel-remote)       Mac mini (bazel-remote)
  ┌─────────────────┐           ┌────────────────────────┐        ┌──────────────────────────┐
  │ .buckconfig     │  gRPC     │ bazel-remote            │ gRPC   │ bazel-remote             │
  │ .remote-cache   │ ────────→ │ :9092 (local disk cache)│ ─────→ │ :9092 (REAPI store)       │
  │ 127.0.0.1:9092  │           │ ~/.local/share/         │ proxy  │ /usr/local/var/bazel-remote│
  │                 │           │ bazel-remote-local      │        └──────────────────────────┘
  └─────────────────┘           └────────────────────────┘
                                 Read-through: miss → fetch from remote → cache locally
                                 Write-through: store locally → async upload to remote
                                 Remote down: serve from local disk (uploads dropped)
```

bazel-remote supports `--grpc_proxy.url` (or `--http_proxy.url`) to proxy to a
remote backend. The behavior is:

- **Read-through**: local disk miss → fetch from the remote proxy → cache locally
  → return the result.
- **Write-through**: store locally → asynchronously upload to the remote
  (`--num_uploaders` controls the upload pool).
- **Graceful degradation**: if the remote is unreachable, serve from local disk;
  uploads are silently dropped when the upload queue is full
  (`--max_queued_uploads`).

### Example configuration (reference only)

```bash
bazel-remote \
  --dir ~/.local/share/bazel-remote-local \
  --max_size 100 \
  --grpc_address 127.0.0.1:9092 \
  --http_address 127.0.0.1:8080 \
  --grpc_proxy.url grpc://<tailnet-host>:9092 \
  --num_uploaders 50
```

Then `.buckconfig.remote-cache` points to `127.0.0.1:9092` (the local sidecar)
instead of the remote host directly:

```ini
[buck2_re_client]
engine_address = 127.0.0.1:9092
action_cache_address = 127.0.0.1:9092
cas_address = 127.0.0.1:9092
tls = false
instance_name = buck2

[build]
execution_platforms = toolchains//platforms:remote_cache
```

### Current assessment

This setup is **not currently deployed** and is not needed at this time. The
Mac mini is reliably up, and the developer works with hosted inference (always
online), so the remote cache is consistently reachable. This section is
documented for future reference — if the remote cache becomes less reliable or
offline work is needed, the local sidecar pattern above provides persistence and
graceful degradation with minimal configuration.
