#!/usr/bin/env bash
# Build the client and run the pilot server in prod (single process). Reads config
# from the environment — set at least PILOT_TOKEN. See deploy/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile || bun install
bun run build                      # -> client/dist (served by the server)

: "${PILOT_HOST:=127.0.0.1}"       # loopback; tailscale serve proxies in
: "${PILOT_PORT:=8787}"
export PILOT_HOST PILOT_PORT

if [[ -z "${PILOT_TOKEN:-}" ]]; then
  echo "WARNING: PILOT_TOKEN is unset — the server will accept any client." >&2
fi

exec bun run --cwd server start
