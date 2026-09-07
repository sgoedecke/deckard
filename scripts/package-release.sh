#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec /usr/sbin/taskpolicy -b node "$ROOT/scripts/package-release.mjs" "$@"
