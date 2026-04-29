#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! python -c 'import e2e_contract_validator' >/dev/null 2>&1; then
  if [ -n "${E2E_CONTRACT_VALIDATOR_PYTHONPATH:-}" ]; then
    export PYTHONPATH="${E2E_CONTRACT_VALIDATOR_PYTHONPATH}${PYTHONPATH:+:$PYTHONPATH}"
  else
    echo "e2e_contract_validator is not importable; set E2E_CONTRACT_VALIDATOR_PYTHONPATH or install it" >&2
    exit 3
  fi
fi

python -m e2e_contract_validator gate --project . --json "$@"
