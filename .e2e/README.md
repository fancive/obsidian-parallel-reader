# E2E Contract

This repository uses `.e2e/run.sh` as the project-local runtime entry point.
The runner clears stale artifacts, executes the real `npm test` gate, records
`.e2e/results/npm-test.log`, and writes `.e2e/artifact.json` in CTRF format.

Run the host-neutral gate with:

```bash
bash .e2e/gate.sh --json
```

If `e2e_contract_validator` is not installed, set
`E2E_CONTRACT_VALIDATOR_PYTHONPATH` to the `claude-code-addons/scripts`
directory before running the gate.

Generated artifacts under `.e2e/artifact.json` and `.e2e/results/` are runtime
evidence and are intentionally ignored by git.
