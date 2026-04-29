#!/usr/bin/env bash
set -euo pipefail

[ "${STOP_HOOK_ACTIVE:-}" = "true" ] && exit 0
export STOP_HOOK_ACTIVE=true

OUT="$(mktemp)"
set +e
bash .e2e/gate.sh --json >"$OUT"
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  cat "$OUT" >&2
  rm -f "$OUT"
  echo '{"decision":"block","reason":"e2e contract gate failed"}'
  exit 2
fi

cat "$OUT" >&2
rm -f "$OUT"
exit 0
