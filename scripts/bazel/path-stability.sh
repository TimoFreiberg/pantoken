#!/usr/bin/env bash
set -euo pipefail
exec python3 "$TEST_SRCDIR/$TEST_WORKSPACE/scripts/bazel/path-stability.py"
