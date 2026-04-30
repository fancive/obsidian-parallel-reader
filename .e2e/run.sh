#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ARTIFACT=".e2e/artifact.json"
RESULTS_DIR=".e2e/results"
BUILD_LOG="$RESULTS_DIR/build.log"
TESTS_LOG="$RESULTS_DIR/tests-default.log"
TESTS_RESULT="$RESULTS_DIR/tests-default.json"
PRODUCT_SHELL_LOG="$RESULTS_DIR/product-shell.log"
PRODUCT_SHELL_RESULT="$RESULTS_DIR/product-shell.json"
LIVE_LOG="$RESULTS_DIR/live.log"
LIVE_RESULT="$RESULTS_DIR/live.json"

rm -f "$ARTIFACT"
rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

START_MS="$(now_ms)"

set +e
BUILD_START_MS="$(now_ms)"
{ npm run build && npm run typecheck; } >"$BUILD_LOG" 2>&1
BUILD_EXIT=$?
BUILD_END_MS="$(now_ms)"
BUILD_DURATION_MS=$((BUILD_END_MS - BUILD_START_MS))

if [ "$BUILD_EXIT" -eq 0 ]; then
  TEST_RESULTS_JSON="$TESTS_RESULT" node scripts/run-tests.mjs >"$TESTS_LOG" 2>&1
  TESTS_EXIT=$?
else
  TESTS_EXIT=1
  echo "skipped: build/typecheck failed" >"$TESTS_LOG"
fi

if [ "$BUILD_EXIT" -eq 0 ]; then
  PRODUCT_SHELL_RESULT="$PRODUCT_SHELL_RESULT" node .e2e/cases/product-shell/run.mjs >"$PRODUCT_SHELL_LOG" 2>&1
  PRODUCT_SHELL_EXIT=$?
else
  PRODUCT_SHELL_EXIT=1
  echo "skipped: build/typecheck failed" >"$PRODUCT_SHELL_LOG"
fi

if [ "${TEST_LIVE:-0}" = "1" ]; then
  LIVE_E2E_RESULT="$LIVE_RESULT" node .e2e/cases/live/run.mjs >"$LIVE_LOG" 2>&1
  LIVE_EXIT=$?
else
  LIVE_EXIT=0
fi
set -e

END_MS="$(now_ms)"
export START_MS END_MS
export BUILD_LOG BUILD_EXIT BUILD_DURATION_MS
export TESTS_LOG TESTS_RESULT
export PRODUCT_SHELL_LOG PRODUCT_SHELL_EXIT
export LIVE_LOG LIVE_EXIT

node .e2e/scripts/write-artifact.mjs

if [ "$BUILD_EXIT" -ne 0 ] || [ "$TESTS_EXIT" -ne 0 ] || [ "$PRODUCT_SHELL_EXIT" -ne 0 ] || [ "$LIVE_EXIT" -ne 0 ]; then
  exit 1
fi
