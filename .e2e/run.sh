#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ARTIFACT=".e2e/artifact.json"
RESULTS_DIR=".e2e/results"
LOG="$RESULTS_DIR/npm-test.log"
START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"

rm -f "$ARTIFACT"
mkdir -p "$RESULTS_DIR"

set +e
npm test >"$LOG" 2>&1
RUN_EXIT=$?
set -e

END_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
LOG_SHA="$(shasum -a 256 "$LOG" | awk '{print $1}')"
export RUN_EXIT START_MS END_MS LOG LOG_SHA

node .e2e/scripts/write-artifact.mjs
exit "$RUN_EXIT"
