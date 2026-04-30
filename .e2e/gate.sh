#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node .e2e/scripts/gate.mjs --project . "$@"
